-- Authenticated operator requests only; never a spending/fee/chain approval.
CREATE SCHEMA darkpool_payout_review;
REVOKE ALL ON SCHEMA darkpool_payout_review FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_payout_review REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE darkpool_private.payout_review_scopes (
 market_id text PRIMARY KEY REFERENCES darkpool_private.payout_planner_scopes,
 operator_login name NOT NULL, execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 proposed_confirmations integer NOT NULL CHECK(proposed_confirmations=3),
 spending_enabled boolean NOT NULL CHECK(NOT spending_enabled),
 registered_by name NOT NULL, registered_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.payout_operator_requests (
 review_id text PRIMARY KEY CHECK(review_id='payout-review:'||intent_id),
 intent_id text NOT NULL UNIQUE REFERENCES darkpool_private.payout_intents,
 market_id text NOT NULL REFERENCES darkpool_private.payout_review_scopes,
 request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{1,128}$'),
 packet jsonb NOT NULL,
 state text NOT NULL CHECK(state='BLOCKED_PREREQUISITES'),
 spending_authorized boolean NOT NULL CHECK(NOT spending_authorized),
 execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 requested_by name NOT NULL, requested_at timestamptz NOT NULL,
 UNIQUE(market_id,request_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payout_review_scopes','payout_operator_requests'] LOOP
  EXECUTE format('REVOKE ALL ON darkpool_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER payout_review_immutable BEFORE UPDATE OR DELETE ON darkpool_private.%I FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER payout_review_no_truncate BEFORE TRUNCATE ON darkpool_private.%I FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION darkpool_payout_review.packet(iid text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.payout_review_scopes; i darkpool_private.payout_intents;
 a darkpool_private.oracle_authorities; r darkpool_private.resolution_results; rid text; c darkpool_private.claims;
BEGIN
 PERFORM darkpool_lock.authorize();
 IF current_setting('transaction_isolation')<>'serializable' OR current_setting('synchronous_commit')<>'on'
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND
  (pg_has_role(session_user,nspowner,'MEMBER') OR has_schema_privilege(session_user,oid,'CREATE'))) THEN
  RAISE EXCEPTION USING ERRCODE='P1601',MESSAGE='restricted serializable review required'; END IF;
 SELECT * INTO i FROM darkpool_private.payout_intents WHERE intent_id=iid;
 SELECT * INTO s FROM darkpool_private.payout_review_scopes WHERE market_id=i.market_id AND operator_login=session_user;
 SELECT * INTO a FROM darkpool_private.oracle_authorities WHERE market_id=i.market_id;
 IF s.market_id IS NULL OR a.market_id IS NULL OR s.execution_class IS DISTINCT FROM a.execution_class
 OR i.execution_class IS DISTINCT FROM s.execution_class
 OR (s.execution_class='SYNTHETIC_TEST' AND NOT darkpool_resolution.test_scope(a)) THEN
  RAISE EXCEPTION USING ERRCODE='P1601',MESSAGE='authenticated operator review unavailable'; END IF;
 PERFORM darkpool_resolution.lock_context(i.market_id);
 PERFORM 1 FROM darkpool_private.payout_intents WHERE intent_id=iid FOR UPDATE;
 rid:=darkpool_resolution.publication(i.market_id,a);
 SELECT * INTO r FROM darkpool_private.resolution_results WHERE market_id=i.market_id;
 SELECT * INTO c FROM darkpool_private.claims WHERE id=i.claim_id FOR UPDATE;
 IF r.market_id IS NULL OR r.execution_class IS DISTINCT FROM s.execution_class OR r.publication_receipt_id IS DISTINCT FROM rid
 OR r.resolution_id IS DISTINCT FROM i.resolution_id OR r.ledger_root IS DISTINCT FROM i.ledger_root
 OR i.record->>'publication_receipt_ref' IS DISTINCT FROM rid
 OR c.entitlement_zat IS DISTINCT FROM i.amount_zat OR c.ticket_id IS DISTINCT FROM i.ticket_id
 OR c.entitlement_id IS DISTINCT FROM i.entitlement_id OR c.market_id IS DISTINCT FROM i.market_id
 OR c.payout_address IS DISTINCT FROM i.record->>'payout_ua' OR c.state IS DISTINCT FROM 'TX_PREPARING'
 OR c.tx_ref IS NOT NULL OR c.settlement_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.markets WHERE id=i.market_id AND status IN ('PAYING','REFUNDING') AND network='testnet')
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.claim_reservations p WHERE p.claim_id=i.claim_id AND p.state='PREPARED'
  AND p.execution_class=s.execution_class AND p.ledger_root=i.ledger_root AND p.resolution_id=i.resolution_id
  AND p.record#>>'{binding,market_revision}'=(SELECT revision::text FROM darkpool_private.admin_revisions WHERE market_id=i.market_id))
 OR EXISTS(SELECT 1 FROM darkpool_private.payout_reconciliation_reports WHERE intent_id=iid) THEN
  RAISE EXCEPTION USING ERRCODE='P1602',MESSAGE='eligible unquarantined payout intent required'; END IF;
 RETURN jsonb_build_object('kind','PRIVATE_OPERATOR_REVIEW_PACKET','version',1,'review_id','payout-review:'||iid,'intent',i.record,
  'policy',jsonb_build_object('profile','phase16-restricted-testnet-review-v1','network','testnet','proposed_confirmations',3,
   'single_intent_batch',true,'signing_enabled',false,'submission_enabled',false,'replacement_enabled',false),
  'declared_market_payout_confirmations',(SELECT payout_confirmations FROM darkpool_private.markets WHERE id=i.market_id));
END $$;
CREATE FUNCTION darkpool_payout_review.preview(iid text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
 AS $$ SELECT darkpool_payout_review.packet(iid) $$;

CREATE FUNCTION darkpool_payout_review.request(iid text,k text,expected jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; prior darkpool_private.payout_operator_requests;
BEGIN
 p:=darkpool_payout_review.packet(iid);
 IF NOT coalesce(k ~ '^[A-Za-z0-9_-]{1,128}$',false) OR expected IS DISTINCT FROM p THEN
  RAISE EXCEPTION USING ERRCODE='P1603',MESSAGE='exact operator-reviewed packet required'; END IF;
 SELECT * INTO prior FROM darkpool_private.payout_operator_requests WHERE intent_id=iid;
 IF prior.review_id IS NOT NULL THEN
  IF prior.request_key IS DISTINCT FROM k OR prior.packet IS DISTINCT FROM p OR prior.requested_by IS DISTINCT FROM session_user THEN
   RAISE EXCEPTION USING ERRCODE='P1603',MESSAGE='immutable operator request conflict'; END IF;
 ELSE
  INSERT INTO darkpool_private.payout_operator_requests VALUES(p->>'review_id',iid,p#>>'{intent,market_id}',k,p,
   'BLOCKED_PREREQUISITES',false,p#>>'{intent,execution_class}',session_user,clock_timestamp());
 END IF;
 RETURN jsonb_build_object('result','PAYOUT_AUTHORIZATION_REQUEST','review_id',p->>'review_id','state','BLOCKED_PREREQUISITES',
  'execution_class',p#>>'{intent,execution_class}','spending_authorized',false,'signing_enabled',false,'submission_enabled',false);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_payout_review FROM PUBLIC;

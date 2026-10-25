-- Plan-only capability. No signer, transaction bytes, submission or finality.
CREATE SCHEMA darkpool_payout;
REVOKE ALL ON SCHEMA darkpool_payout FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_payout REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE darkpool_private.payout_planner_scopes (
 market_id text PRIMARY KEY REFERENCES darkpool_private.oracle_authorities,
 planner_login name NOT NULL, reconciler_login name NOT NULL CHECK(planner_login<>reconciler_login),
 execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 external_funding_ref text NOT NULL CHECK(external_funding_ref ~ '^[A-Za-z0-9_-]{1,128}$'),
 planning_fee_budget_zat darkpool_private.zatoshi NOT NULL CHECK(planning_fee_budget_zat<=2100000000000000),
 per_intent_fee_ceiling_zat darkpool_private.zatoshi NOT NULL CHECK(per_intent_fee_ceiling_zat>0 AND per_intent_fee_ceiling_zat<=2100000000000000),
 funding_verified boolean NOT NULL DEFAULT false CHECK(NOT funding_verified),
 registered_by name NOT NULL, registered_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.payout_intents (
 intent_id text PRIMARY KEY CHECK(intent_id='payout-intent:'||claim_id),
 claim_id text NOT NULL UNIQUE REFERENCES darkpool_private.claim_reservations,
 market_id text NOT NULL REFERENCES darkpool_private.payout_planner_scopes,
 ticket_id text NOT NULL, entitlement_id text NOT NULL UNIQUE,
 resolution_id text NOT NULL, ledger_root bytea NOT NULL CHECK(octet_length(ledger_root)=32),
 amount_zat darkpool_private.zatoshi NOT NULL CHECK(amount_zat>0),
 fee_ceiling_zat darkpool_private.zatoshi NOT NULL CHECK(fee_ceiling_zat>0),
 execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 record jsonb NOT NULL CHECK(record->'spending_authorized' IS NOT DISTINCT FROM 'false'::jsonb AND record->'submission_enabled' IS NOT DISTINCT FROM 'false'::jsonb),
 created_by name NOT NULL, created_at timestamptz NOT NULL,
 FOREIGN KEY(market_id,claim_id) REFERENCES darkpool_private.claims(market_id,id),
 FOREIGN KEY(market_id,ticket_id,entitlement_id) REFERENCES darkpool_private.entitlements(market_id,ticket_id,id),
 FOREIGN KEY(market_id,resolution_id) REFERENCES darkpool_private.resolutions(market_id,id)
);
-- Unverified reports are quarantine material, never proof of a signed/stored TX.
CREATE TABLE darkpool_private.payout_reported_transactions (
 intent_id text PRIMARY KEY REFERENCES darkpool_private.payout_intents,
 txid bytea NOT NULL UNIQUE CHECK(octet_length(txid)=32)
);
CREATE TABLE darkpool_private.payout_reconciliation_reports (
 intent_id text NOT NULL REFERENCES darkpool_private.payout_intents,
 report_key text NOT NULL CHECK(report_key ~ '^[A-Za-z0-9_-]{1,128}$'),
 receipt_id uuid NOT NULL UNIQUE, report jsonb NOT NULL,
 recorded_by name NOT NULL, recorded_at timestamptz NOT NULL,
 PRIMARY KEY(intent_id,report_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payout_planner_scopes','payout_intents','payout_reported_transactions','payout_reconciliation_reports'] LOOP
  EXECUTE format('REVOKE ALL ON darkpool_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER payout_immutable BEFORE UPDATE OR DELETE ON darkpool_private.%I FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER payout_no_truncate BEFORE TRUNCATE ON darkpool_private.%I FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION darkpool_payout.authorize(mid text,reconcile boolean) RETURNS darkpool_private.payout_planner_scopes
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.payout_planner_scopes; a darkpool_private.oracle_authorities;
BEGIN
 PERFORM darkpool_lock.authorize();
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND
  (pg_has_role(session_user,nspowner,'MEMBER') OR has_schema_privilege(session_user,oid,'CREATE'))) THEN
  RAISE EXCEPTION USING ERRCODE='P1501',MESSAGE='restricted payout service required'; END IF;
 SELECT * INTO s FROM darkpool_private.payout_planner_scopes WHERE market_id=mid AND
  CASE WHEN reconcile THEN reconciler_login=session_user ELSE planner_login=session_user END;
 SELECT * INTO a FROM darkpool_private.oracle_authorities WHERE market_id=mid;
 IF s.market_id IS NULL OR a.market_id IS NULL OR s.execution_class IS DISTINCT FROM a.execution_class
 OR (s.execution_class='SYNTHETIC_TEST' AND NOT darkpool_resolution.test_scope(a)) THEN
  RAISE EXCEPTION USING ERRCODE='P1501',MESSAGE='payout planning capability unavailable'; END IF;
 RETURN s;
END $$;

CREATE FUNCTION darkpool_payout.context(cid text) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c darkpool_private.claims; p darkpool_private.claim_reservations; e darkpool_private.entitlements;
 s darkpool_private.payout_planner_scopes; a darkpool_private.oracle_authorities; r darkpool_private.resolution_results;
 approval darkpool_private.oracle_approvals; b jsonb; rid text; expected jsonb; prior darkpool_private.payout_intents;
 mid text; remaining numeric; mode text;
BEGIN
 SELECT market_id INTO mid FROM darkpool_private.claim_reservations WHERE claim_id=cid;
 s:=darkpool_payout.authorize(mid,false);
 PERFORM darkpool_resolution.lock_context(mid);
 SELECT * INTO s FROM darkpool_private.payout_planner_scopes WHERE market_id=mid FOR UPDATE;
 SELECT * INTO a FROM darkpool_private.oracle_authorities WHERE market_id=mid;
 rid:=darkpool_resolution.publication(mid,a);
 SELECT * INTO c FROM darkpool_private.claims WHERE id=cid FOR UPDATE;
 SELECT * INTO p FROM darkpool_private.claim_reservations WHERE claim_id=cid FOR UPDATE;
 SELECT * INTO e FROM darkpool_private.entitlements WHERE id=p.entitlement_id FOR UPDATE;
 SELECT * INTO r FROM darkpool_private.resolution_results WHERE market_id=mid;
 SELECT * INTO approval FROM darkpool_private.oracle_approvals WHERE request_key=r.request_key;
 b:=p.record->'binding'; mode:=r.preparation#>>'{calculation,mode}';
 IF c.id IS NULL OR p.claim_id IS NULL OR e.id IS NULL OR r.market_id IS NULL OR approval.market_id IS NULL
 OR p.state<>'PREPARED' OR c.state<>'TX_PREPARING' OR p.record->>'state' IS DISTINCT FROM 'TX_PREPARING'
 OR p.record->'tx_ref' IS DISTINCT FROM 'null'::jsonb OR p.record->'reconciliation_required' IS DISTINCT FROM 'false'::jsonb
 OR c.tx_ref IS NOT NULL OR c.settlement_id IS NOT NULL OR p.submission_ref IS NOT NULL OR p.reconciliation_ref IS NOT NULL
 OR r.execution_class IS DISTINCT FROM s.execution_class OR p.execution_class IS DISTINCT FROM s.execution_class
 OR r.publication_receipt_id IS DISTINCT FROM rid OR p.resolution_id IS DISTINCT FROM r.resolution_id
 OR p.ledger_root IS DISTINCT FROM r.ledger_root OR r.ledger_root IS DISTINCT FROM
  (SELECT merkle_root FROM darkpool_private.ledger_commitments WHERE market_id=mid)
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.markets WHERE id=mid AND status IN ('PAYING','REFUNDING') AND network='testnet')
 OR e.kind<>'ACCEPTED_STAKE' OR e.amount_zat<=0 OR e.amount_zat IS DISTINCT FROM c.entitlement_zat
 OR e.amount_zat+s.per_intent_fee_ceiling_zat>2100000000000000
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.resolution_entitlements re WHERE re.market_id=mid AND re.ticket_id=p.ticket_id
  AND re.entitlement_id=e.id AND re.winning_payout_zat+re.refund_zat=e.amount_zat)
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_records WHERE market_id=mid AND ticket_id=p.ticket_id)
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.tickets WHERE market_id=mid AND id=p.ticket_id AND claim_commitment=p.credential_commitment)
 OR b IS DISTINCT FROM jsonb_build_object('market_id',mid,'market_state',(SELECT status FROM darkpool_private.markets WHERE id=mid),
  'market_revision',(SELECT revision::text FROM darkpool_private.admin_revisions WHERE market_id=mid),'ledger_root',encode(r.ledger_root,'hex'),
  'resolution_ref',r.resolution_id,'outcome',approval.resolution->>'outcome','mode',mode,'publication_receipt_ref',rid,
  'claim_policy_ref','phase14-private-claims-v1','ticket_id',p.ticket_id,'entitlement_ref',e.id,'idempotency_key',c.idempotency_key,
  'payout_ua',c.payout_address,'orchard_receiver_hex',encode(p.orchard_receiver,'hex'),'amount_zat',e.amount_zat::text,
  'kind',CASE WHEN mode IN ('VOID_REFUND','NO_WINNER_REFUND') THEN 'REFUND' ELSE 'PAYOUT' END,
  'refund_reason',CASE mode WHEN 'VOID_REFUND' THEN 'VOID' WHEN 'NO_WINNER_REFUND' THEN 'NO_WINNER_REFUND' ELSE NULL END,
  'fee_mode','EXTERNALLY_SUBSIDIZED')
 OR c.kind IS DISTINCT FROM b->>'kind' OR c.refund_reason IS DISTINCT FROM b->>'refund_reason'
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.claim_instruction_outbox o WHERE o.claim_id=cid AND o.instruction=p.record->'instruction'
  AND o.instruction=jsonb_build_object('kind','PRIVATE_PAYOUT_PREPARATION','spending_authorized',false,'binding',b,'receiver_policy','ORCHARD_REQUIRED')) THEN
  RAISE EXCEPTION USING ERRCODE='P1502',MESSAGE='eligible immutable prepared claim required'; END IF;
 expected:=jsonb_build_object('kind','PRIVATE_PAYOUT_INTENT','version',1,'intent_id','payout-intent:'||cid,
  'claim_id',cid,'claim_revision',p.revision::text,'market_id',mid,'ticket_id',p.ticket_id,'entitlement_id',e.id,
  'network','testnet','vault_context_ref',(SELECT vault_context_ref FROM darkpool_private.markets WHERE id=mid),
  'account_ref',(SELECT account_ref::text FROM darkpool_private.watcher_state WHERE market_id=mid),
  'ledger_root',encode(r.ledger_root,'hex'),'resolution_ref',r.resolution_id,'publication_receipt_ref',rid,
  'outcome',b->>'outcome','entitlement_kind',c.kind,'refund_reason',c.refund_reason,'amount_zat',e.amount_zat::text,
  'payout_ua',c.payout_address,'orchard_receiver_hex',encode(p.orchard_receiver,'hex'),'receiver_policy','ORCHARD_REQUIRED',
  'fee_mode','EXTERNALLY_SUBSIDIZED','external_funding_ref',s.external_funding_ref,'fee_ceiling_zat',s.per_intent_fee_ceiling_zat::text,
  'policy_ref','phase15-plan-only-v1','execution_class',s.execution_class,'spending_authorized',false,'submission_enabled',false);
 SELECT * INTO prior FROM darkpool_private.payout_intents WHERE claim_id=cid;
 IF prior.intent_id IS NOT NULL AND prior.record IS DISTINCT FROM expected THEN
  RAISE EXCEPTION USING ERRCODE='P1503',MESSAGE='immutable intent conflict'; END IF;
 SELECT s.planning_fee_budget_zat-coalesce(sum(fee_ceiling_zat),0) INTO remaining FROM darkpool_private.payout_intents WHERE market_id=mid;
 IF prior.intent_id IS NULL AND remaining<s.per_intent_fee_ceiling_zat THEN
  RAISE EXCEPTION USING ERRCODE='P1503',MESSAGE='planning fee budget exhausted'; END IF;
 RETURN jsonb_build_object('intent',expected,'existing',CASE WHEN prior.intent_id IS NULL THEN NULL ELSE prior.record END,'remaining_fee_zat',remaining::text);
END $$;

CREATE FUNCTION darkpool_payout.begin_plan(cid text) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT darkpool_payout.context(cid) $$;

CREATE FUNCTION darkpool_payout.store_plan(cid text,proposal jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d jsonb; b jsonb; intent text;
BEGIN
 d:=darkpool_payout.context(cid); b:=d->'intent'; intent:=b->>'intent_id';
 IF proposal IS DISTINCT FROM b THEN RAISE EXCEPTION USING ERRCODE='P1503',MESSAGE='intent binding conflict'; END IF;
 IF d->'existing'='null'::jsonb THEN
  INSERT INTO darkpool_private.payout_intents VALUES(intent,cid,b->>'market_id',b->>'ticket_id',b->>'entitlement_id',
   b->>'resolution_ref',decode(b->>'ledger_root','hex'),(b->>'amount_zat')::numeric,(b->>'fee_ceiling_zat')::numeric,
   b->>'execution_class',b,session_user,clock_timestamp());
 END IF;
 RETURN jsonb_build_object('result','PAYOUT_INTENT','intent_id',intent,
  'planning_state',CASE WHEN EXISTS(SELECT 1 FROM darkpool_private.payout_reconciliation_reports WHERE intent_id=intent)
   THEN 'RECONCILIATION_REQUIRED' ELSE 'PLANNED' END,'execution_class',b->>'execution_class',
  'spending_authorized',false,'submission_enabled',false);
END $$;

-- Cautionary observations only. Even a reported inclusion never authorizes
-- confirmation/replacement. This remains available during a safety hold.
CREATE FUNCTION darkpool_payout.report(cid text,q jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i darkpool_private.payout_intents; s darkpool_private.payout_planner_scopes;
 prior darkpool_private.payout_reconciliation_reports; tx bytea; saved_tx bytea; receipt uuid;
BEGIN
 SELECT * INTO i FROM darkpool_private.payout_intents WHERE claim_id=cid;
 s:=darkpool_payout.authorize(i.market_id,true);
 IF current_setting('transaction_isolation')<>'serializable' OR current_setting('synchronous_commit')<>'on' THEN
  RAISE EXCEPTION USING ERRCODE='P1501',MESSAGE='serializable durable transaction required'; END IF;
 PERFORM pg_advisory_xact_lock(1146110284,4);
 PERFORM 1 FROM darkpool_private.payout_intents WHERE intent_id=i.intent_id FOR UPDATE;
 IF i.intent_id IS NULL OR i.execution_class IS DISTINCT FROM s.execution_class
 OR q IS NULL OR jsonb_typeof(q)<>'object' OR octet_length(q::text)>2048
 OR (SELECT count(*) FROM jsonb_object_keys(q))<>5 OR NOT(q ?& ARRAY['report_key','kind','transaction_id','artifact_ref','evidence_ref'])
 OR NOT coalesce(q->>'report_key' ~ '^[A-Za-z0-9_-]{1,128}$',false)
 OR NOT coalesce(q->>'evidence_ref' ~ '^[A-Za-z0-9_-]{1,128}$',false)
 OR NOT coalesce(q->>'kind' IN ('CONSTRUCTION_REPORTED','SUBMISSION_ACCEPTED_REPORTED','SUBMISSION_UNCERTAIN',
  'PROCESS_INTERRUPTED','INCLUSION_REPORTED','REORG_REPORTED','SPEND_CONFLICT_REPORTED'),false)
 OR (q->'transaction_id'<>'null'::jsonb AND NOT coalesce(q->>'transaction_id' ~ '^[0-9a-f]{64}$',false))
 OR (q->'artifact_ref'<>'null'::jsonb AND NOT coalesce(q->>'artifact_ref' ~ '^[A-Za-z0-9_-]{1,128}$',false))
 OR EXISTS(SELECT 1 FROM jsonb_each(q) kv WHERE jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
  RAISE EXCEPTION USING ERRCODE='P1504',MESSAGE='invalid cautionary report'; END IF;
 SELECT * INTO prior FROM darkpool_private.payout_reconciliation_reports WHERE intent_id=i.intent_id AND report_key=q->>'report_key';
 IF prior.receipt_id IS NOT NULL AND prior.report IS DISTINCT FROM q THEN
  RAISE EXCEPTION USING ERRCODE='P1503',MESSAGE='reconciliation report conflict'; END IF;
 tx:=decode(q->>'transaction_id','hex');
 SELECT txid INTO saved_tx FROM darkpool_private.payout_reported_transactions WHERE intent_id=i.intent_id;
 IF tx IS NOT NULL AND saved_tx IS NOT NULL AND tx IS DISTINCT FROM saved_tx THEN
  RAISE EXCEPTION USING ERRCODE='P1503',MESSAGE='transaction identity conflict'; END IF;
 IF tx IS NOT NULL AND saved_tx IS NULL THEN
  INSERT INTO darkpool_private.payout_reported_transactions VALUES(i.intent_id,tx);
 END IF;
 IF prior.receipt_id IS NULL THEN
  receipt:=gen_random_uuid();
  INSERT INTO darkpool_private.payout_reconciliation_reports VALUES(i.intent_id,q->>'report_key',receipt,q,session_user,clock_timestamp());
 ELSE receipt:=prior.receipt_id; END IF;
 RETURN jsonb_build_object('result','PAYOUT_RECONCILIATION','intent_id',i.intent_id,'receipt_id',receipt,
  'planning_state','RECONCILIATION_REQUIRED','execution_class',s.execution_class,
  'spending_authorized',false,'submission_enabled',false,'replacement_authorized',false,'confirmation_authorized',false);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_payout FROM PUBLIC;

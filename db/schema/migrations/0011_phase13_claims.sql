-- Private durable claim reservation only. No publication, signer, broadcast or
-- finality capability. Existing algorithms, migrations and core enums untouched.
CREATE SCHEMA darkpool_claims;
REVOKE ALL ON SCHEMA darkpool_claims FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_claims REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
INSERT INTO darkpool_private.policy_refs VALUES('phase14-private-claims-v1','PINNED',NULL,'approved-phase14-durable-claims') ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.policy_refs WHERE id='phase14-private-claims-v1' AND status='PINNED'
  AND reviewed_profile_ref='approved-phase14-durable-claims') THEN
  RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='claim policy conflict'; END IF;
END $$;
CREATE DOMAIN darkpool_private.claim_preparation_state AS text CHECK(VALUE IN
 ('RESERVED','PREPARED','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','RECONCILIATION_REQUIRED'));
CREATE TABLE darkpool_private.claim_services (
 market_id text PRIMARY KEY REFERENCES darkpool_private.markets,
 service_login name NOT NULL, execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST'))
);
CREATE TABLE darkpool_private.claim_reservations (
 claim_id text PRIMARY KEY REFERENCES darkpool_private.claims,
 market_id text NOT NULL, ticket_id text NOT NULL, entitlement_id text NOT NULL UNIQUE,
 resolution_id text NOT NULL, ledger_root bytea NOT NULL CHECK(octet_length(ledger_root)=32),
 credential_commitment bytea NOT NULL CHECK(octet_length(credential_commitment)=32),
 orchard_receiver bytea NOT NULL UNIQUE CHECK(octet_length(orchard_receiver)=43),
 idempotency_key text NOT NULL, execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 revision bigint NOT NULL CHECK(revision>0), state darkpool_private.claim_preparation_state NOT NULL,
 record jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 submission_ref text, reconciliation_ref text,
 UNIQUE(market_id,ticket_id), UNIQUE(market_id,idempotency_key),
 FOREIGN KEY(market_id,ticket_id,entitlement_id) REFERENCES darkpool_private.entitlements(market_id,ticket_id,id),
 FOREIGN KEY(market_id,resolution_id) REFERENCES darkpool_private.resolutions(market_id,id),
 CONSTRAINT phase14_no_submission CHECK(state IN ('RESERVED','PREPARED') AND submission_ref IS NULL AND reconciliation_ref IS NULL)
);
CREATE TABLE darkpool_private.claim_instruction_outbox (
 claim_id text PRIMARY KEY REFERENCES darkpool_private.claim_reservations,
 instruction jsonb NOT NULL, created_at timestamptz NOT NULL,
 CHECK(instruction->>'kind'='PRIVATE_PAYOUT_PREPARATION' AND instruction->'spending_authorized'='false'::jsonb)
);
REVOKE ALL ON darkpool_private.claim_services,darkpool_private.claim_reservations,darkpool_private.claim_instruction_outbox FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['claim_services','claim_reservations','claim_instruction_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER claim_no_truncate BEFORE TRUNCATE ON darkpool_private.%I FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['claim_services','claim_instruction_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER claim_immutable BEFORE UPDATE OR DELETE ON darkpool_private.%I FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION darkpool_claims.authorize(mid text) RETURNS darkpool_private.claim_services LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.claim_services; a darkpool_private.oracle_authorities;
BEGIN
 PERFORM darkpool_lock.authorize();
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('darkpool_claims','darkpool_publication','darkpool_resolution')
  AND pg_has_role(session_user,nspowner,'MEMBER')) THEN
  RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='restricted claim service required'; END IF;
 SELECT * INTO s FROM darkpool_private.claim_services WHERE market_id=mid AND service_login=session_user;
 SELECT * INTO a FROM darkpool_private.oracle_authorities WHERE market_id=mid;
 IF s.market_id IS NULL OR a.market_id IS NULL OR s.execution_class IS DISTINCT FROM a.execution_class
 OR (s.execution_class='SYNTHETIC_TEST' AND NOT darkpool_resolution.test_scope(a)) THEN
  RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='claim service unavailable'; END IF;
 RETURN s;
END $$;

CREATE FUNCTION darkpool_claims.begin_claim(mid text,tid text,k text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.claim_services; a darkpool_private.oracle_authorities;
 r darkpool_private.resolution_results; approval darkpool_private.oracle_approvals; t darkpool_private.tickets;
 e darkpool_private.entitlements; prior darkpool_private.claim_reservations; gate jsonb; rid text;
BEGIN
 IF tid !~ '^[0-9a-f]{64}$' OR k !~ '^[A-Za-z0-9_-]{1,128}$' OR length(mid)=0 THEN
  RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='invalid claim context'; END IF;
 s:=darkpool_claims.authorize(mid);
 PERFORM darkpool_resolution.lock_context(mid);
 SELECT * INTO a FROM darkpool_private.oracle_authorities WHERE market_id=mid;
 rid:=darkpool_resolution.publication(mid,a);
 SELECT * INTO r FROM darkpool_private.resolution_results WHERE market_id=mid;
 IF r.market_id IS NULL OR r.execution_class IS DISTINCT FROM s.execution_class OR r.publication_receipt_id IS DISTINCT FROM rid
 OR r.ledger_root IS DISTINCT FROM (SELECT merkle_root FROM darkpool_private.ledger_commitments WHERE market_id=mid)
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.markets WHERE id=mid AND status IN ('PAYING','REFUNDING')) THEN
  RAISE EXCEPTION USING ERRCODE='P1404',MESSAGE='authorized durable resolution required'; END IF;
 SELECT * INTO approval FROM darkpool_private.oracle_approvals WHERE request_key=r.request_key;
 SELECT * INTO t FROM darkpool_private.tickets WHERE market_id=mid AND id=tid;
 SELECT ent.* INTO e FROM darkpool_private.entitlements ent JOIN darkpool_private.resolution_entitlements b ON b.entitlement_id=ent.id
  WHERE ent.market_id=mid AND ent.ticket_id=tid AND ent.kind='ACCEPTED_STAKE'
   AND ent.amount_zat=b.winning_payout_zat+b.refund_zat FOR UPDATE OF ent;
 IF t.id IS NULL OR e.id IS NULL OR e.amount_zat<=0 OR t.claim_commitment_profile<>'DARKPOOL_CLAIM_V1_ID_FRAME_1'
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_records WHERE market_id=mid AND ticket_id=tid)
 OR EXISTS(SELECT 1 FROM darkpool_private.claims c WHERE c.market_id=mid AND c.ticket_id=tid
  AND NOT EXISTS(SELECT 1 FROM darkpool_private.claim_reservations p WHERE p.claim_id=c.id)) THEN
  RAISE EXCEPTION USING ERRCODE='P1405',MESSAGE='payable accepted entitlement required'; END IF;
 SELECT * INTO prior FROM darkpool_private.claim_reservations WHERE market_id=mid AND ticket_id=tid FOR UPDATE;
 gate:=jsonb_build_object('market_id',mid,'market_state',(SELECT status FROM darkpool_private.markets WHERE id=mid),
  'market_revision',(SELECT revision::text FROM darkpool_private.admin_revisions WHERE market_id=mid),
  'ledger_root',encode(r.ledger_root,'hex'),'resolution_ref',r.resolution_id,'outcome',approval.resolution->>'outcome',
  'mode',r.preparation#>>'{calculation,mode}','publication_receipt_ref',rid,'claim_policy_ref','phase14-private-claims-v1');
 PERFORM set_config('darkpool_claims.context',jsonb_build_object('market',mid,'ticket',tid,'key',k,'xid',pg_current_xact_id()::text)::text,true);
 RETURN jsonb_build_object('gate',gate,'execution_class',s.execution_class,
  'authority',jsonb_build_object('rule',a.rule,'resources',a.resources,'execution_class',a.execution_class,'actor_ref',a.actor_ref,
   'oracle_login',a.oracle_login,'observation_at',a.observation_at),
  'approval',to_jsonb(approval),'seal',darkpool_lock.snapshot(mid),'saved',to_jsonb(r),
  'credential',jsonb_build_object('ticket_id',tid,'profile',t.claim_commitment_profile,'commitment',encode(t.claim_commitment,'hex')),
  'entitlement_ref',e.id,'existing',CASE WHEN prior.claim_id IS NULL THEN NULL ELSE prior.record END,
  'reservation_id',prior.claim_id,
  'stored_entitlements',coalesce((SELECT jsonb_agg(jsonb_build_object('ticket_id',b.ticket_id,'winning_payout_zat',b.winning_payout_zat::text,
   'refund_zat',b.refund_zat::text,'amount_zat',en.amount_zat::text) ORDER BY b.ticket_id COLLATE "C")
   FROM darkpool_private.resolution_entitlements b JOIN darkpool_private.entitlements en ON en.id=b.entitlement_id WHERE b.market_id=mid),'[]'::jsonb),
  'receiving_uas',coalesce((SELECT jsonb_agg(receiver_ref ORDER BY id COLLATE "C") FROM darkpool_private.tickets WHERE market_id=mid),'[]'::jsonb),
  'prior_receivers',coalesce((SELECT jsonb_agg(jsonb_build_object('claim_id',claim_id,'receiver',encode(orchard_receiver,'hex')))
   FROM darkpool_private.claim_reservations),'[]'::jsonb));
END $$;

CREATE FUNCTION darkpool_claims.protect_core() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;
BEGIN
 PERFORM darkpool_claims.authorize(NEW.market_id);
 ctx:=current_setting('darkpool_claims.context',true)::jsonb;
 IF ctx->>'market' IS DISTINCT FROM NEW.market_id OR ctx->>'ticket' IS DISTINCT FROM NEW.ticket_id
 OR ctx->>'key' IS DISTINCT FROM NEW.idempotency_key OR ctx->>'xid' IS DISTINCT FROM pg_current_xact_id()::text
 OR NEW.state NOT IN ('RESERVED','TX_PREPARING') OR NEW.tx_ref IS NOT NULL OR NEW.settlement_id IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='claim preparation path required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase14_core_claim BEFORE INSERT OR UPDATE ON darkpool_private.claims FOR EACH ROW EXECUTE FUNCTION darkpool_claims.protect_core();
CREATE FUNCTION darkpool_claims.protect_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['revision','state','record','updated_at']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['revision','state','record','updated_at']) OR NEW.revision<>OLD.revision+1
 OR OLD.state<>'RESERVED' OR NEW.state<>'PREPARED' OR NEW.record->'binding' IS DISTINCT FROM OLD.record->'binding' THEN
  RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='immutable claim obligation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER claim_binding_immutable BEFORE UPDATE OR DELETE ON darkpool_private.claim_reservations FOR EACH ROW EXECUTE FUNCTION darkpool_claims.protect_reservation();

CREATE FUNCTION darkpool_claims.store(mid text,tid text,k text,change jsonb,credential text,prepare boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d jsonb; b jsonb; rec jsonb; prior darkpool_private.claim_reservations; c darkpool_private.claims;
 eid text; amount numeric; cid text; stamp timestamptz; cls text;
BEGIN
 d:=darkpool_claims.begin_claim(mid,tid,k); rec:=change->'next'; b:=rec->'binding'; cls:=d->>'execution_class'; eid:=d->>'entitlement_ref';
 SELECT amount_zat INTO amount FROM darkpool_private.entitlements WHERE id=eid;
 SELECT * INTO prior FROM darkpool_private.claim_reservations WHERE market_id=mid AND ticket_id=tid;
 IF change IS NULL OR (SELECT count(*) FROM jsonb_object_keys(change))<>2 OR NOT(change ?& ARRAY['expected_revision','next'])
 OR jsonb_typeof(rec) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(rec))<>6
 OR NOT(rec ?& ARRAY['revision','state','binding','instruction','tx_ref','reconciliation_required'])
 OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>18
 OR b IS DISTINCT FROM (d->'gate')||jsonb_build_object('ticket_id',tid,'entitlement_ref',eid,'idempotency_key',k,
  'payout_ua',b->>'payout_ua','orchard_receiver_hex',b->>'orchard_receiver_hex','amount_zat',amount::text,
  'kind',CASE WHEN d#>>'{gate,mode}' IN ('VOID_REFUND','NO_WINNER_REFUND') THEN 'REFUND' ELSE 'PAYOUT' END,
  'refund_reason',CASE d#>>'{gate,mode}' WHEN 'VOID_REFUND' THEN 'VOID' WHEN 'NO_WINNER_REFUND' THEN 'NO_WINNER_REFUND' ELSE NULL END,
  'fee_mode','EXTERNALLY_SUBSIDIZED')
 OR credential IS DISTINCT FROM d#>>'{credential,commitment}'
 OR NOT coalesce(b->>'orchard_receiver_hex' ~ '^[0-9a-f]{86}$',false)
 OR length(coalesce(b->>'payout_ua','')) NOT BETWEEN 1 AND 1024
 OR rec->'tx_ref' IS DISTINCT FROM 'null'::jsonb OR rec->'reconciliation_required' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(rec->'revision') IS DISTINCT FROM 'string'
 OR NOT coalesce((rec->>'revision') ~ '^[1-9][0-9]{0,18}$',false) THEN
  RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='claim binding mismatch'; END IF;
 stamp:=clock_timestamp();
 IF prior.claim_id IS NOT NULL THEN
  IF prior.record->'binding' IS DISTINCT FROM b OR prior.credential_commitment IS DISTINCT FROM decode(credential,'hex')
  OR change->>'expected_revision' IS DISTINCT FROM prior.revision::text THEN
   RAISE EXCEPTION USING ERRCODE='P1403',MESSAGE='claim reservation conflict'; END IF;
  cid:=prior.claim_id;
  IF rec IS DISTINCT FROM prior.record THEN
   IF prepare IS DISTINCT FROM true OR prior.state<>'RESERVED' OR rec->>'state' IS DISTINCT FROM 'TX_PREPARING'
   OR (rec->>'revision')::bigint<>prior.revision+1 OR rec->'instruction' IS DISTINCT FROM
    jsonb_build_object('kind','PRIVATE_PAYOUT_PREPARATION','spending_authorized',false,'binding',b,'receiver_policy','ORCHARD_REQUIRED') THEN
    RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='unsupported claim transition'; END IF;
   INSERT INTO darkpool_private.claim_instruction_outbox VALUES(cid,rec->'instruction',stamp);
   UPDATE darkpool_private.claims SET state='TX_PREPARING',updated_at=stamp WHERE id=cid;
   UPDATE darkpool_private.claim_reservations SET state='PREPARED',revision=revision+1,record=rec,updated_at=stamp WHERE claim_id=cid;
  END IF;
 ELSE
  IF prepare IS DISTINCT FROM false OR change->'expected_revision' IS DISTINCT FROM 'null'::jsonb OR rec->>'state' IS DISTINCT FROM 'RESERVED'
  OR rec->>'revision' IS DISTINCT FROM '1' OR rec->'instruction' IS DISTINCT FROM 'null'::jsonb
  OR EXISTS(SELECT 1 FROM darkpool_private.tickets WHERE receiver_ref=b->>'payout_ua') THEN
   RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='fresh reservation required'; END IF;
  cid:='claim:'||gen_random_uuid()::text;
  INSERT INTO darkpool_private.claims VALUES(cid,1,mid,tid,eid,b->>'kind',b->>'refund_reason','phase14-market:'||mid,k,
   'phase14-private-claims-v1',b->>'payout_ua','phase13-orchard-decoder-v1',amount,'RESERVED',NULL,NULL,stamp,stamp);
  INSERT INTO darkpool_private.claim_reservations VALUES(cid,mid,tid,eid,d#>>'{gate,resolution_ref}',decode(d#>>'{gate,ledger_root}','hex'),
   decode(credential,'hex'),decode(b->>'orchard_receiver_hex','hex'),k,cls,1,'RESERVED',rec,stamp,stamp,NULL,NULL);
  INSERT INTO darkpool_private.audit_events VALUES('reservation:'||cid,1,mid,'CLAIM_RESERVED',stamp,session_user,cid,NULL,NULL,NULL);
 END IF;
 SELECT * INTO prior FROM darkpool_private.claim_reservations WHERE claim_id=cid;
 SELECT * INTO c FROM darkpool_private.claims WHERE id=cid;
 IF c.entitlement_zat IS DISTINCT FROM amount OR c.payout_address IS DISTINCT FROM b->>'payout_ua'
 OR c.state IS DISTINCT FROM prior.record->>'state' OR c.tx_ref IS NOT NULL
 OR (prior.state='PREPARED' AND NOT EXISTS(SELECT 1 FROM darkpool_private.claim_instruction_outbox WHERE claim_id=cid AND instruction=prior.record->'instruction')) THEN
  RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='durable claim readback mismatch'; END IF;
 RETURN jsonb_build_object('result','CLAIM_STATE','reservation_id',cid,'state',prior.state,'revision',prior.revision::text,
  'execution_class',cls,'spending_authorized',false);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_claims FROM PUBLIC;

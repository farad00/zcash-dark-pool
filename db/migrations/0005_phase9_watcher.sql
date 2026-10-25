-- Approved Phase 9 official-testnet profile. No runtime roles or live provisioning.
CREATE SCHEMA darkpool_watcher;
REVOKE ALL ON SCHEMA darkpool_watcher FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_watcher REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

INSERT INTO darkpool_private.policy_refs(id,status,issue,reviewed_profile_ref)
SELECT 'phase9-'||p,'PINNED',NULL,'docs/PHASE9_IMPLEMENTATION.md#approved-2026-10-07'
FROM unnest(ARRAY['exact-chainclock-3-v1','observed','candidate','under','over','late',
 'additional','orphan','unmapped','pending','accepted','principal-unresolved']) p;

CREATE TABLE darkpool_private.watcher_state (
 market_id darkpool_private.opaque_ref PRIMARY KEY REFERENCES darkpool_private.markets,
 profile_ref text NOT NULL CHECK(profile_ref='phase9-exact-chainclock-3-v1') REFERENCES darkpool_private.policy_refs,
 account_ref text NOT NULL CHECK(account_ref ~ '^[0-9a-f-]{36}$'),
 endpoint_ref text NOT NULL CHECK(length(endpoint_ref) BETWEEN 1 AND 1024),
 anchor_height bigint NOT NULL CHECK(anchor_height>=11 AND anchor_height<=4294967295),
 anchor_hash bytea NOT NULL CHECK(octet_length(anchor_hash)=32),
 bound_closes_at timestamptz NOT NULL,
 revision bigint NOT NULL CHECK(revision>=0),
 checkpoint_ref darkpool_private.opaque_ref,
 hold_ref darkpool_private.opaque_ref,
 created_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.watcher_evidence (
 id darkpool_private.opaque_ref PRIMARY KEY,
 market_id darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.markets,
 kind text NOT NULL CHECK(kind IN ('PROFILE','OBSERVATION','RECONCILIATION','ACCEPTANCE','INCLUSION','BOUNDARY','HOLD')),
 receipt_id darkpool_private.opaque_ref,
 parent_ref darkpool_private.opaque_ref REFERENCES darkpool_private.watcher_evidence,
 request_id text CHECK(request_id ~ '^[0-9a-f]{64}$'),
 request_digest bytea CHECK(octet_length(request_digest)=32),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY(market_id,receipt_id) REFERENCES darkpool_private.payment_receipts(market_id,id),
 UNIQUE(market_id,request_id),
 UNIQUE(market_id,id),
 CHECK((request_id IS NULL)=(request_digest IS NULL))
);
ALTER TABLE darkpool_private.watcher_state ADD FOREIGN KEY(market_id,checkpoint_ref)
 REFERENCES darkpool_private.watcher_evidence(market_id,id);
ALTER TABLE darkpool_private.watcher_state ADD FOREIGN KEY(market_id,hold_ref)
 REFERENCES darkpool_private.watcher_evidence(market_id,id);
CREATE TRIGGER watcher_evidence_immutable BEFORE UPDATE OR DELETE ON darkpool_private.watcher_evidence
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER watcher_evidence_no_truncate BEFORE TRUNCATE ON darkpool_private.watcher_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER watcher_state_no_delete BEFORE DELETE ON darkpool_private.watcher_state
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER watcher_state_no_truncate BEFORE TRUNCATE ON darkpool_private.watcher_state
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();

CREATE FUNCTION darkpool_watcher.guard_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m darkpool_private.markets;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO STRICT m FROM darkpool_private.markets WHERE id=NEW.market_id FOR UPDATE;
  IF m.status<>'DRAFT' OR m.closes_at<>NEW.bound_closes_at OR NEW.revision<>0
   OR NEW.checkpoint_ref IS NOT NULL OR NEW.hold_ref IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='watcher binding requires draft'; END IF;
  INSERT INTO darkpool_private.watcher_evidence VALUES('profile:'||NEW.market_id,NEW.market_id,'PROFILE',NULL,NULL,NULL,NULL,
   jsonb_build_object('profile',NEW.profile_ref,'account',NEW.account_ref,'endpoint',NEW.endpoint_ref,
    'anchor_height',NEW.anchor_height,'anchor_hash',encode(NEW.anchor_hash,'hex'),
    'closes_at',NEW.bound_closes_at,'confirmations',3,'mtp','preceding-11-first-crossing-v1'),clock_timestamp());
 ELSE
  IF ROW(NEW.market_id,NEW.profile_ref,NEW.account_ref,NEW.endpoint_ref,NEW.anchor_height,NEW.anchor_hash,NEW.bound_closes_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.market_id,OLD.profile_ref,OLD.account_ref,OLD.endpoint_ref,OLD.anchor_height,OLD.anchor_hash,OLD.bound_closes_at,OLD.created_at)
   OR NEW.revision<>OLD.revision+1 OR (OLD.hold_ref IS NOT NULL AND NEW.hold_ref IS DISTINCT FROM OLD.hold_ref) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='watcher binding or hold is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER watcher_state_binding BEFORE INSERT OR UPDATE ON darkpool_private.watcher_state
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_state();

CREATE FUNCTION darkpool_watcher.guard_market() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.watcher_state;
BEGIN
 SELECT * INTO s FROM darkpool_private.watcher_state WHERE market_id=NEW.id FOR UPDATE;
 IF FOUND THEN
  IF NEW.closes_at<>s.bound_closes_at OR NEW.deposit_confirmations IS DISTINCT FROM 3
   OR NEW.payment_policy_ref<>s.profile_ref OR NEW.close_policy_ref<>s.profile_ref THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='approved watcher profile mismatch'; END IF;
  IF s.hold_ref IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'PAUSED' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='watcher safety stop'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER watcher_market_guard BEFORE UPDATE ON darkpool_private.markets
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_market();

CREATE FUNCTION darkpool_watcher.guard_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM darkpool_private.watcher_state s JOIN darkpool_private.accepted_payment_receipts a
  ON a.market_id=s.market_id WHERE a.receipt_id=OLD.id) AND
  ROW(NEW.ticket_id,NEW.block_height,NEW.block_hash,NEW.chain_evidence_ref,NEW.status_policy_ref)
   IS DISTINCT FROM ROW(OLD.ticket_id,OLD.block_height,OLD.block_hash,OLD.chain_evidence_ref,OLD.status_policy_ref) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='accepted watcher inclusion immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER watcher_receipt_immutable BEFORE UPDATE ON darkpool_private.payment_receipts
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_receipt();

CREATE FUNCTION darkpool_watcher.guard_progression() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m text;
BEGIN
 m := NEW.market_id;
 IF EXISTS(SELECT 1 FROM darkpool_private.watcher_state WHERE market_id=m AND hold_ref IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='watcher safety stop'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER watcher_ledger_stop BEFORE INSERT OR UPDATE ON darkpool_private.ledger_sets
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_progression();
CREATE TRIGGER watcher_resolution_stop BEFORE INSERT OR UPDATE ON darkpool_private.resolutions
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_progression();
CREATE TRIGGER watcher_settlement_stop BEFORE INSERT OR UPDATE ON darkpool_private.settlements
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_progression();

CREATE FUNCTION darkpool_watcher.guard_acceptance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m text; t text; g text; n integer;
BEGIN
 m:=CASE WHEN TG_OP='DELETE' THEN OLD.market_id ELSE NEW.market_id END;
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_state WHERE market_id=m) THEN
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='accepted watcher history retained'; END IF;
 IF EXISTS(SELECT 1 FROM darkpool_private.watcher_state WHERE market_id=m AND hold_ref IS NOT NULL) THEN
  IF TG_TABLE_NAME<>'tickets' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='watcher safety stop'; END IF;
  IF (TG_OP='UPDATE' AND NEW.accepted_amount_zat IS DISTINCT FROM OLD.accepted_amount_zat)
   OR (TG_OP='INSERT' AND NEW.accepted_amount_zat>0) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='watcher safety stop'; END IF;
 END IF;
 IF TG_TABLE_NAME='tickets' THEN
  IF TG_OP='UPDATE' AND OLD.accepted_amount_zat>0 AND
   ROW(NEW.payment_state,NEW.accepted_amount_zat,NEW.accepted_payment_ref,NEW.accepted_at)
    IS DISTINCT FROM ROW(OLD.payment_state,OLD.accepted_amount_zat,OLD.accepted_payment_ref,OLD.accepted_at) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='accepted watcher ticket immutable'; END IF;
  IF NEW.payment_state='CONFIRMED' THEN
   g:=NEW.accepted_payment_ref; t:=NEW.id;
   SELECT count(*) INTO n FROM darkpool_private.accepted_payments WHERE market_id=m AND ticket_id=t;
   IF n<>1 OR (SELECT count(*) FROM darkpool_private.accepted_payment_receipts WHERE accepted_payment_id=g)<>1
    OR NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence WHERE market_id=m AND kind='ACCEPTANCE'
      AND details->>'group_id'=g) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='single-output acceptance evidence required'; END IF;
  END IF;
 ELSE
  t:=NEW.ticket_id;
  IF (SELECT count(*) FROM darkpool_private.accepted_payments WHERE market_id=m AND ticket_id=t)>1 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='one accepted group per ticket'; END IF;
  IF TG_TABLE_NAME='accepted_payment_receipts' THEN
   IF (SELECT count(*) FROM darkpool_private.accepted_payment_receipts WHERE accepted_payment_id=NEW.accepted_payment_id)>1 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='one accepted output per group'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM darkpool_private.tickets WHERE id=t AND market_id=m AND payment_state='CONFIRMED') THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='accepted group requires confirmed ticket'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER watcher_ticket_acceptance AFTER INSERT OR UPDATE ON darkpool_private.tickets
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_acceptance();
CREATE TRIGGER watcher_ticket_immutable BEFORE UPDATE ON darkpool_private.tickets
 FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_acceptance();
CREATE CONSTRAINT TRIGGER watcher_group_acceptance AFTER INSERT OR UPDATE OR DELETE ON darkpool_private.accepted_payments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_acceptance();
CREATE CONSTRAINT TRIGGER watcher_member_acceptance AFTER INSERT OR UPDATE OR DELETE ON darkpool_private.accepted_payment_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_watcher.guard_acceptance();

CREATE FUNCTION darkpool_watcher.context() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.watcher_state; m darkpool_private.markets;
BEGIN
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='watcher unavailable'; END IF;
 SELECT * INTO STRICT s FROM darkpool_private.watcher_state;
 SELECT * INTO STRICT m FROM darkpool_private.markets WHERE id=s.market_id;
 RETURN jsonb_build_object('version',1,'network','testnet','market_id',m.id,'vault_context_ref',m.vault_context_ref,
  'account_ref',s.account_ref,'endpoint_ref',s.endpoint_ref,'revision',s.revision::text,'hold',s.hold_ref IS NOT NULL,
  'profile_ref',s.profile_ref,'closes_at_us',(extract(epoch FROM m.closes_at)*1000000)::numeric::text,
  'anchor_height',s.anchor_height,'anchor_hash',encode(s.anchor_hash,'hex'),
  'unmapped',coalesce((SELECT jsonb_agg(q.output) FROM (SELECT DISTINCT ON (details->'output'->>'txid',details->'output'->>'pool',details->'output'->>'output_index') details->'output' AS output
    FROM darkpool_private.watcher_evidence WHERE market_id=m.id AND kind='OBSERVATION' AND receipt_id IS NULL) q),'[]'::jsonb),
  'receipts',coalesce((SELECT jsonb_agg(jsonb_build_object('receipt_id',r.id,'txid',encode(r.txid,'hex'),
   'pool',r.value_pool,'output_index',r.output_index,'amount_zat',r.amount_zat::text,'receiver_ref',r.receiver_ref,
   'ticket_id',r.ticket_id,'diversifier_ref',t.diversifier_ref,'journal_commitment',encode(t.claim_commitment,'hex'),
   'block_height',r.block_height,'block_hash',encode(r.block_hash,'hex'),
   'block_time',(SELECT (e.details->>'time')::bigint FROM darkpool_private.watcher_evidence e WHERE e.id=r.chain_evidence_ref),
   'tx_index',(SELECT (e.details->>'tx_index')::bigint FROM darkpool_private.watcher_evidence e WHERE e.id=r.chain_evidence_ref),
   'accepted',EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts a WHERE a.receipt_id=r.id)))
    FROM darkpool_private.payment_receipts r LEFT JOIN darkpool_private.tickets t ON t.id=r.ticket_id
    WHERE r.market_id=m.id),'[]'::jsonb));
END $$;

CREATE FUNCTION darkpool_watcher.reconcile(expected_revision bigint,request jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.watcher_state; m darkpool_private.markets; o jsonb; c jsonb; b jsonb;
 r darkpool_private.payment_receipts; t darkpool_private.tickets; saved darkpool_private.watcher_evidence;
 digest bytea; rid text; eid text; group_id text; mode text; reason text; classification text;
 tip bigint; h bigint; idx bigint; tm bigint; previous_h bigint; median_time bigint; boundary bigint;
 times bigint[]:=ARRAY[]::bigint[];
 row_id text; mapped boolean; accepted boolean; evidence_id text; result jsonb;
 note_reason text; conflicts jsonb:='[]'::jsonb;
BEGIN
 IF request IS NULL OR jsonb_typeof(request)<>'object' OR octet_length(request::text)>4194304
  OR request->'version' IS DISTINCT FROM '1'::jsonb OR request->>'network' IS DISTINCT FROM 'testnet'
  OR NOT coalesce(request->>'request_id' ~ '^[0-9a-f]{64}$',false) THEN
  RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid watcher request'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(request) k WHERE k NOT IN
  ('version','request_id','mode','network','market_id','vault_context_ref','account_ref','endpoint_ref','outputs','chain','reason')) THEN
  RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='unknown watcher field'; END IF;
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='watcher unavailable'; END IF;
 SELECT * INTO STRICT m FROM darkpool_private.markets FOR UPDATE;
 SELECT * INTO STRICT s FROM darkpool_private.watcher_state WHERE market_id=m.id FOR UPDATE;
 rid:=request->>'request_id'; eid:='reconcile:'||rid; digest:=sha256(convert_to(request::text,'UTF8'));
 SELECT * INTO saved FROM darkpool_private.watcher_evidence WHERE market_id=m.id AND request_id=rid;
 IF FOUND THEN
  IF saved.request_digest<>digest THEN RAISE EXCEPTION USING ERRCODE='P4902',MESSAGE='watcher retry conflict'; END IF;
  RETURN saved.details->'result';
 END IF;
 IF expected_revision IS DISTINCT FROM s.revision THEN
  RAISE EXCEPTION USING ERRCODE='P4902',MESSAGE='watcher revision conflict'; END IF;
 IF request->>'market_id' IS DISTINCT FROM m.id OR request->>'vault_context_ref' IS DISTINCT FROM m.vault_context_ref
  OR request->>'account_ref' IS DISTINCT FROM s.account_ref OR request->>'endpoint_ref' IS DISTINCT FROM s.endpoint_ref
  OR m.closes_at<>s.bound_closes_at OR m.deposit_confirmations IS DISTINCT FROM 3
  OR m.payment_policy_ref<>s.profile_ref OR m.close_policy_ref<>s.profile_ref THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='watcher context mismatch'; END IF;
 mode:=request->>'mode';
 IF mode NOT IN ('observe_only','snapshot','safety_stop') OR mode IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid watcher mode'; END IF;
 IF mode='safety_stop' THEN
  IF NOT coalesce(request->>'reason' IN ('CANONICAL_CONTRADICTION','MAPPING_CONFLICT','RESTORE_REVIEW','ANCHOR_CONFLICT'),false) THEN
   RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid safety reason'; END IF;
  reason:=request->>'reason';
 ELSE
  IF jsonb_typeof(request->'outputs') IS DISTINCT FROM 'array' OR jsonb_array_length(request->'outputs')>4096 THEN
   RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid watcher outputs'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'outputs') q GROUP BY q->>'txid',q->>'pool',q->>'output_index' HAVING count(*)>1) THEN
   RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='duplicate request output'; END IF;
  IF mode='snapshot' THEN
   c:=request->'chain';
   IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(c) k WHERE k NOT IN
    ('complete','verified','tip_height','tip_hash','scanned_height','scanned_hash','anchor_hash','verified_at','verified_at_epoch','mtp_blocks')) THEN
    RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid chain fields'; END IF;
   IF c->'complete' IS DISTINCT FROM 'true'::jsonb OR c->'verified' IS DISTINCT FROM 'true'::jsonb
    OR c->>'anchor_hash' IS DISTINCT FROM encode(s.anchor_hash,'hex')
    OR NOT coalesce(c->>'tip_height' ~ '^[0-9]{1,10}$',false) OR NOT coalesce(c->>'tip_hash' ~ '^[0-9a-f]{64}$',false)
    OR c->>'scanned_height' IS DISTINCT FROM c->>'tip_height' OR c->>'scanned_hash' IS DISTINCT FROM c->>'tip_hash'
    OR c->>'verified_at' IS NULL OR (c->>'verified_at')::timestamptz>clock_timestamp()+interval '5 seconds'
    OR (c->>'verified_at')::timestamptz<clock_timestamp()-interval '30 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='unverified watcher snapshot'; END IF;
   tip:=(c->>'tip_height')::bigint;
   IF tip<s.anchor_height OR tip>4294967295 THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid chain coverage'; END IF;
   IF EXISTS(SELECT 1 FROM darkpool_private.payment_receipts p WHERE p.market_id=m.id AND NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(request->'outputs') q WHERE q->>'txid'=encode(p.txid,'hex')
     AND q->>'pool'=p.value_pool AND (q->>'output_index')::bigint=p.output_index)) THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='incomplete reconciliation'; END IF;
   IF jsonb_typeof(c->'mtp_blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'mtp_blocks')>16384 THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='missing close evidence'; END IF;
   previous_h:=s.anchor_height-11;
   FOR b IN SELECT value FROM jsonb_array_elements(c->'mtp_blocks') LOOP
    h:=(b->>'height')::bigint;
    IF h IS DISTINCT FROM previous_h+1 OR NOT coalesce(b->>'hash' ~ '^[0-9a-f]{64}$',false) OR NOT coalesce(b->>'time' ~ '^[0-9]{1,10}$',false) THEN
     RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid close evidence'; END IF;
    previous_h:=h;
    IF h=s.anchor_height AND b->>'hash'<>encode(s.anchor_hash,'hex') THEN reason:='ANCHOR_CONFLICT'; END IF;
    IF h>s.anchor_height THEN
     SELECT x INTO median_time FROM unnest(times) x ORDER BY x OFFSET 5 LIMIT 1;
     IF median_time IS NULL OR (b->>'time')::bigint<=median_time THEN
      RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid median-time evidence'; END IF;
     IF boundary IS NULL AND median_time::numeric*1000000>=extract(epoch FROM m.closes_at)*1000000 THEN boundary:=h; END IF;
    END IF;
    tm:=(b->>'time')::bigint;
    IF tm>4294967295 THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid block timestamp'; END IF;
    times:=CASE WHEN cardinality(times)=11 THEN times[2:11]||tm ELSE times||tm END;
    IF h=s.anchor_height THEN
     SELECT x INTO median_time FROM unnest(times) x ORDER BY x OFFSET 5 LIMIT 1;
     IF median_time IS NULL OR median_time::numeric*1000000>=extract(epoch FROM m.closes_at)*1000000 THEN
      RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='anchor must precede close boundary'; END IF;
    END IF;
   END LOOP;
   IF previous_h<>tip OR b->>'hash' IS DISTINCT FROM c->>'tip_hash' THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='incomplete close evidence'; END IF;
  END IF;
  -- Validate every output and all immutable conflicts before new acceptance.
  FOR o IN SELECT value FROM jsonb_array_elements(request->'outputs') LOOP
   note_reason:=NULL;
   IF jsonb_typeof(o) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid observed output'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(o) k WHERE k NOT IN ('txid','pool','output_index','amount_zat','is_change','key_scope','present',
    'receiver_verified','canonical','block_height','block_hash','block_time','tx_index','receiver_ref','diversifier_ref','ticket_id','journal_commitment','receipt_id','accepted')) THEN
    RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='unknown output field'; END IF;
   IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT coalesce(o->>'txid' ~ '^[0-9a-f]{64}$',false) OR NOT coalesce(o->>'pool' IN ('SAPLING','ORCHARD','IRONWOOD'),false)
    OR NOT coalesce(o->>'output_index' ~ '^[0-9]{1,10}$',false) OR (o->>'output_index')::numeric>4294967295
    OR NOT coalesce(o->>'amount_zat' ~ '^(0|[1-9][0-9]{0,15})$',false)
    OR NOT coalesce(o->'present' IN ('true'::jsonb,'false'::jsonb),false)
    OR NOT coalesce(o->'canonical' IN ('true'::jsonb,'false'::jsonb),false)
    OR NOT coalesce(o->'receiver_verified' IN ('true'::jsonb,'false'::jsonb),false)
    OR NOT coalesce(o->'is_change' IN ('true'::jsonb,'false'::jsonb),false) THEN
    RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid observed identity'; END IF;
   SELECT * INTO r FROM darkpool_private.payment_receipts WHERE network='testnet' AND txid=decode(o->>'txid','hex')
    AND value_pool=o->>'pool' AND output_index=(o->>'output_index')::bigint;
   IF FOUND THEN
    IF r.market_id<>m.id OR r.amount_zat<>(o->>'amount_zat')::numeric
     OR o->>'receiver_ref' IS DISTINCT FROM r.receiver_ref OR o->>'ticket_id' IS DISTINCT FROM r.ticket_id
     OR o->>'receiver_verified' IS DISTINCT FROM 'true' OR o->>'key_scope' IS DISTINCT FROM '0' OR o->>'is_change' IS DISTINCT FROM 'false'
     OR NOT EXISTS(SELECT 1 FROM darkpool_private.tickets bound_ticket WHERE bound_ticket.id=r.ticket_id
       AND bound_ticket.diversifier_ref=o->>'diversifier_ref' AND encode(bound_ticket.claim_commitment,'hex')=o->>'journal_commitment')
     THEN note_reason:='MAPPING_CONFLICT'; END IF;
    IF mode='snapshot' AND EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts a WHERE a.receipt_id=r.id) THEN
     IF o->>'canonical' IS DISTINCT FROM 'true' OR o->>'present' IS DISTINCT FROM 'true'
      OR o->>'block_hash' IS DISTINCT FROM encode(r.block_hash,'hex')
      OR (o->>'block_height')::bigint IS DISTINCT FROM r.block_height
      OR tip<r.block_height+2 OR o->>'is_change' IS DISTINCT FROM 'false'
      OR o->>'receiver_verified' IS DISTINCT FROM 'true' OR o->>'key_scope' IS DISTINCT FROM '0'
      OR o->>'ticket_id' IS DISTINCT FROM r.ticket_id OR o->>'receiver_ref' IS DISTINCT FROM r.receiver_ref
      OR NOT EXISTS(SELECT 1 FROM darkpool_private.tickets v WHERE v.id=r.ticket_id
       AND v.diversifier_ref=o->>'diversifier_ref' AND encode(v.claim_commitment,'hex')=o->>'journal_commitment')
      OR NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence inclusion WHERE inclusion.id=r.chain_evidence_ref
       AND inclusion.details->>'time'=o->>'block_time' AND inclusion.details->>'tx_index'=o->>'tx_index')
      THEN note_reason:='CANONICAL_CONTRADICTION'; END IF;
    END IF;
   END IF;
   IF note_reason IS NOT NULL THEN reason:=note_reason; conflicts:=conflicts||jsonb_build_array(o); END IF;
  END LOOP;
 END IF;
 IF reason IS NOT NULL THEN
  evidence_id:='hold:'||rid;
  INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'HOLD',NULL,NULL,NULL,NULL,
   jsonb_build_object('reason',reason,'chain',(request->'chain')-'mtp_blocks','conflicting_outputs',conflicts),clock_timestamp());
  result:=jsonb_build_object('result','HELD','revision',(s.revision+1)::text);
  INSERT INTO darkpool_private.watcher_evidence VALUES(eid,m.id,'RECONCILIATION',NULL,evidence_id,rid,digest,
   jsonb_build_object('result',result,'mode',mode),clock_timestamp());
  UPDATE darkpool_private.watcher_state SET hold_ref=coalesce(hold_ref,evidence_id),revision=revision+1 WHERE market_id=m.id;
  RETURN result;
 END IF;

 FOR o IN SELECT value FROM jsonb_array_elements(request->'outputs') LOOP
  row_id:='note:testnet:'||(o->>'txid')||':'||(o->>'pool')||':'||(o->>'output_index');
  SELECT * INTO r FROM darkpool_private.payment_receipts WHERE id=row_id;
  mapped:=false;
  SELECT * INTO t FROM darkpool_private.tickets WHERE market_id=m.id AND receiver_ref=o->>'receiver_ref'
   AND diversifier_ref=o->>'diversifier_ref' AND id=o->>'ticket_id'
   AND encode(claim_commitment,'hex')=o->>'journal_commitment'
   AND EXISTS(SELECT 1 FROM darkpool_private.issuance_attempts a WHERE a.ticket_id=tickets.id AND a.state='ISSUED'
    AND a.market_id=tickets.market_id AND a.vault_context_ref=tickets.vault_context_ref
    AND a.commitment=tickets.claim_commitment AND a.side=tickets.side AND a.requested_amount_zat=tickets.requested_amount_zat);
  mapped:=coalesce(FOUND AND o->>'receiver_verified'='true' AND o->>'key_scope'='0' AND o->>'is_change'='false'
   AND o->>'pool' IN ('ORCHARD','IRONWOOD'),false);
  IF NOT mapped THEN
   evidence_id:='unmapped:'||encode(sha256(convert_to(row_id||o::text,'UTF8')),'hex');
   INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'OBSERVATION',NULL,NULL,NULL,NULL,
    jsonb_build_object('classification','UNMAPPED','output',o),clock_timestamp()) ON CONFLICT(id) DO NOTHING;
   CONTINUE;
  END IF;
  IF r.id IS NOT NULL AND r.ticket_id IS NOT NULL AND r.ticket_id<>t.id THEN
   RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='retained mapping conflict'; END IF;
  IF r.id IS NULL THEN
   INSERT INTO darkpool_private.payment_receipts VALUES(row_id,m.id,m.vault_context_ref,'testnet',row_id,
    decode(o->>'txid','hex'),o->>'pool',(o->>'output_index')::bigint,t.id,t.receiver_ref,(o->>'amount_zat')::numeric,
    NULL,NULL,NULL,'phase9-observed',clock_timestamp());
  END IF;
  IF mode='observe_only' THEN
   evidence_id:='observed:'||encode(sha256(convert_to(row_id||o::text,'UTF8')),'hex');
   INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'OBSERVATION',row_id,NULL,NULL,NULL,
    jsonb_build_object('classification','UNVERIFIED','output',o),clock_timestamp()) ON CONFLICT(id) DO NOTHING;
   CONTINUE;
  END IF;
  accepted:=EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts WHERE receipt_id=row_id);
  IF accepted THEN CONTINUE; END IF;
  h:=NULL; tm:=NULL; idx:=NULL;
  IF o->>'canonical'='true' AND o->>'present'='true' THEN
   IF NOT coalesce(o->>'block_height' ~ '^[0-9]{1,10}$',false) OR NOT coalesce(o->>'block_hash' ~ '^[0-9a-f]{64}$',false)
    OR NOT coalesce(o->>'block_time' ~ '^[0-9]{1,10}$',false) OR NOT coalesce(o->>'tx_index' ~ '^[0-9]{1,10}$',false) THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='missing output inclusion'; END IF;
   h:=(o->>'block_height')::bigint; tm:=(o->>'block_time')::bigint; idx:=(o->>'tx_index')::bigint;
   IF h>tip OR idx>4294967295 OR tm>4294967295 OR h<s.anchor_height THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='output outside verified coverage'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'mtp_blocks') x WHERE (x->>'height')::bigint=h
    AND x->>'hash'=o->>'block_hash' AND x->>'time'=o->>'block_time') THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='output inclusion inconsistent'; END IF;
  END IF;
  classification:=CASE WHEN h IS NULL AND o->>'present'='true' THEN 'pending' WHEN h IS NULL THEN 'orphan'
   WHEN tm::numeric*1000000>=extract(epoch FROM m.closes_at)*1000000 THEN 'late'
   WHEN (o->>'amount_zat')::numeric<t.requested_amount_zat THEN 'under'
   WHEN (o->>'amount_zat')::numeric>t.requested_amount_zat THEN 'over'
   ELSE 'candidate' END;
  evidence_id:='inclusion:'||encode(sha256(convert_to(row_id||o::text,'UTF8')),'hex');
  INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'INCLUSION',row_id,NULL,NULL,NULL,
   jsonb_build_object('classification',classification,'height',h,'hash',o->>'block_hash','time',tm,'tx_index',idx),clock_timestamp()) ON CONFLICT(id) DO NOTHING;
  UPDATE darkpool_private.payment_receipts SET ticket_id=t.id,block_height=h,
   block_hash=CASE WHEN h IS NULL THEN NULL ELSE decode(o->>'block_hash','hex') END,
   chain_evidence_ref=evidence_id,status_policy_ref='phase9-'||classification WHERE id=row_id;
  IF classification IN ('late','under','over') THEN
   INSERT INTO darkpool_private.payment_liabilities VALUES('principal:'||row_id,m.id,row_id,t.id,(o->>'amount_zat')::numeric,
    'phase9-principal-unresolved','phase9-'||classification,clock_timestamp()) ON CONFLICT(receipt_id) DO UPDATE SET state_policy_ref=EXCLUDED.state_policy_ref;
  END IF;
  UPDATE darkpool_private.payment_liabilities SET state_policy_ref='phase9-'||classification WHERE receipt_id=row_id;
 END LOOP;

 IF mode='snapshot' AND s.hold_ref IS NULL AND m.status='OPEN'
  AND NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_sets WHERE market_id=m.id AND frozen_at IS NOT NULL) THEN
  FOR t IN SELECT * FROM darkpool_private.tickets WHERE market_id=m.id AND accepted_amount_zat=0 ORDER BY id FOR UPDATE LOOP
   SELECT p.* INTO r FROM darkpool_private.payment_receipts p JOIN darkpool_private.watcher_evidence e ON e.id=p.chain_evidence_ref
    WHERE p.market_id=m.id AND p.ticket_id=t.id AND p.status_policy_ref='phase9-candidate'
    ORDER BY p.block_height,(e.details->>'tx_index')::bigint,
      CASE p.value_pool WHEN 'SAPLING' THEN 2 WHEN 'ORCHARD' THEN 3 WHEN 'IRONWOOD' THEN 4 END,p.output_index LIMIT 1;
   IF FOUND AND tip>=r.block_height+2 THEN
    group_id:='accepted:'||t.id;
    INSERT INTO darkpool_private.accepted_payments VALUES(group_id,m.id,t.id,s.profile_ref);
    INSERT INTO darkpool_private.accepted_payment_receipts VALUES(group_id,m.id,t.id,r.id);
    INSERT INTO darkpool_private.watcher_evidence VALUES('acceptance:'||t.id,m.id,'ACCEPTANCE',r.id,NULL,NULL,NULL,
     jsonb_build_object('group_id',group_id,'profile',s.profile_ref,'containing',
      (SELECT details FROM darkpool_private.watcher_evidence WHERE id=r.chain_evidence_ref),
      'chain',c-'mtp_blocks','request_id',rid,'ordering','height,tx_index,pool_code,output_index'),clock_timestamp());
    UPDATE darkpool_private.tickets SET payment_state='CONFIRMED',accepted_amount_zat=requested_amount_zat,
     accepted_payment_ref=group_id,accepted_at=clock_timestamp() WHERE id=t.id;
    INSERT INTO darkpool_private.audit_events VALUES('confirmed:'||t.id,1,m.id,'TICKET_CONFIRMED',clock_timestamp(),
     session_user,group_id,NULL,NULL,'acceptance:'||t.id);
    UPDATE darkpool_private.payment_liabilities SET state_policy_ref='phase9-accepted' WHERE receipt_id=r.id;
   END IF;
  END LOOP;
 END IF;
 IF mode='snapshot' THEN
  FOR r IN SELECT p.* FROM darkpool_private.payment_receipts p JOIN darkpool_private.tickets ticket_row ON ticket_row.id=p.ticket_id
   WHERE p.market_id=m.id AND ticket_row.accepted_amount_zat>0 AND NOT EXISTS
    (SELECT 1 FROM darkpool_private.accepted_payment_receipts a WHERE a.receipt_id=p.id) LOOP
   INSERT INTO darkpool_private.payment_liabilities VALUES('principal:'||r.id,m.id,r.id,r.ticket_id,r.amount_zat,
    'phase9-principal-unresolved',CASE WHEN r.status_policy_ref IN ('phase9-orphan','phase9-pending') THEN r.status_policy_ref ELSE 'phase9-additional' END,clock_timestamp())
     ON CONFLICT(receipt_id) DO UPDATE SET state_policy_ref=EXCLUDED.state_policy_ref;
  END LOOP;
  IF boundary IS NOT NULL THEN
   evidence_id:='boundary:'||rid;
   INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'BOUNDARY',NULL,NULL,NULL,NULL,
    jsonb_build_object('height',boundary,'close_height',boundary-1,'window',
     (SELECT jsonb_agg(x) FROM jsonb_array_elements(c->'mtp_blocks') x WHERE (x->>'height')::bigint BETWEEN boundary-11 AND boundary),
     'tip_height',tip,'tip_hash',c->>'tip_hash','algorithm','preceding-11-first-crossing-v1'),clock_timestamp());
  END IF;
 END IF;
 result:=jsonb_build_object('result',CASE WHEN s.hold_ref IS NOT NULL THEN 'HELD' WHEN mode='observe_only' THEN 'RETAINED' ELSE 'RECONCILED' END,
  'revision',(s.revision+1)::text);
 INSERT INTO darkpool_private.watcher_evidence VALUES(eid,m.id,'RECONCILIATION',NULL,NULL,rid,digest,
  jsonb_build_object('result',result,'mode',mode,'chain',c-'mtp_blocks'),clock_timestamp());
 UPDATE darkpool_private.watcher_state SET revision=revision+1,
  checkpoint_ref=CASE WHEN mode='snapshot' AND hold_ref IS NULL THEN eid ELSE checkpoint_ref END WHERE market_id=m.id;
 RETURN result;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA darkpool_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_watcher FROM PUBLIC;

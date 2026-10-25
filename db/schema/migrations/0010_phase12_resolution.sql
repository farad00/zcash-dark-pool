-- Authenticated manual review + atomic private economic authorization.
-- No keys, accounts, EXTERNAL trust, roles, market adoption or wallet authority.
CREATE SCHEMA darkpool_resolution;
REVOKE ALL ON SCHEMA darkpool_resolution FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_resolution REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
INSERT INTO darkpool_private.policy_refs VALUES
 ('phase12-external-subsidy-entitlements-v1','PINNED',NULL,'approved-durable-resolution-external-subsidy')
 ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.policy_refs WHERE id='phase12-external-subsidy-entitlements-v1'
  AND status='PINNED' AND reviewed_profile_ref='approved-durable-resolution-external-subsidy') THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='economic authorization profile conflict'; END IF;
END $$;

CREATE TABLE darkpool_private.oracle_authorities (
 market_id text PRIMARY KEY REFERENCES darkpool_private.markets,
 oracle_login name NOT NULL, coordinator_login name NOT NULL CHECK(oracle_login<>coordinator_login),
 actor_ref text NOT NULL CHECK(length(actor_ref)>0),
 execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 rule jsonb NOT NULL, observation_at text NOT NULL, resources jsonb NOT NULL,
 database_oid oid NOT NULL, system_identifier text NOT NULL, cluster_id text,
 registered_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.oracle_approvals (
 request_key text COLLATE "C" PRIMARY KEY,
 market_id text NOT NULL UNIQUE REFERENCES darkpool_private.oracle_authorities,
 request jsonb NOT NULL, publication_receipt_id text NOT NULL,
 resolution jsonb NOT NULL, oracle_login name NOT NULL, approved_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.resolution_results (
 market_id text PRIMARY KEY REFERENCES darkpool_private.markets,
 request_key text NOT NULL UNIQUE REFERENCES darkpool_private.oracle_approvals,
 resolution_id text NOT NULL UNIQUE REFERENCES darkpool_private.resolutions,
 ledger_root bytea NOT NULL CHECK(octet_length(ledger_root)=32),
 publication_receipt_id text NOT NULL REFERENCES darkpool_private.ledger_publication_receipts(receipt_id),
 execution_class text NOT NULL CHECK(execution_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 preparation jsonb NOT NULL, response jsonb NOT NULL,
 authorized_by name NOT NULL, authorized_at timestamptz NOT NULL,
 spending_authorized boolean NOT NULL CHECK(NOT spending_authorized)
 ,FOREIGN KEY(market_id,resolution_id) REFERENCES darkpool_private.resolutions(market_id,id)
);
CREATE TABLE darkpool_private.resolution_entitlements (
 market_id text NOT NULL REFERENCES darkpool_private.resolution_results DEFERRABLE INITIALLY DEFERRED,
 ticket_id text NOT NULL UNIQUE,
 entitlement_id text NOT NULL UNIQUE REFERENCES darkpool_private.entitlements,
 winning_payout_zat darkpool_private.zatoshi NOT NULL,
 refund_zat darkpool_private.zatoshi NOT NULL,
 PRIMARY KEY(market_id,ticket_id),
 FOREIGN KEY(market_id,ticket_id,entitlement_id) REFERENCES darkpool_private.entitlements(market_id,ticket_id,id),
 CHECK(winning_payout_zat=0 OR refund_zat=0)
);
REVOKE ALL ON darkpool_private.oracle_authorities,darkpool_private.oracle_approvals,
 darkpool_private.resolution_results,darkpool_private.resolution_entitlements FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['oracle_authorities','oracle_approvals','resolution_results','resolution_entitlements'] LOOP
  EXECUTE format('CREATE TRIGGER resolution_immutable BEFORE UPDATE OR DELETE ON darkpool_private.%I FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER resolution_no_truncate BEFORE TRUNCATE ON darkpool_private.%I FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION darkpool_resolution.test_scope(a darkpool_private.oracle_authorities) RETURNS boolean
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE marker jsonb;
BEGIN
 marker:=shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database')::jsonb;
 RETURN coalesce(a.execution_class='SYNTHETIC_TEST'
  AND current_database() ~ '^darkpool_phase9_[0-9a-f]{16}$'
  AND (SELECT oid FROM pg_database WHERE datname=current_database())=a.database_oid
  AND (SELECT system_identifier::text FROM pg_control_system())=a.system_identifier
  AND marker->>'kind'='TEST' AND marker->>'system_identifier'=a.system_identifier
  AND marker->>'cluster_id'=a.cluster_id AND (marker->>'port')::integer=inet_server_port(),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION darkpool_resolution.register_authority() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m darkpool_private.markets; marker jsonb;
BEGIN
 SELECT * INTO STRICT m FROM darkpool_private.markets WHERE id=NEW.market_id FOR UPDATE;
 IF m.status<>'DRAFT' OR NEW.rule IS DISTINCT FROM jsonb_build_object('question',m.question,
  'yes_definition',m.yes_definition,'no_definition',m.no_definition,'resolution_rule',m.resolution_rule,
  'resolution_sources',m.resolution_sources,'void_conditions',m.void_conditions,'rule_version',NEW.rule->>'rule_version')
 OR length(coalesce(NEW.rule->>'rule_version',''))=0
 OR NEW.observation_at !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$'
 OR position(NEW.observation_at in m.resolution_rule)=0
 OR (NEW.observation_at)::timestamptz<m.closes_at
 OR m.fee_policy_ref<>'phase9-zero-platform-fee-v1'
 OR m.zero_winner_policy<>'NO_WINNER_REFUND' THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='pre-open objective oracle profile required'; END IF;
 NEW.database_oid:=(SELECT oid FROM pg_database WHERE datname=current_database());
 NEW.system_identifier:=(SELECT system_identifier::text FROM pg_control_system());
 marker:=shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database')::jsonb;
 NEW.cluster_id:=marker->>'cluster_id'; NEW.registered_at:=clock_timestamp();
 IF NEW.execution_class='SYNTHETIC_TEST' AND NOT darkpool_resolution.test_scope(NEW) THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='isolated physical TEST scope required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER oracle_registration BEFORE INSERT ON darkpool_private.oracle_authorities
 FOR EACH ROW EXECUTE FUNCTION darkpool_resolution.register_authority();

CREATE FUNCTION darkpool_resolution.authorize(mid text,coordinator boolean) RETURNS darkpool_private.oracle_authorities
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.oracle_authorities;
BEGIN
 PERFORM darkpool_lock.authorize();
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('darkpool_publication','darkpool_resolution')
  AND pg_has_role(session_user,nspowner,'MEMBER')) THEN
  RAISE EXCEPTION USING ERRCODE='P1202',MESSAGE='restricted resolution login required'; END IF;
 SELECT * INTO a FROM darkpool_private.oracle_authorities WHERE market_id=mid
  AND CASE WHEN coordinator THEN coordinator_login=session_user ELSE oracle_login=session_user END;
 IF NOT FOUND OR (a.execution_class='SYNTHETIC_TEST' AND NOT darkpool_resolution.test_scope(a)) THEN
  RAISE EXCEPTION USING ERRCODE='P1202',MESSAGE='manual oracle capability unavailable'; END IF;
 RETURN a;
END $$;

CREATE FUNCTION darkpool_resolution.publication(mid text,a darkpool_private.oracle_authorities) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r darkpool_private.ledger_publication_receipts; p darkpool_private.publication_policies;
BEGIN
 SELECT * INTO r FROM darkpool_private.ledger_publication_receipts WHERE market_id=mid;
 SELECT * INTO p FROM darkpool_private.publication_policies WHERE policy_ref=r.policy_ref;
 IF r.market_id IS NULL OR p.policy_ref IS NULL
 OR r.merkle_root IS DISTINCT FROM (SELECT merkle_root FROM darkpool_private.ledger_commitments WHERE market_id=mid)
 OR r.verified_by IS DISTINCT FROM p.verifier_login OR p.database_name<>current_database()
 OR r.verification_profile<>'DARKPOOL_PUBLICATION_GIT_WITNESS_RFC3161_V1'
 OR r.evidence_class IS DISTINCT FROM a.execution_class OR p.evidence_class IS DISTINCT FROM a.execution_class
 OR (a.execution_class='SYNTHETIC_TEST' AND NOT darkpool_resolution.test_scope(a)) THEN
  RAISE EXCEPTION USING ERRCODE='P1105',MESSAGE='matching independent publication required'; END IF;
 RETURN r.receipt_id;
END $$;

CREATE FUNCTION darkpool_resolution.lock_context(mid text) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR current_setting('synchronous_commit')<>'on' THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='serializable durable transaction required'; END IF;
 PERFORM pg_advisory_xact_lock(1146110284,4);
 PERFORM 1 FROM darkpool_private.markets WHERE id=mid FOR UPDATE;
 PERFORM 1 FROM darkpool_private.admin_revisions WHERE market_id=mid FOR UPDATE;
 PERFORM 1 FROM darkpool_private.watcher_state WHERE market_id=mid FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM darkpool_private.watcher_state WHERE market_id=mid AND hold_ref IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='reconciled market without safety hold required'; END IF;
END $$;

CREATE FUNCTION darkpool_resolution.approve(q jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.oracle_authorities; prior darkpool_private.oracle_approvals;
        m darkpool_private.markets; rid text; resolution jsonb; stamp timestamptz;
BEGIN
 IF q IS NULL OR jsonb_typeof(q)<>'object' OR octet_length(q::text)>65536
 OR (SELECT count(*) FROM jsonb_object_keys(q))<>10
 OR NOT(q ?& ARRAY['request_key','market_id','expected_revision','expected_root','resolution_id','outcome','evidence','rule_version','review','authorize_entitlements'])
 OR EXISTS(SELECT 1 FROM jsonb_each(q) kv WHERE kv.key NOT IN ('evidence','review','authorize_entitlements') AND jsonb_typeof(kv.value)<>'string')
 OR NOT coalesce(q->>'request_key' ~ '^[A-Za-z0-9_-]{1,128}$',false)
 OR NOT coalesce(q->>'resolution_id' ~ '^[A-Za-z0-9_-]{1,128}$',false)
 OR NOT coalesce(q->>'expected_revision' ~ '^[1-9][0-9]{0,18}$',false)
 OR NOT coalesce(q->>'expected_root' ~ '^[0-9a-f]{64}$',false)
 OR q->>'outcome' NOT IN ('YES','NO','VOID') OR q->'authorize_entitlements' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(q->'evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(q->'evidence')=0
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'evidence') e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}')=0)
 OR (SELECT count(*)<>count(DISTINCT e) FROM jsonb_array_elements(q->'evidence') e)
 OR jsonb_typeof(q->'review') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(q->'review'))<>4
 OR NOT(q->'review' ?& ARRAY['decision','source_ref','observation_at','rationale'])
 OR EXISTS(SELECT 1 FROM jsonb_each(q->'review') kv WHERE jsonb_typeof(kv.value)<>'string' OR length(kv.value#>>'{}')=0)
 OR q#>>'{review,decision}' NOT IN ('DEFENSIBLE','AMBIGUOUS')
 OR (q#>>'{review,decision}'='AMBIGUOUS' AND q->>'outcome'<>'VOID') THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='invalid manual oracle review'; END IF;
 a:=darkpool_resolution.authorize(q->>'market_id',false);
 PERFORM darkpool_resolution.lock_context(a.market_id);
 rid:=darkpool_resolution.publication(a.market_id,a);
 IF q->>'rule_version' IS DISTINCT FROM a.rule->>'rule_version'
 OR NOT(a.rule->'resolution_sources' ? (q#>>'{review,source_ref}'))
 OR q#>>'{review,observation_at}' IS DISTINCT FROM a.observation_at
 OR clock_timestamp()<(a.observation_at)::timestamptz THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='objective rule review mismatch'; END IF;
 SELECT * INTO prior FROM darkpool_private.oracle_approvals WHERE market_id=a.market_id OR request_key=q->>'request_key';
 IF FOUND THEN
  IF prior.request IS DISTINCT FROM q OR prior.publication_receipt_id<>rid OR prior.oracle_login<>session_user THEN
   RAISE EXCEPTION USING ERRCODE='P1203',MESSAGE='oracle review conflict'; END IF;
  RETURN jsonb_build_object('result','ORACLE_APPROVAL_RECORDED','request_key',prior.request_key,'execution_class',a.execution_class);
 END IF;
 SELECT * INTO STRICT m FROM darkpool_private.markets WHERE id=a.market_id;
 IF m.status<>'LOCKED' OR m.closes_at>clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.lock_requests WHERE market_id=m.id)
 OR q->>'expected_root' IS DISTINCT FROM (SELECT encode(merkle_root,'hex') FROM darkpool_private.ledger_commitments WHERE market_id=m.id)
 OR q->>'expected_revision' IS DISTINCT FROM (SELECT revision::text FROM darkpool_private.admin_revisions WHERE market_id=m.id)
 OR (a.rule - 'rule_version') IS DISTINCT FROM jsonb_build_object('question',m.question,'yes_definition',m.yes_definition,
  'no_definition',m.no_definition,'resolution_rule',m.resolution_rule,'resolution_sources',m.resolution_sources,'void_conditions',m.void_conditions) THEN
  RAISE EXCEPTION USING ERRCODE='P1204',MESSAGE='locked context revision or rules mismatch'; END IF;
 stamp:=clock_timestamp();
 resolution:=jsonb_build_object('version',1,'network','testnet','market_id',m.id,'outcome',q->>'outcome',
  'resolved_at',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'evidence',q->'evidence','rule_version',a.rule->>'rule_version','actor',a.actor_ref);
 INSERT INTO darkpool_private.oracle_approvals VALUES(q->>'request_key',m.id,q,rid,resolution,session_user,stamp);
 RETURN jsonb_build_object('result','ORACLE_APPROVAL_RECORDED','request_key',q->>'request_key','execution_class',a.execution_class);
END $$;

CREATE FUNCTION darkpool_resolution.begin_resolution(key text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.oracle_authorities; approval darkpool_private.oracle_approvals;
        saved darkpool_private.resolution_results; rid text;
BEGIN
 SELECT * INTO approval FROM darkpool_private.oracle_approvals WHERE request_key=key;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1202',MESSAGE='authenticated oracle approval required'; END IF;
 a:=darkpool_resolution.authorize(approval.market_id,true);
 PERFORM darkpool_resolution.lock_context(a.market_id);
 rid:=darkpool_resolution.publication(a.market_id,a);
 IF rid IS DISTINCT FROM approval.publication_receipt_id
 OR approval.request->>'expected_root' IS DISTINCT FROM (SELECT encode(merkle_root,'hex') FROM darkpool_private.ledger_commitments WHERE market_id=a.market_id) THEN
  RAISE EXCEPTION USING ERRCODE='P1204',MESSAGE='sealed oracle approval binding mismatch'; END IF;
 SELECT * INTO saved FROM darkpool_private.resolution_results WHERE market_id=a.market_id;
 IF FOUND THEN
  IF saved.request_key<>key THEN RAISE EXCEPTION USING ERRCODE='P1203',MESSAGE='resolution retry conflict'; END IF;
 ELSE
  IF (SELECT status FROM darkpool_private.markets WHERE id=a.market_id)<>'LOCKED'
  OR approval.request->>'expected_revision' IS DISTINCT FROM (SELECT revision::text FROM darkpool_private.admin_revisions WHERE market_id=a.market_id)
  OR EXISTS(SELECT 1 FROM darkpool_private.resolutions WHERE market_id=a.market_id)
  OR EXISTS(SELECT 1 FROM darkpool_private.entitlements WHERE market_id=a.market_id AND kind='ACCEPTED_STAKE') THEN
   RAISE EXCEPTION USING ERRCODE='P1204',MESSAGE='resolution context conflict'; END IF;
 END IF;
 PERFORM set_config('darkpool_resolution.context',jsonb_build_object('key',key,'market_id',a.market_id,'xid',pg_current_xact_id()::text)::text,true);
 RETURN jsonb_build_object('authority',jsonb_build_object('rule',a.rule,'resources',a.resources,'execution_class',a.execution_class,
  'actor_ref',a.actor_ref,'oracle_login',a.oracle_login,'observation_at',a.observation_at),
  'approval',to_jsonb(approval),'seal',darkpool_lock.snapshot(a.market_id),
  'saved',CASE WHEN saved.market_id IS NOT NULL THEN to_jsonb(saved) ELSE NULL END,
  'stored_entitlements',coalesce((SELECT jsonb_agg(jsonb_build_object('ticket_id',e.ticket_id,
    'winning_payout_zat',e.winning_payout_zat::text,'refund_zat',e.refund_zat::text,'amount_zat',t.amount_zat::text)
    ORDER BY e.ticket_id COLLATE "C") FROM darkpool_private.resolution_entitlements e
    JOIN darkpool_private.entitlements t ON t.id=e.entitlement_id WHERE e.market_id=a.market_id),'[]'::jsonb));
END $$;

CREATE FUNCTION darkpool_resolution.finish_resolution(key text,prepared jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d jsonb; a darkpool_private.oracle_authorities; approval darkpool_private.oracle_approvals;
        c jsonb; ent jsonb; mid text; eid text; total numeric; stamp timestamptz; rev bigint; first_state text; target_state text; response jsonb;
BEGIN
 d:=darkpool_resolution.begin_resolution(key); mid:=d#>>'{approval,market_id}';
 SELECT * INTO STRICT a FROM darkpool_private.oracle_authorities WHERE market_id=mid;
 SELECT * INTO STRICT approval FROM darkpool_private.oracle_approvals WHERE request_key=key;
 IF d->'saved'<>'null'::jsonb THEN
  IF d#>'{saved,preparation}' IS DISTINCT FROM prepared THEN RAISE EXCEPTION USING ERRCODE='P1203',MESSAGE='prepared result conflict'; END IF;
  RETURN d#>'{saved,response}'; END IF;
 c:=prepared->'calculation';
 IF prepared->>'kind' IS DISTINCT FROM 'PRIVATE_PREPARATION_ONLY' OR prepared->'lifecycle_authorized' IS DISTINCT FROM 'false'::jsonb
 OR prepared#>>'{binding,request_key}' IS DISTINCT FROM key
 OR prepared#>>'{binding,revision}' IS DISTINCT FROM approval.request->>'expected_revision'
 OR prepared#>'{binding,context}' IS DISTINCT FROM d#>'{seal,context}'
 OR prepared#>'{binding,commitment}' IS DISTINCT FROM d#>'{seal,response,commitment}'
 OR prepared#>'{binding,resolution}' IS DISTINCT FROM approval.resolution
 OR prepared#>'{binding,oracle_rule}' IS DISTINCT FROM a.rule
 OR prepared#>>'{binding,policy,fee_mode}' IS DISTINCT FROM 'EXTERNALLY_SUBSIDIZED'
 OR c->>'outcome' IS DISTINCT FROM approval.resolution->>'outcome'
 OR c->>'mode' NOT IN ('EMPTY','WINNING_PAYOUT','NO_WINNER_REFUND','VOID_REFUND')
 OR jsonb_typeof(c->'entitlements') IS DISTINCT FROM 'array'
 OR jsonb_array_length(c->'entitlements')<>(SELECT count(*) FROM darkpool_private.ledger_records WHERE market_id=mid) THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='prepared resolution binding mismatch'; END IF;
 total:=(SELECT coalesce(sum(accepted_amount_zat),0) FROM darkpool_private.ledger_records WHERE market_id=mid);
 IF (c->>'total_accepted_zat')::numeric<>total OR (c->>'distributable_pool_zat')::numeric<>total
 OR (c->>'total_winning_payout_zat')::numeric+(c->>'total_refund_zat')::numeric<>total
 OR (SELECT coalesce(sum((e->>'winning_payout_zat')::numeric+(e->>'refund_zat')::numeric),0) FROM jsonb_array_elements(c->'entitlements') e)<>total
 OR (SELECT count(*)<>count(DISTINCT e->>'ticket_id') FROM jsonb_array_elements(c->'entitlements') e) THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='entitlement conservation failure'; END IF;
 stamp:=clock_timestamp();
 INSERT INTO darkpool_private.resolutions VALUES(approval.request->>'resolution_id',mid,1,approval.resolution->>'outcome',
  ARRAY(SELECT jsonb_array_elements_text(approval.resolution->'evidence')),a.rule->>'rule_version',a.actor_ref,(approval.resolution->>'resolved_at')::timestamptz);
 FOR ent IN SELECT value FROM jsonb_array_elements(c->'entitlements') LOOP
  IF NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_records WHERE market_id=mid AND ticket_id=ent->>'ticket_id')
  OR (ent->>'winning_payout_zat')::numeric<0 OR (ent->>'refund_zat')::numeric<0 THEN
   RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='accepted ledger entitlement required'; END IF;
  eid:='resolution:'||(approval.request->>'resolution_id')||':'||(ent->>'ticket_id');
  INSERT INTO darkpool_private.entitlements VALUES(eid,mid,ent->>'ticket_id','ACCEPTED_STAKE',NULL,
   'phase12-external-subsidy-entitlements-v1',(ent->>'winning_payout_zat')::numeric+(ent->>'refund_zat')::numeric);
  INSERT INTO darkpool_private.resolution_entitlements VALUES(mid,ent->>'ticket_id',eid,(ent->>'winning_payout_zat')::numeric,(ent->>'refund_zat')::numeric);
 END LOOP;
 first_state:=CASE WHEN approval.resolution->>'outcome'='VOID' THEN 'VOID' ELSE 'RESOLVED' END;
 -- NO_WINNER_REFUND is economic mode, not a new public state/edge. YES/NO
 -- follows RESOLVED->PAYING; its instructions will be refunds, not winner payouts.
 target_state:=CASE WHEN first_state='VOID' THEN 'REFUNDING' ELSE 'PAYING' END;
 UPDATE darkpool_private.admin_revisions SET revision=revision+1 WHERE market_id=mid RETURNING revision INTO rev;
 response:=jsonb_build_object('result','RESOLUTION_RECORDED','market_id',mid,'resolution_id',approval.request->>'resolution_id',
  'merkle_root',approval.request->>'expected_root','outcome',approval.resolution->>'outcome',
  'recorded_state',target_state,'revision',rev::text,'execution_class',a.execution_class,'spending_authorized',false);
 INSERT INTO darkpool_private.resolution_results VALUES(mid,key,approval.request->>'resolution_id',decode(approval.request->>'expected_root','hex'),
  approval.publication_receipt_id,a.execution_class,prepared,response,session_user,stamp,false);
 UPDATE darkpool_private.markets SET status=first_state,updated_at=stamp WHERE id=mid;
 INSERT INTO darkpool_private.audit_events VALUES('resolution:'||key||':oracle',1,mid,
  CASE WHEN first_state='VOID' THEN 'MARKET_VOIDED' ELSE 'MARKET_RESOLVED' END,stamp,approval.oracle_login,key,'LOCKED',first_state,NULL);
 UPDATE darkpool_private.markets SET status=target_state,updated_at=stamp WHERE id=mid;
 INSERT INTO darkpool_private.audit_events VALUES('resolution:'||key||':entitlements',1,mid,'ENTITLEMENTS_AUTHORIZED',stamp,session_user,key,first_state,target_state,NULL);
 RETURN response;
END $$;

-- Synthetic insertion exception is limited to authenticated new resolution RPCs
-- on a physically fenced disposable TEST scope. Wallet settlement tables retain
-- the EXTERNAL-only publication rule; there is no generic synthetic gate flag.
CREATE OR REPLACE FUNCTION darkpool_lock.publication_gate() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.oracle_authorities; ctx jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM darkpool_private.lock_requests WHERE market_id=NEW.market_id) THEN
  IF EXISTS(SELECT 1 FROM darkpool_private.ledger_publication_receipts r JOIN darkpool_private.publication_policies p ON p.policy_ref=r.policy_ref
   WHERE r.market_id=NEW.market_id AND r.evidence_class='EXTERNAL' AND p.evidence_class='EXTERNAL') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='resolutions' AND TG_OP='INSERT' THEN
   a:=darkpool_resolution.authorize(NEW.market_id,true);
   ctx:=current_setting('darkpool_resolution.context',true)::jsonb;
   IF darkpool_resolution.test_scope(a) AND ctx->>'market_id'=NEW.market_id
    AND ctx->>'xid'=pg_current_xact_id()::text
    AND EXISTS(SELECT 1 FROM darkpool_private.oracle_approvals WHERE request_key=ctx->>'key' AND request->>'resolution_id'=NEW.id) THEN
    PERFORM darkpool_resolution.publication(NEW.market_id,a); RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE='P1105',MESSAGE='independent external publication required';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION darkpool_resolution.lifecycle_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; r darkpool_private.resolution_results; a darkpool_private.oracle_authorities;
BEGIN
 IF NEW.status=OLD.status THEN RETURN NEW; END IF;
 SELECT * INTO r FROM darkpool_private.resolution_results WHERE market_id=NEW.id;
 IF r.market_id IS NOT NULL AND NEW.status='PAUSED'
  AND EXISTS(SELECT 1 FROM darkpool_private.watcher_state WHERE market_id=NEW.id AND hold_ref IS NOT NULL) THEN RETURN NEW; END IF;
 IF r.market_id IS NOT NULL AND NEW.status NOT IN ('RESOLVED','PAYING','VOID','REFUNDING') THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='authorized lifecycle continuation required'; END IF;
 IF r.market_id IS NULL AND NEW.status NOT IN ('RESOLVED','PAYING','REFUNDING') AND NOT(OLD.status='LOCKED' AND NEW.status='VOID') THEN RETURN NEW; END IF;
 a:=darkpool_resolution.authorize(NEW.id,true);
 ctx:=current_setting('darkpool_resolution.context',true)::jsonb;
 IF r.market_id IS NULL OR ctx->>'key' IS DISTINCT FROM r.request_key OR ctx->>'xid' IS DISTINCT FROM pg_current_xact_id()::text
 OR NOT((OLD.status='LOCKED' AND NEW.status='RESOLVED' AND r.response->>'outcome' IN ('YES','NO'))
  OR (OLD.status='LOCKED' AND NEW.status='VOID' AND r.response->>'outcome'='VOID')
  OR (OLD.status='RESOLVED' AND NEW.status='PAYING') OR (OLD.status='VOID' AND NEW.status='REFUNDING')) THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='authorized immutable entitlements required'; END IF;
 PERFORM darkpool_resolution.publication(NEW.id,a);
 RETURN NEW;
END $$;
CREATE TRIGGER resolution_lifecycle BEFORE UPDATE ON darkpool_private.markets FOR EACH ROW EXECUTE FUNCTION darkpool_resolution.lifecycle_guard();
CREATE FUNCTION darkpool_resolution.require_approval() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.oracle_authorities; approval darkpool_private.oracle_approvals; ctx jsonb;
BEGIN
 a:=darkpool_resolution.authorize(NEW.market_id,true);
 ctx:=current_setting('darkpool_resolution.context',true)::jsonb;
 SELECT * INTO approval FROM darkpool_private.oracle_approvals WHERE request_key=ctx->>'key' AND market_id=NEW.market_id;
 IF approval.market_id IS NULL OR ctx->>'xid' IS DISTINCT FROM pg_current_xact_id()::text
 OR NEW.id IS DISTINCT FROM approval.request->>'resolution_id' OR NEW.outcome IS DISTINCT FROM approval.resolution->>'outcome'
 OR NEW.actor IS DISTINCT FROM a.actor_ref OR NEW.rule_version IS DISTINCT FROM a.rule->>'rule_version'
 OR to_jsonb(NEW.evidence) IS DISTINCT FROM approval.resolution->'evidence'
 OR NEW.resolved_at IS DISTINCT FROM (approval.resolution->>'resolved_at')::timestamptz THEN
  RAISE EXCEPTION USING ERRCODE='P1202',MESSAGE='authenticated bound oracle approval required'; END IF;
 PERFORM darkpool_resolution.publication(NEW.market_id,a);
 RETURN NEW;
END $$;
CREATE TRIGGER resolution_approved BEFORE INSERT ON darkpool_private.resolutions FOR EACH ROW EXECUTE FUNCTION darkpool_resolution.require_approval();
CREATE FUNCTION darkpool_resolution.protect_result() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (TG_TABLE_NAME='resolutions' AND EXISTS(SELECT 1 FROM darkpool_private.resolution_results WHERE resolution_id=OLD.id))
 OR (TG_TABLE_NAME='entitlements' AND EXISTS(SELECT 1 FROM darkpool_private.resolution_entitlements WHERE entitlement_id=OLD.id)) THEN
  RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='durable resolution result is immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER durable_resolution_immutable BEFORE UPDATE OR DELETE ON darkpool_private.resolutions FOR EACH ROW EXECUTE FUNCTION darkpool_resolution.protect_result();
CREATE TRIGGER durable_entitlement_immutable BEFORE UPDATE OR DELETE ON darkpool_private.entitlements FOR EACH ROW EXECUTE FUNCTION darkpool_resolution.protect_result();

ALTER TABLE darkpool_private.audit_events DROP CONSTRAINT audit_events_event_check;
ALTER TABLE darkpool_private.audit_events ADD CHECK(event IN ('MARKET_CREATED','MARKET_DRAFT_UPDATED','MARKET_OPENED','MARKET_PAUSED','MARKET_REOPENED',
 'MARKET_LOCK_FINALIZATION_STARTED','MARKET_LOCKED','LEDGER_COMMITTED','MARKET_RESOLVED','MARKET_VOIDED','TICKET_CONFIRMED','CLAIM_RESERVED',
 'SETTLEMENT_PLAN_CREATED','TX_AUTHORIZED','TX_BROADCAST','CLAIM_CONFIRMED','REFUND_CONFIRMED','ENTITLEMENTS_AUTHORIZED'));
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_resolution FROM PUBLIC;

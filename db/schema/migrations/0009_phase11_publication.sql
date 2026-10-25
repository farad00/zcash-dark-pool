-- Additive receipt boundary. No external service, account, role or policy is
-- provisioned by this migration. Cryptographic verification is performed by a
-- separately authenticated, trusted verifier, never by public JSON flags.
CREATE SCHEMA darkpool_publication;
REVOKE ALL ON SCHEMA darkpool_publication FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_publication REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM darkpool_private.ledger_publication_receipts) THEN
  RAISE EXCEPTION USING ERRCODE='P1190',MESSAGE='existing receipt requires independent review'; END IF;
END $$;
CREATE TABLE darkpool_private.publication_policies (
 policy_ref text COLLATE "C" PRIMARY KEY,
 verifier_login name NOT NULL UNIQUE,
 database_name name NOT NULL CHECK(database_name=current_database()),
 evidence_class text NOT NULL CHECK(evidence_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 trust jsonb NOT NULL CHECK(jsonb_typeof(trust)='object'),
 trust_sha256 bytea NOT NULL CHECK(octet_length(trust_sha256)=32),
 CHECK(trust->>'policy_ref'=policy_ref AND trust->>'status'='READY'
   AND trust->>'evidence_class'=evidence_class),
 CHECK(evidence_class<>'SYNTHETIC_TEST' OR database_name::text ~ '^darkpool_phase9_[0-9a-f]{16}$')
);
REVOKE ALL ON darkpool_private.publication_policies FROM PUBLIC;
CREATE TRIGGER publication_policies_immutable BEFORE UPDATE OR DELETE ON darkpool_private.publication_policies
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER publication_policies_no_truncate BEFORE TRUNCATE ON darkpool_private.publication_policies
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();

ALTER TABLE darkpool_private.ledger_publication_receipts
 ADD COLUMN receipt_id text NOT NULL UNIQUE CHECK(receipt_id ~ '^[0-9a-f]{64}$'),
 ADD COLUMN content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32),
 ADD COLUMN policy_ref text NOT NULL REFERENCES darkpool_private.publication_policies,
 ADD COLUMN evidence_class text NOT NULL CHECK(evidence_class IN ('EXTERNAL','SYNTHETIC_TEST')),
 ADD COLUMN timestamp_at timestamptz NOT NULL,
 ADD COLUMN verified_by name NOT NULL;

CREATE FUNCTION darkpool_publication.authorize() RETURNS darkpool_private.publication_policies
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p darkpool_private.publication_policies;
BEGIN
 PERFORM darkpool_lock.authorize();
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='darkpool_publication'
  AND pg_has_role(session_user,nspowner,'MEMBER')) THEN
  RAISE EXCEPTION USING ERRCODE='P1191',MESSAGE='restricted publication verifier required'; END IF;
 SELECT * INTO p FROM darkpool_private.publication_policies
  WHERE verifier_login=session_user AND database_name=current_database();
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1191',MESSAGE='publication verifier unavailable'; END IF;
 RETURN p;
END $$;

-- Safe, explicit projection; no ledger records, blindings, private lock context,
-- receiving mappings or admin/watcher history are returned to this role.
CREATE FUNCTION darkpool_publication.outbox(mid text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM darkpool_publication.authorize();
 RETURN (SELECT payload FROM darkpool_private.ledger_publication_outbox WHERE market_id=mid);
END $$;

-- Retain an INSERT guard even against accidental future table grants. A local
-- GUC alone is not authorization: the restricted login/profile must also match.
CREATE OR REPLACE FUNCTION darkpool_lock.reject_unverified_receipt() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p darkpool_private.publication_policies;
BEGIN
 p:=darkpool_publication.authorize();
 IF current_setting('darkpool_publication.insert',true) IS DISTINCT FROM
    (pg_current_xact_id()::text||':'||NEW.receipt_id)
 OR NEW.verified_by IS DISTINCT FROM session_user OR NEW.policy_ref IS DISTINCT FROM p.policy_ref
 OR NEW.evidence_class IS DISTINCT FROM p.evidence_class
 OR NEW.verification_profile<>'DARKPOOL_PUBLICATION_GIT_WITNESS_RFC3161_V1' THEN
  RAISE EXCEPTION USING ERRCODE='P1191',MESSAGE='verified insertion path required'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION darkpool_publication.persist(q jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p darkpool_private.publication_policies; payload jsonb; saved darkpool_private.ledger_publication_receipts;
        mid text; env bytea; retained jsonb; stamp timestamptz;
BEGIN
 p:=darkpool_publication.authorize();
 IF current_setting('transaction_isolation')<>'serializable' OR current_setting('synchronous_commit')<>'on' THEN
  RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='serializable durable transaction required'; END IF;
 IF q IS NULL OR jsonb_typeof(q)<>'object' OR octet_length(q::text)>1048576
 OR (SELECT count(*) FROM jsonb_object_keys(q))<>12
 OR NOT(q ?& ARRAY['receipt_id','market_id','merkle_root','content_sha256','envelope_hex','policy_ref',
  'trust_sha256','evidence_class','timestamp_at','receipt','receipt_hex','profile'])
 OR EXISTS(SELECT 1 FROM jsonb_each(q) kv WHERE kv.key<>'receipt' AND jsonb_typeof(kv.value)<>'string')
 OR jsonb_typeof(q->'receipt') IS DISTINCT FROM 'object'
 OR NOT coalesce(q->>'receipt_id' ~ '^[0-9a-f]{64}$',false)
 OR NOT coalesce(q->>'merkle_root' ~ '^[0-9a-f]{64}$',false)
 OR NOT coalesce(q->>'content_sha256' ~ '^[0-9a-f]{64}$',false)
 OR NOT coalesce(q->>'envelope_hex' ~ '^(?:[0-9a-f]{2})+$',false)
 OR length(q->>'envelope_hex')>131072
 OR NOT coalesce(q->>'receipt_hex' ~ '^(?:[0-9a-f]{2})+$',false)
 OR q->>'policy_ref' IS DISTINCT FROM p.policy_ref
 OR q->>'trust_sha256' IS DISTINCT FROM encode(p.trust_sha256,'hex')
 OR q->>'evidence_class' IS DISTINCT FROM p.evidence_class
 OR q->>'profile' IS DISTINCT FROM 'DARKPOOL_PUBLICATION_GIT_WITNESS_RFC3161_V1' THEN
  RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='invalid verified receipt'; END IF;
 mid:=q->>'market_id'; retained:=q->'receipt';
 IF convert_from(decode(q->>'receipt_hex','hex'),'UTF8')::jsonb IS DISTINCT FROM retained
 OR encode(sha256(decode(q->>'receipt_hex','hex')),'hex') IS DISTINCT FROM q->>'receipt_id'
 OR retained->>'profile' IS DISTINCT FROM q->>'profile' OR retained->'trust' IS DISTINCT FROM p.trust
 OR jsonb_typeof(retained->'evidence') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(retained))<>3
 OR NOT(retained->'evidence' ?& ARRAY['envelope','statement','signature','tsq','tsr'])
 OR (SELECT count(*) FROM jsonb_object_keys(retained->'evidence'))<>5
 OR jsonb_typeof(retained#>'{evidence,statement}') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(retained#>'{evidence,statement}'))<>12
 OR NOT(retained#>'{evidence,statement}' ?& ARRAY['profile','network','market_id','repository','path','commit',
   'git_blob_sha1','content_sha256','archive_url','observed_at','retention','evidence_class'])
 OR EXISTS(SELECT 1 FROM jsonb_each(retained->'evidence') kv WHERE kv.key<>'statement'
  AND (jsonb_typeof(kv.value)<>'string' OR length(kv.value#>>'{}')=0))
 OR retained#>>'{evidence,statement,profile}' IS DISTINCT FROM q->>'profile'
 OR retained#>>'{evidence,statement,market_id}' IS DISTINCT FROM mid
 OR retained#>>'{evidence,statement,network}' IS DISTINCT FROM 'testnet'
 OR retained#>>'{evidence,statement,repository}' IS DISTINCT FROM p.trust->>'repository'
 OR retained#>>'{evidence,statement,path}' IS DISTINCT FROM p.trust->>'path'
 OR retained#>>'{evidence,statement,evidence_class}' IS DISTINCT FROM p.evidence_class
 OR retained#>>'{evidence,statement,content_sha256}' IS DISTINCT FROM q->>'content_sha256' THEN
  RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='receipt policy binding mismatch'; END IF;
 -- Same market lock order as the finalizer; serializes publication with market progression.
 PERFORM pg_advisory_xact_lock(1146110284,4);
 PERFORM 1 FROM darkpool_private.markets WHERE id=mid AND network='testnet' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='sealed market required'; END IF;
 SELECT o.payload INTO payload FROM darkpool_private.ledger_publication_outbox o
 JOIN darkpool_private.lock_requests l ON l.market_id=o.market_id AND l.request_key=o.request_key
 JOIN darkpool_private.ledger_commitments c ON c.market_id=o.market_id
 WHERE o.market_id=mid AND c.merkle_root=decode(q->>'merkle_root','hex');
 env:=decode(q->>'envelope_hex','hex');
 IF payload IS NULL OR convert_from(env,'UTF8')::jsonb IS DISTINCT FROM payload
 OR encode(sha256(env),'hex') IS DISTINCT FROM q->>'content_sha256'
 OR decode(retained#>>'{evidence,envelope}','base64') IS DISTINCT FROM env THEN
  RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='sealed envelope mismatch'; END IF;
 SELECT * INTO saved FROM darkpool_private.ledger_publication_receipts WHERE market_id=mid;
 IF FOUND THEN
  IF saved.receipt_id IS DISTINCT FROM q->>'receipt_id' OR saved.receipt IS DISTINCT FROM retained
  OR saved.content_sha256 IS DISTINCT FROM decode(q->>'content_sha256','hex')
  OR saved.policy_ref IS DISTINCT FROM p.policy_ref OR saved.timestamp_at IS DISTINCT FROM (q->>'timestamp_at')::timestamptz THEN
   RAISE EXCEPTION USING ERRCODE='P1193',MESSAGE='publication receipt conflict'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM darkpool_private.resolutions WHERE market_id=mid)
  OR EXISTS(SELECT 1 FROM darkpool_private.settlements WHERE market_id=mid)
  OR NOT EXISTS(SELECT 1 FROM darkpool_private.markets WHERE id=mid AND status='LOCKED') THEN
   RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='publication must precede resolution'; END IF;
  stamp:=(q->>'timestamp_at')::timestamptz;
  IF stamp<(payload->>'locked_at')::timestamptz OR stamp>clock_timestamp()+make_interval(secs=>(p.trust->>'max_clock_skew_seconds')::integer) THEN
   RAISE EXCEPTION USING ERRCODE='P1192',MESSAGE='timestamp outside publication policy'; END IF;
  PERFORM set_config('darkpool_publication.insert',pg_current_xact_id()::text||':'||(q->>'receipt_id'),true);
  INSERT INTO darkpool_private.ledger_publication_receipts VALUES(mid,decode(q->>'merkle_root','hex'),q->>'profile',retained,
   clock_timestamp(),q->>'receipt_id',decode(q->>'content_sha256','hex'),p.policy_ref,p.evidence_class,stamp,session_user);
 END IF;
 RETURN (SELECT jsonb_build_object('receipt_id',receipt_id,'market_id',market_id,'merkle_root',encode(merkle_root,'hex'),
  'content_sha256',encode(content_sha256,'hex'),'policy_ref',policy_ref,'evidence_class',evidence_class,
  'publication',CASE WHEN evidence_class='EXTERNAL' THEN 'VERIFIED' ELSE 'SYNTHETIC_TEST_ONLY' END,
  'timestamp_at',timestamp_at,'recorded_at',recorded_at) FROM darkpool_private.ledger_publication_receipts WHERE market_id=mid);
END $$;

-- Synthetic proof validation never authorizes real resolution or settlement.
CREATE OR REPLACE FUNCTION darkpool_lock.publication_gate() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM darkpool_private.lock_requests WHERE market_id=NEW.market_id)
 AND NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_publication_receipts r
  JOIN darkpool_private.publication_policies p ON p.policy_ref=r.policy_ref
  WHERE r.market_id=NEW.market_id AND r.evidence_class='EXTERNAL' AND p.evidence_class='EXTERNAL') THEN
  RAISE EXCEPTION USING ERRCODE='P1105',MESSAGE='independent external publication receipt required'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_publication FROM PUBLIC;

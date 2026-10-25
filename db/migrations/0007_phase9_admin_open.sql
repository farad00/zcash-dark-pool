-- Approved Phase 9 deposit-intake OPEN; no payout readiness or live provisioning.
INSERT INTO darkpool_private.policy_refs(id,status,issue,reviewed_profile_ref)
SELECT p,'PINNED',NULL,'user-approved-phase9-intake-open-2026-10-16'
FROM unnest(ARRAY['phase9-zero-platform-fee-v1','phase9-payout-deferred-v1','phase9-orchard-receiving-v1','phase9-bounded-close-proof-v2']) p;
ALTER TABLE darkpool_private.admin_requests DROP CONSTRAINT admin_requests_operation_check;
ALTER TABLE darkpool_private.admin_requests ADD CHECK(operation IN ('create','edit','open'));

CREATE OR REPLACE FUNCTION darkpool_admin.availability() RETURNS jsonb
LANGUAGE sql SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object(
  'open', jsonb_build_object('result','CONDITIONAL','scope','PHASE9_DEPOSIT_INTAKE_ONLY','requires',jsonb_build_array(
    'reviewed event and unexpired immutable window','exact approved Phase 9 policy labels',
    'three deposit confirmations, zero platform fee, explicit payout deferral',
    'matching pre-OPEN watcher binding without a hold','request key and current admin revision')),
  'payout',jsonb_build_object('result','BLOCKED','policy','DEFERRED_NOT_REQUIRED_FOR_OPEN',
    'requires',jsonb_build_array('separately frozen and validated payout confirmation/signing policy')),
  'pause', jsonb_build_object('result','BLOCKED','requires',jsonb_build_array(
    'reviewed pause authority, fairness and pending-payment rules')),
  'reopen', jsonb_build_object('result','BLOCKED','requires',jsonb_build_array(
    'reviewed reopening authority, fairness and pending-payment rules')),
  'finalize-lock', jsonb_build_object('result','BLOCKED','requires',jsonb_build_array(
    'reviewed canonical close/finality profile','Phase 11 automatic close/finalization worker',
    'reviewed ledger/blinding/Merkle profile','Phase 12 commitment worker')),
  'resolve', jsonb_build_object('result','BLOCKED','requires',jsonb_build_array(
    'verified finalized ledger and published commitment for YES/NO',
    'implemented resolution eligibility/evidence workflow (Phase 13)',
    'reviewed accounting path for pre-lock VOID'))
 );
$$;

CREATE OR REPLACE FUNCTION darkpool_admin.snapshot() RETURNS jsonb
LANGUAGE sql SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object('market', (
  SELECT jsonb_build_object(
    'id',m.id,'version',m.version,'network',m.network,'question',m.question,
    'yes_definition',m.yes_definition,'no_definition',m.no_definition,
    'opens_at',to_char(m.opens_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closes_at',to_char(m.closes_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'resolution_rule',m.resolution_rule,'resolution_sources',m.resolution_sources,
    'void_conditions',m.void_conditions,'min_stake_zat',m.min_stake_zat::text,
    'max_stake_zat',m.max_stake_zat::text,'zero_winner_policy',m.zero_winner_policy,
    'deposit_confirmations',m.deposit_confirmations,'payout_confirmations',m.payout_confirmations,
    'status',m.status,'revision',r.revision::text,
    'receiving_policy_ref',(SELECT policy_ref FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='receiving'),
    'close_proof_policy_ref',(SELECT policy_ref FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='close-proof'),
    'payout_policy_ref',(SELECT policy_ref FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='payout'),
    'payout_policy_state',CASE WHEN m.payout_confirmations IS NULL AND EXISTS(SELECT 1 FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='payout' AND policy_ref='phase9-payout-deferred-v1') THEN 'DEFERRED_NOT_REQUIRED_FOR_OPEN' ELSE 'UNSUPPORTED_OR_UNCONFIGURED' END,
    'payout_ready',false,
    'policy_status',jsonb_build_object('close',c.status,'payment',p.status,'fee',f.status))
  FROM darkpool_private.markets m
  JOIN darkpool_private.policy_refs c ON c.id=m.close_policy_ref
  JOIN darkpool_private.policy_refs p ON p.id=m.payment_policy_ref
  JOIN darkpool_private.policy_refs f ON f.id=m.fee_policy_ref
  LEFT JOIN darkpool_private.admin_revisions r ON r.market_id=m.id
 ),'availability',darkpool_admin.availability());
$$;

CREATE OR REPLACE FUNCTION darkpool_admin.validate_config(c jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE k text; v numeric; lo numeric; hi numeric; opening timestamptz; closing timestamptz;
BEGIN
  IF c IS NULL OR jsonb_typeof(c) <> 'object' OR
    NOT (((SELECT count(*) FROM jsonb_object_keys(c))=19 AND NOT (c ?| ARRAY['receiving_policy_ref','close_proof_policy_ref','payout_policy_ref']))
     OR ((SELECT count(*) FROM jsonb_object_keys(c))=22 AND c ?& ARRAY['receiving_policy_ref','close_proof_policy_ref','payout_policy_ref'])) OR EXISTS
    (SELECT 1 FROM jsonb_object_keys(c) AS keys(key) WHERE key NOT IN (
     'id','vault_context_ref','question','yes_definition','no_definition','opens_at','closes_at',
     'close_policy_ref','resolution_rule','resolution_sources','void_conditions','min_stake_zat',
     'max_stake_zat','payment_policy_ref','fee_policy_ref','zero_winner_policy',
     'deposit_confirmations','payout_confirmations','network','receiving_policy_ref','close_proof_policy_ref','payout_policy_ref')) THEN
    RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid draft configuration';
  END IF;
  FOREACH k IN ARRAY ARRAY['id','vault_context_ref','question','yes_definition','no_definition',
    'close_policy_ref','resolution_rule','payment_policy_ref','fee_policy_ref'] LOOP
    IF jsonb_typeof(c->k) IS DISTINCT FROM 'string' OR length(btrim(c->>k))=0 OR
      octet_length(c->>k)>8192 THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid draft configuration';
    END IF;
  END LOOP;
  IF c->>'network' IS DISTINCT FROM 'testnet' OR c->>'zero_winner_policy' IS DISTINCT FROM 'NO_WINNER_REFUND'
    OR c->>'yes_definition' = c->>'no_definition' THEN
    RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid draft configuration';
  END IF;
  FOREACH k IN ARRAY ARRAY['resolution_sources','void_conditions'] LOOP
    IF jsonb_typeof(c->k) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid draft configuration';
    END IF;
    IF jsonb_array_length(c->k) NOT BETWEEN 1 AND 32 OR EXISTS
      (SELECT 1 FROM jsonb_array_elements(c->k) e WHERE jsonb_typeof(e) <> 'string'
       OR length(btrim(e #>> '{}'))=0 OR octet_length(e #>> '{}')>8192) THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid draft configuration';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['opens_at','closes_at'] LOOP
    IF jsonb_typeof(c->k) IS DISTINCT FROM 'string' OR
      (c->>k) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid UTC instant';
    END IF;
    BEGIN
      opening := (c->>k)::timestamptz;
      IF to_char(opening AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> c->>k THEN
        RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid UTC instant';
      END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid UTC instant';
    END;
  END LOOP;
  opening := (c->>'opens_at')::timestamptz; closing := (c->>'closes_at')::timestamptz;
  IF opening >= closing THEN
    RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid draft window';
  END IF;
  FOREACH k IN ARRAY ARRAY['min_stake_zat','max_stake_zat'] LOOP
    IF jsonb_typeof(c->k) IS DISTINCT FROM 'string' OR
      (c->>k) !~ '^(0|[1-9][0-9]*)$' OR length(c->>k)>1024 THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid integer zatoshis';
    END IF;
  END LOOP;
  lo := (c->>'min_stake_zat')::numeric; hi := (c->>'max_stake_zat')::numeric;
  IF lo > hi THEN RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid stake bounds'; END IF;
  -- Zero/null remains representable storage; neither value approves finality.
  FOREACH k IN ARRAY ARRAY['deposit_confirmations','payout_confirmations'] LOOP
    IF c->k IS DISTINCT FROM 'null'::jsonb THEN
      IF jsonb_typeof(c->k) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid threshold storage';
      END IF;
      v := (c->>k)::numeric;
      IF v<0 OR v>2147483647 OR v<>trunc(v) THEN
        RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid threshold storage';
      END IF;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['close_policy_ref','payment_policy_ref','fee_policy_ref'] LOOP
    IF NOT EXISTS (SELECT 1 FROM darkpool_private.policy_refs WHERE id=c->>k) THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='missing policy reference';
    END IF;
  END LOOP;
  IF c ? 'receiving_policy_ref' THEN
    FOREACH k IN ARRAY ARRAY['receiving_policy_ref','close_proof_policy_ref','payout_policy_ref'] LOOP
      IF jsonb_typeof(c->k) IS DISTINCT FROM 'string' OR length(btrim(c->>k))=0 OR octet_length(c->>k)>8192
        OR NOT EXISTS(SELECT 1 FROM darkpool_private.policy_refs WHERE id=c->>k) THEN
        RAISE EXCEPTION USING ERRCODE='P4001',MESSAGE='invalid intake policy reference'; END IF;
    END LOOP;
  END IF;
END $$;

CREATE FUNCTION darkpool_admin.open_configuration(m darkpool_private.markets) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT (to_jsonb(m)-ARRAY['version','status','created_at','updated_at']) || jsonb_build_object(
 'opens_at',to_char(m.opens_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'closes_at',to_char(m.closes_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'min_stake_zat',m.min_stake_zat::text,'max_stake_zat',m.max_stake_zat::text,
 'receiving_policy_ref',(SELECT policy_ref FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='receiving'),
 'close_proof_policy_ref',(SELECT policy_ref FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='close-proof'),
 'payout_policy_ref',(SELECT policy_ref FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose='payout'));
$$;

CREATE FUNCTION darkpool_admin.validate_open(c jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m darkpool_private.markets; s darkpool_private.watcher_state;
BEGIN
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN
  RAISE EXCEPTION USING ERRCODE='P4005',MESSAGE='open prerequisites not satisfied'; END IF;
 SELECT * INTO STRICT m FROM darkpool_private.markets FOR UPDATE;
 IF m.status<>'DRAFT' OR NOT isfinite(m.opens_at) OR NOT isfinite(m.closes_at) OR m.opens_at>=m.closes_at
  OR m.closes_at<=clock_timestamp() OR c IS DISTINCT FROM darkpool_admin.open_configuration(m)
  OR m.network<>'testnet' OR m.deposit_confirmations IS DISTINCT FROM 3 OR m.payout_confirmations IS NOT NULL
  OR m.close_policy_ref<>'phase9-exact-chainclock-3-v1' OR m.payment_policy_ref<>'phase9-exact-chainclock-3-v1'
  OR m.fee_policy_ref<>'phase9-zero-platform-fee-v1'
  OR c->>'receiving_policy_ref' IS DISTINCT FROM 'phase9-orchard-receiving-v1'
  OR c->>'close_proof_policy_ref' IS DISTINCT FROM 'phase9-bounded-close-proof-v2'
  OR c->>'payout_policy_ref' IS DISTINCT FROM 'phase9-payout-deferred-v1'
  OR EXISTS(SELECT 1 FROM darkpool_private.market_policy_refs WHERE market_id=m.id AND purpose NOT IN ('receiving','close-proof','payout')) THEN
  RAISE EXCEPTION USING ERRCODE='P4005',MESSAGE='open prerequisites not satisfied'; END IF;
 PERFORM darkpool_admin.validate_config(c);
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.policy_refs WHERE id='phase9-exact-chainclock-3-v1' AND status='PINNED'
   AND reviewed_profile_ref='docs/PHASE9_IMPLEMENTATION.md#approved-2026-10-07')
  OR (SELECT count(*) FROM darkpool_private.policy_refs WHERE id IN ('phase9-zero-platform-fee-v1','phase9-payout-deferred-v1','phase9-orchard-receiving-v1','phase9-bounded-close-proof-v2')
    AND status='PINNED' AND reviewed_profile_ref='user-approved-phase9-intake-open-2026-10-16')<>4 THEN
  RAISE EXCEPTION USING ERRCODE='P4005',MESSAGE='open prerequisites not satisfied'; END IF;
 SELECT * INTO s FROM darkpool_private.watcher_state WHERE market_id=m.id FOR UPDATE;
 IF NOT FOUND OR s.profile_ref<>'phase9-exact-chainclock-3-v1' OR s.bound_closes_at<>m.closes_at OR s.hold_ref IS NOT NULL
  OR s.endpoint_ref<>'https://testnet.zec.rocks:443' OR NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence
    WHERE id='profile:'||m.id AND market_id=m.id AND kind='PROFILE') THEN
  RAISE EXCEPTION USING ERRCODE='P4005',MESSAGE='open prerequisites not satisfied'; END IF;
END $$;


CREATE OR REPLACE FUNCTION darkpool_admin.command(op text, request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE c jsonb; key text; existing darkpool_private.admin_requests;
  m darkpool_private.markets; rev bigint; answer jsonb; event_name text; opening text;
BEGIN
  IF op IS NULL OR request IS NULL OR jsonb_typeof(request)<>'object' OR
    octet_length(request::text)>65536 THEN
    RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid admin request';
  END IF;
  -- Serialize all control requests including empty-database creation. Direct
  -- table writes are unavailable to operator roles. Owners remain trusted.
  PERFORM pg_advisory_xact_lock(1146110284,4);
  IF (SELECT count(*) FROM darkpool_private.markets)>1 THEN
    RAISE EXCEPTION USING ERRCODE='P4002', MESSAGE='single-market precondition failed';
  END IF;
  IF op IN ('inspect','pause','reopen','finalize-lock','resolve') THEN
    IF request <> '{}'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='unsupported control parameters';
    END IF;
    IF op='inspect' THEN RETURN darkpool_admin.snapshot(); END IF;
    RETURN jsonb_build_object('operation',op,'result','BLOCKED',
      'market_exists',EXISTS(SELECT 1 FROM darkpool_private.markets),
      'requires',darkpool_admin.availability()->op->'requires');
  END IF;
  IF op='validate' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(request))<>1 OR NOT request ? 'configuration' THEN
      RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid validation request';
    END IF;
    PERFORM darkpool_admin.validate_config(request->'configuration');
    opening:='BLOCKED';
    BEGIN PERFORM darkpool_admin.validate_open(request->'configuration'); opening:='READY';
    EXCEPTION WHEN SQLSTATE 'P4005' THEN NULL; END;
    RETURN jsonb_build_object('result','VALID_DRAFT','opening',opening,
      'semantic_review','required: proposition, source hierarchy, observation point and void conditions',
      'availability',darkpool_admin.availability());
  END IF;
  IF op='open' THEN
    -- Preserve the old parameterless non-mutating availability request.
    IF request='{}'::jsonb THEN
      RETURN jsonb_build_object('operation',op,'result','BLOCKED',
        'market_exists',EXISTS(SELECT 1 FROM darkpool_private.markets),
        'requires',jsonb_build_array('explicit request key and current admin revision'));
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(request))<>2 OR NOT (request ?& ARRAY['request_key','expected_revision'])
      OR jsonb_typeof(request->'request_key') IS DISTINCT FROM 'string' OR NOT coalesce(request->>'request_key' ~ '^[A-Za-z0-9_-]{1,128}$',false)
      OR jsonb_typeof(request->'expected_revision') IS DISTINCT FROM 'string' OR NOT coalesce(request->>'expected_revision' ~ '^[1-9][0-9]{0,18}$',false) THEN
      RAISE EXCEPTION USING ERRCODE='P4001',MESSAGE='invalid open request'; END IF;
    key:=request->>'request_key';
    SELECT * INTO existing FROM darkpool_private.admin_requests WHERE request_key=key;
    IF FOUND THEN
      IF existing.operation IS DISTINCT FROM op OR existing.request IS DISTINCT FROM request THEN
        RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='administrative retry conflict'; END IF;
      RETURN existing.response;
    END IF;
    IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN
      RAISE EXCEPTION USING ERRCODE='P4002',MESSAGE='single-market precondition failed'; END IF;
    SELECT * INTO STRICT m FROM darkpool_private.markets FOR UPDATE;
    SELECT revision INTO rev FROM darkpool_private.admin_revisions WHERE market_id=m.id FOR UPDATE;
    IF rev IS NULL OR request->>'expected_revision' IS DISTINCT FROM rev::text THEN
      RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='stale draft revision'; END IF;
    PERFORM darkpool_admin.validate_open(darkpool_admin.open_configuration(m));
    UPDATE darkpool_private.markets SET status='OPEN',updated_at=clock_timestamp()
      WHERE id=m.id AND status='DRAFT' AND closes_at>clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P4005',MESSAGE='open prerequisites not satisfied'; END IF;
    UPDATE darkpool_private.admin_revisions SET revision=revision+1 WHERE market_id=m.id;
    INSERT INTO darkpool_private.audit_events VALUES('admin-'||key,1,m.id,'MARKET_OPENED',clock_timestamp(),session_user,key,'DRAFT','OPEN','profile:'||m.id);
    answer:=jsonb_build_object('result','APPLIED','control',darkpool_admin.snapshot());
    INSERT INTO darkpool_private.admin_requests VALUES(key,op,request,answer);
    RETURN answer;
  END IF;
  IF op NOT IN ('create','edit') OR
    (SELECT count(*) FROM jsonb_object_keys(request))<>3 OR
    NOT request ?& ARRAY['request_key','expected_revision','configuration'] THEN
    RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='unsupported admin operation';
  END IF;
  key := request->>'request_key'; c := request->'configuration';
  IF jsonb_typeof(request->'request_key') IS DISTINCT FROM 'string' OR key !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION USING ERRCODE='P4001', MESSAGE='invalid administrative request key';
  END IF;
  PERFORM darkpool_admin.validate_config(c);
  SELECT * INTO existing FROM darkpool_private.admin_requests WHERE request_key=key;
  IF FOUND THEN
    IF existing.operation IS DISTINCT FROM op OR existing.request IS DISTINCT FROM request THEN
      RAISE EXCEPTION USING ERRCODE='P4003', MESSAGE='administrative retry conflict';
    END IF;
    RETURN existing.response;
  END IF;
  SELECT * INTO m FROM darkpool_private.markets FOR UPDATE;
  IF op='create' THEN
    IF FOUND THEN RAISE EXCEPTION USING ERRCODE='P4002', MESSAGE='single market already exists'; END IF;
    IF request->'expected_revision' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='P4003', MESSAGE='invalid creation revision';
    END IF;
    INSERT INTO darkpool_private.markets VALUES (
      c->>'id',1,'testnet',c->>'vault_context_ref',c->>'question',c->>'yes_definition',c->>'no_definition',
      (c->>'opens_at')::timestamptz,(c->>'closes_at')::timestamptz,c->>'close_policy_ref',
      c->>'resolution_rule',ARRAY(SELECT jsonb_array_elements_text(c->'resolution_sources')),
      ARRAY(SELECT jsonb_array_elements_text(c->'void_conditions')),
      (c->>'min_stake_zat')::numeric,(c->>'max_stake_zat')::numeric,c->>'payment_policy_ref',
      c->>'fee_policy_ref','NO_WINNER_REFUND',(c->>'deposit_confirmations')::numeric::integer,
      (c->>'payout_confirmations')::numeric::integer,'DRAFT',clock_timestamp(),clock_timestamp());
    rev := 1;
    INSERT INTO darkpool_private.admin_revisions VALUES (c->>'id',rev);
    event_name := 'MARKET_CREATED';
  ELSE
    IF NOT FOUND OR m.id IS DISTINCT FROM c->>'id' OR m.status <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE='P4004', MESSAGE='draft edit unavailable';
    END IF;
    SELECT revision INTO rev FROM darkpool_private.admin_revisions WHERE market_id=m.id FOR UPDATE;
    IF rev IS NULL OR jsonb_typeof(request->'expected_revision') IS DISTINCT FROM 'string'
      OR request->>'expected_revision' IS DISTINCT FROM rev::text THEN
      RAISE EXCEPTION USING ERRCODE='P4003', MESSAGE='stale draft revision';
    END IF;
    UPDATE darkpool_private.markets SET vault_context_ref=c->>'vault_context_ref',
      question=c->>'question',yes_definition=c->>'yes_definition',no_definition=c->>'no_definition',
      opens_at=(c->>'opens_at')::timestamptz,closes_at=(c->>'closes_at')::timestamptz,
      close_policy_ref=c->>'close_policy_ref',resolution_rule=c->>'resolution_rule',
      resolution_sources=ARRAY(SELECT jsonb_array_elements_text(c->'resolution_sources')),
      void_conditions=ARRAY(SELECT jsonb_array_elements_text(c->'void_conditions')),
      min_stake_zat=(c->>'min_stake_zat')::numeric,max_stake_zat=(c->>'max_stake_zat')::numeric,
      payment_policy_ref=c->>'payment_policy_ref',fee_policy_ref=c->>'fee_policy_ref',
      deposit_confirmations=(c->>'deposit_confirmations')::numeric::integer,
      payout_confirmations=(c->>'payout_confirmations')::numeric::integer,updated_at=clock_timestamp()
      WHERE id=m.id;
    rev := rev+1;
    UPDATE darkpool_private.admin_revisions SET revision=rev WHERE market_id=m.id;
    event_name := 'MARKET_DRAFT_UPDATED';
  END IF;
  -- Explicit intake labels persist only while DRAFT. Legacy drafts have no implicit defaults.
  DELETE FROM darkpool_private.market_policy_refs WHERE market_id=c->>'id' AND purpose IN ('receiving','close-proof','payout');
  IF c ? 'receiving_policy_ref' THEN
    INSERT INTO darkpool_private.market_policy_refs VALUES
      (c->>'id','receiving',c->>'receiving_policy_ref'),(c->>'id','close-proof',c->>'close_proof_policy_ref'),(c->>'id','payout',c->>'payout_policy_ref');
  END IF;
  INSERT INTO darkpool_private.audit_events VALUES (
    'admin-'||key,1,c->>'id',event_name,clock_timestamp(),session_user,key,NULL,NULL,NULL);
  answer := jsonb_build_object('result','APPLIED','control',darkpool_admin.snapshot());
  -- Only validated draft configuration and explicit response projection persist.
  INSERT INTO darkpool_private.admin_requests VALUES (key,op,request,answer);
  RETURN answer;
END $$;

REVOKE ALL ON FUNCTION darkpool_admin.open_configuration(darkpool_private.markets) FROM PUBLIC;
REVOKE ALL ON FUNCTION darkpool_admin.validate_open(jsonb) FROM PUBLIC;
-- CREATE OR REPLACE preserves the sole existing command capability; no GRANT.

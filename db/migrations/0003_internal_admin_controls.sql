-- Phase 4 control boundary only. No reviewed economic profile or worker exists.
-- Application logins get EXECUTE on command only, never private-table grants.
CREATE SCHEMA darkpool_admin;
REVOKE ALL ON SCHEMA darkpool_admin FROM PUBLIC;

CREATE TABLE darkpool_private.admin_revisions (
  market_id darkpool_private.opaque_ref PRIMARY KEY REFERENCES darkpool_private.markets,
  revision bigint NOT NULL CHECK (revision > 0)
);
CREATE TABLE darkpool_private.admin_requests (
  request_key darkpool_private.opaque_ref PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('create','edit')),
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  CHECK (jsonb_typeof(request) = 'object' AND jsonb_typeof(response) = 'object')
);
CREATE TRIGGER admin_requests_immutable BEFORE UPDATE OR DELETE ON darkpool_private.admin_requests
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER admin_requests_no_truncate BEFORE TRUNCATE ON darkpool_private.admin_requests
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();

-- Extend the existing narrow audit vocabulary for executable draft controls.
ALTER TABLE darkpool_private.audit_events DROP CONSTRAINT audit_events_event_check;
ALTER TABLE darkpool_private.audit_events ADD CHECK (event IN (
  'MARKET_CREATED','MARKET_DRAFT_UPDATED','MARKET_OPENED','MARKET_PAUSED','MARKET_REOPENED',
  'MARKET_LOCK_FINALIZATION_STARTED','MARKET_LOCKED','LEDGER_COMMITTED','MARKET_RESOLVED',
  'MARKET_VOIDED','TICKET_CONFIRMED','CLAIM_RESERVED','SETTLEMENT_PLAN_CREATED','TX_AUTHORIZED',
  'TX_BROADCAST','CLAIM_CONFIRMED','REFUND_CONFIRMED'));

CREATE FUNCTION darkpool_admin.availability() RETURNS jsonb
LANGUAGE sql SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object(
  'open', jsonb_build_object('result','BLOCKED','requires',jsonb_build_array(
    'reviewed close mapping/equality and finality profile',
    'declared reviewed deposit/payout confirmation thresholds',
    'reviewed payment and fee profiles','implemented reviewed-policy validation')),
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

-- Explicit projection. No SELECT *, ticket counts, money totals, audit dumps,
-- policy issue payloads, private vault/receiver mappings or claim data.
CREATE FUNCTION darkpool_admin.snapshot() RETURNS jsonb
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
    'policy_status',jsonb_build_object('close',c.status,'payment',p.status,'fee',f.status))
  FROM darkpool_private.markets m
  JOIN darkpool_private.policy_refs c ON c.id=m.close_policy_ref
  JOIN darkpool_private.policy_refs p ON p.id=m.payment_policy_ref
  JOIN darkpool_private.policy_refs f ON f.id=m.fee_policy_ref
  LEFT JOIN darkpool_private.admin_revisions r ON r.market_id=m.id
 ),'availability',darkpool_admin.availability());
$$;

CREATE FUNCTION darkpool_admin.validate_config(c jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE k text; v numeric; lo numeric; hi numeric; opening timestamptz; closing timestamptz;
BEGIN
  IF c IS NULL OR jsonb_typeof(c) <> 'object' OR
    (SELECT count(*) FROM jsonb_object_keys(c)) <> 19 OR EXISTS
    (SELECT 1 FROM jsonb_object_keys(c) AS keys(key) WHERE key NOT IN (
     'id','vault_context_ref','question','yes_definition','no_definition','opens_at','closes_at',
     'close_policy_ref','resolution_rule','resolution_sources','void_conditions','min_stake_zat',
     'max_stake_zat','payment_policy_ref','fee_policy_ref','zero_winner_policy',
     'deposit_confirmations','payout_confirmations','network')) THEN
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
END $$;

-- This is the only entrypoint granted to an internal operator login.
-- It has no generic SQL, arbitrary status update, policy registration or wallet call.
CREATE FUNCTION darkpool_admin.command(op text, request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE c jsonb; key text; existing darkpool_private.admin_requests;
  m darkpool_private.markets; rev bigint; answer jsonb; event_name text;
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
  IF op IN ('inspect','open','pause','reopen','finalize-lock','resolve') THEN
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
    RETURN jsonb_build_object('result','VALID_DRAFT','opening','BLOCKED',
      'semantic_review','required: proposition, source hierarchy, observation point and void conditions',
      'availability',darkpool_admin.availability());
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
  INSERT INTO darkpool_private.audit_events VALUES (
    'admin-'||key,1,c->>'id',event_name,clock_timestamp(),session_user,key,NULL,NULL,NULL);
  answer := jsonb_build_object('result','APPLIED','control',darkpool_admin.snapshot());
  -- Only validated draft configuration and explicit response projection persist.
  INSERT INTO darkpool_private.admin_requests VALUES (key,op,request,answer);
  RETURN answer;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA darkpool_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_admin FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- No login/password or application grants in migrations. Separate owner
-- provisioning grants only schema USAGE and command(text,jsonb) EXECUTE.

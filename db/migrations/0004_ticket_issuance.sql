-- User-approved Phase 7 reservation/completion profile. No payment acceptance.
CREATE SCHEMA darkpool_issuance;
REVOKE ALL ON SCHEMA darkpool_issuance FROM PUBLIC;
CREATE TABLE darkpool_private.issuance_attempts (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 ticket_id text COLLATE "C" NOT NULL UNIQUE CHECK(ticket_id ~ '^[0-9a-f]{64}$'),
 market_id darkpool_private.opaque_ref NOT NULL,
 vault_context_ref darkpool_private.opaque_ref NOT NULL,
 side text NOT NULL CHECK(side IN ('YES','NO')),
 requested_amount_zat darkpool_private.zatoshi NOT NULL CHECK(requested_amount_zat>0),
 commitment bytea CHECK(octet_length(commitment)=32),
 state text NOT NULL CHECK(state IN ('RESERVED','COMPLETING','ISSUED')),
 FOREIGN KEY(market_id,vault_context_ref) REFERENCES darkpool_private.markets(id,vault_context_ref),
 CHECK((state='RESERVED')=(commitment IS NULL))
);
CREATE TRIGGER issuance_retained BEFORE DELETE ON darkpool_private.issuance_attempts
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER issuance_no_truncate BEFORE TRUNCATE ON darkpool_private.issuance_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE FUNCTION darkpool_issuance.guard_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.token_hash,NEW.ticket_id,NEW.market_id,NEW.vault_context_ref,NEW.side,NEW.requested_amount_zat)
  IS DISTINCT FROM ROW(OLD.token_hash,OLD.ticket_id,OLD.market_id,OLD.vault_context_ref,OLD.side,OLD.requested_amount_zat)
  OR (OLD.commitment IS NOT NULL AND NEW.commitment IS DISTINCT FROM OLD.commitment)
  OR (OLD.state='ISSUED' AND NEW IS DISTINCT FROM OLD)
  OR (OLD.state='COMPLETING' AND NEW.state='RESERVED') THEN
  RAISE EXCEPTION USING ERRCODE='P4502',MESSAGE='issuance conflict';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER issuance_binding BEFORE UPDATE ON darkpool_private.issuance_attempts
 FOR EACH ROW EXECUTE FUNCTION darkpool_issuance.guard_attempt();
INSERT INTO darkpool_private.policy_refs VALUES
 ('phase7-issued-unpaid-v1','PINNED',NULL,'user-approved-phase7-reserve-then-issue-v1');

CREATE FUNCTION darkpool_issuance.answer(a darkpool_private.issuance_attempts) RETURNS jsonb
 LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('issuance_profile_version',1,'network','testnet','market_id',a.market_id,
  'ticket_id',a.ticket_id,'status',a.state,'closes_at',to_char(m.closes_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  || CASE WHEN a.state='ISSUED' THEN jsonb_build_object('receiving_ua',t.receiver_ref) ELSE '{}'::jsonb END
 FROM darkpool_private.markets m LEFT JOIN darkpool_private.tickets t ON t.id=a.ticket_id WHERE m.id=a.market_id;
$$;
-- Only schema-owner helpers below; runtime receives the three bounded functions.
CREATE FUNCTION darkpool_issuance.check_open(m darkpool_private.markets) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF m.status<>'OPEN' OR clock_timestamp()<m.opens_at OR clock_timestamp()>=m.closes_at THEN
  RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable';
 END IF;
END $$;
CREATE FUNCTION darkpool_issuance.reserve(h bytea, market text, selected text, amount text, candidate text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.issuance_attempts; m darkpool_private.markets;
BEGIN
 IF h IS NULL OR octet_length(h)<>32 OR market IS NULL OR length(market)=0 OR octet_length(market)>8192
  OR selected IS NULL OR selected NOT IN ('YES','NO') OR amount IS NULL OR length(amount)>1024 OR amount !~ '^[1-9][0-9]*$'
  OR candidate IS NULL OR candidate !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P4501',MESSAGE='invalid issuance request';
 END IF;
 -- Serialize empty-attempt creation and all state checks in this single-market MVP.
 PERFORM pg_advisory_xact_lock(1146110284,7);
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN
  RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable';
 END IF;
 SELECT * INTO a FROM darkpool_private.issuance_attempts WHERE token_hash=h FOR UPDATE;
 IF FOUND THEN
  IF a.market_id<>market OR a.side<>selected OR a.requested_amount_zat<>amount::numeric THEN
   RAISE EXCEPTION USING ERRCODE='P4502',MESSAGE='issuance conflict';
  END IF;
  -- Replayed reservation returns the reserved identity, even if completion began.
  RETURN darkpool_issuance.answer(a)-'receiving_ua' || jsonb_build_object('status','RESERVED');
 END IF;
 SELECT * INTO m FROM darkpool_private.markets WHERE id=market FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable'; END IF;
 PERFORM darkpool_issuance.check_open(m);
 IF amount::numeric<m.min_stake_zat OR amount::numeric>m.max_stake_zat THEN
  RAISE EXCEPTION USING ERRCODE='P4501',MESSAGE='invalid issuance request';
 END IF;
 INSERT INTO darkpool_private.issuance_attempts VALUES(h,candidate,m.id,m.vault_context_ref,selected,amount::numeric,NULL,'RESERVED') RETURNING * INTO a;
 RETURN darkpool_issuance.answer(a);
END $$;
CREATE FUNCTION darkpool_issuance.begin_completion(h bytea, ticket text, digest bytea) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.issuance_attempts; m darkpool_private.markets;
BEGIN
 IF h IS NULL OR octet_length(h)<>32 OR ticket IS NULL OR ticket !~ '^[0-9a-f]{64}$' OR digest IS NULL OR octet_length(digest)<>32 THEN
  RAISE EXCEPTION USING ERRCODE='P4501',MESSAGE='invalid issuance request';
 END IF;
 PERFORM pg_advisory_xact_lock(1146110284,7);
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable'; END IF;
 SELECT * INTO a FROM darkpool_private.issuance_attempts WHERE token_hash=h FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable'; END IF;
 IF a.ticket_id<>ticket OR (a.commitment IS NOT NULL AND a.commitment<>digest) THEN
  RAISE EXCEPTION USING ERRCODE='P4502',MESSAGE='issuance conflict';
 END IF;
 IF a.state='ISSUED' THEN RETURN darkpool_issuance.answer(a); END IF;
 SELECT * INTO m FROM darkpool_private.markets WHERE id=a.market_id FOR UPDATE;
 PERFORM darkpool_issuance.check_open(m);
 UPDATE darkpool_private.issuance_attempts SET commitment=digest,state='COMPLETING' WHERE token_hash=h RETURNING * INTO a;
 RETURN jsonb_build_object('status','COMPLETING','market_id',a.market_id,'vault_context_ref',a.vault_context_ref,'ticket_id',a.ticket_id);
END $$;
CREATE FUNCTION darkpool_issuance.finish(h bytea, ticket text, digest bytea, ua text, diversifier text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a darkpool_private.issuance_attempts; m darkpool_private.markets;
BEGIN
 PERFORM pg_advisory_xact_lock(1146110284,7);
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable'; END IF;
 SELECT * INTO a FROM darkpool_private.issuance_attempts WHERE token_hash=h FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P4503',MESSAGE='issuance unavailable'; END IF;
 IF ticket IS DISTINCT FROM a.ticket_id OR digest IS DISTINCT FROM a.commitment OR a.state='RESERVED' THEN
  RAISE EXCEPTION USING ERRCODE='P4502',MESSAGE='issuance conflict';
 END IF;
 IF ua IS NULL OR length(ua)>1024 OR ua !~ '^utest1[023456789acdefghjklmnpqrstuvwxyz]+$'
  OR diversifier IS NULL OR diversifier !~ '^[0-9a-f]{22}$' THEN
  RAISE EXCEPTION USING ERRCODE='P4501',MESSAGE='invalid allocation result';
 END IF;
 IF a.state='ISSUED' THEN
  IF NOT EXISTS(SELECT 1 FROM darkpool_private.tickets WHERE id=ticket AND receiver_ref=ua AND diversifier_ref='external:'||diversifier) THEN
   RAISE EXCEPTION USING ERRCODE='P4502',MESSAGE='issuance conflict';
  END IF;
  RETURN darkpool_issuance.answer(a);
 END IF;
 SELECT * INTO m FROM darkpool_private.markets WHERE id=a.market_id FOR UPDATE;
 PERFORM darkpool_issuance.check_open(m);
 INSERT INTO darkpool_private.tickets VALUES(a.ticket_id,1,a.market_id,a.vault_context_ref,a.side,a.requested_amount_zat,0,
  ua,'external:'||diversifier,a.commitment,'DARKPOOL_CLAIM_V1_ID_FRAME_1','market-close:'||a.market_id,
  'AWAITING_PAYMENT','phase7-issued-unpaid-v1',NULL,clock_timestamp(),NULL);
 UPDATE darkpool_private.issuance_attempts SET state='ISSUED' WHERE token_hash=h RETURNING * INTO a;
 RETURN darkpool_issuance.answer(a);
END $$;
-- Deferred checks run at transaction completion, not before a slow wallet RPC.
CREATE FUNCTION darkpool_issuance.commit_deadline() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m darkpool_private.markets;
BEGIN
 IF TG_OP='INSERT' OR (NEW.state='ISSUED' AND OLD.state<>'ISSUED') THEN
  SELECT * INTO m FROM darkpool_private.markets WHERE id=NEW.market_id FOR UPDATE;
  PERFORM darkpool_issuance.check_open(m);
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER issuance_commit_deadline AFTER INSERT OR UPDATE ON darkpool_private.issuance_attempts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_issuance.commit_deadline();
REVOKE ALL ON ALL TABLES IN SCHEMA darkpool_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_issuance FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_issuance REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

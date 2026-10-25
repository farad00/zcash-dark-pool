-- Forward-only migration; the runner owns the transaction and checksum journal.
CREATE SCHEMA darkpool_private;
CREATE SCHEMA darkpool_public;
REVOKE ALL ON SCHEMA darkpool_private, darkpool_public FROM PUBLIC;

-- No scale coercion, rounding, floating point, or invented economic maximum.
CREATE DOMAIN darkpool_private.zatoshi AS numeric
  CHECK (VALUE >= 0 AND VALUE = trunc(VALUE)
    AND VALUE NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
CREATE DOMAIN darkpool_private.opaque_ref AS text COLLATE "C"
  CHECK (octet_length(VALUE) > 0);
CREATE DOMAIN darkpool_private.market_status AS text
  CHECK (VALUE IN ('DRAFT','OPEN','PAUSED','LOCKED','RESOLVED','PAYING','VOID','REFUNDING','CLOSED'));
CREATE DOMAIN darkpool_private.payment_status AS text
  CHECK (VALUE IN ('AWAITING_PAYMENT','DETECTED','UNDERPAID','CONFIRMED','LATE','EXCESS','INVALID','REFUND_REQUIRED'));
CREATE DOMAIN darkpool_private.claim_status AS text
  CHECK (VALUE IN ('UNCLAIMED','RESERVED','TX_PREPARING','AWAITING_SIGNATURE','BROADCAST','CONFIRMED','RETRYABLE_FAILURE','TERMINAL_FAILURE'));

CREATE TABLE darkpool_private.policy_refs (
  id darkpool_private.opaque_ref PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('UNPINNED','PINNED')),
  issue text,
  reviewed_profile_ref darkpool_private.opaque_ref,
  CHECK ((status = 'UNPINNED' AND issue IS NOT NULL AND length(issue) > 0 AND reviewed_profile_ref IS NULL)
    OR (status = 'PINNED' AND issue IS NULL AND reviewed_profile_ref IS NOT NULL))
);

CREATE TABLE darkpool_private.markets (
  id darkpool_private.opaque_ref PRIMARY KEY,
  version smallint NOT NULL CHECK (version = 1),
  network text NOT NULL CHECK (network = 'testnet'),
  vault_context_ref darkpool_private.opaque_ref NOT NULL UNIQUE,
  question text NOT NULL,
  yes_definition text NOT NULL,
  no_definition text NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  close_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  resolution_rule text NOT NULL,
  resolution_sources text[] NOT NULL,
  void_conditions text[] NOT NULL,
  min_stake_zat darkpool_private.zatoshi NOT NULL,
  max_stake_zat darkpool_private.zatoshi NOT NULL,
  payment_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  fee_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  zero_winner_policy text NOT NULL CHECK (zero_winner_policy = 'NO_WINNER_REFUND'),
  deposit_confirmations integer CHECK (deposit_confirmations > 0),
  payout_confirmations integer CHECK (payout_confirmations > 0),
  status darkpool_private.market_status NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (opens_at < closes_at),
  CHECK (min_stake_zat <= max_stake_zat),
  UNIQUE (id, vault_context_ref)
);
CREATE INDEX markets_status_close_idx ON darkpool_private.markets (status, closes_at);
-- Extensible profile references, not operational/economic defaults.
CREATE TABLE darkpool_private.market_policy_refs (
  market_id darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.markets,
  purpose darkpool_private.opaque_ref NOT NULL,
  policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  PRIMARY KEY (market_id, purpose)
);

CREATE TABLE darkpool_private.tickets (
  id darkpool_private.opaque_ref PRIMARY KEY,
  version smallint NOT NULL CHECK (version = 1),
  market_id darkpool_private.opaque_ref NOT NULL,
  vault_context_ref darkpool_private.opaque_ref NOT NULL,
  side text NOT NULL CHECK (side IN ('YES','NO')),
  requested_amount_zat darkpool_private.zatoshi NOT NULL CHECK (requested_amount_zat > 0),
  accepted_amount_zat darkpool_private.zatoshi NOT NULL,
  receiver_ref darkpool_private.opaque_ref NOT NULL,
  diversifier_ref darkpool_private.opaque_ref NOT NULL,
  claim_commitment bytea NOT NULL CHECK (octet_length(claim_commitment) = 32),
  claim_commitment_profile text NOT NULL CHECK (claim_commitment_profile = 'DARKPOOL_CLAIM_V1_ID_FRAME_1'),
  payment_deadline_ref darkpool_private.opaque_ref NOT NULL,
  payment_state darkpool_private.payment_status NOT NULL,
  ticket_state_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  accepted_payment_ref darkpool_private.opaque_ref,
  created_at timestamptz NOT NULL,
  accepted_at timestamptz,
  FOREIGN KEY (market_id, vault_context_ref) REFERENCES darkpool_private.markets (id, vault_context_ref),
  UNIQUE (market_id, id),
  UNIQUE (market_id, id, receiver_ref),
  UNIQUE (vault_context_ref, receiver_ref),
  UNIQUE (vault_context_ref, diversifier_ref),
  CHECK (accepted_amount_zat = 0 OR accepted_amount_zat = requested_amount_zat),
  CHECK ((accepted_amount_zat = 0 AND accepted_payment_ref IS NULL AND accepted_at IS NULL)
    OR (accepted_amount_zat = requested_amount_zat AND accepted_payment_ref IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (payment_state <> 'CONFIRMED' OR accepted_amount_zat = requested_amount_zat)
);
CREATE INDEX tickets_market_payment_idx ON darkpool_private.tickets (market_id, payment_state, id);

CREATE TABLE darkpool_private.payment_receipts (
  id darkpool_private.opaque_ref PRIMARY KEY,
  market_id darkpool_private.opaque_ref NOT NULL,
  vault_context_ref darkpool_private.opaque_ref NOT NULL,
  network text NOT NULL CHECK (network = 'testnet'),
  wallet_receipt_ref darkpool_private.opaque_ref NOT NULL,
  txid bytea NOT NULL CHECK (octet_length(txid) = 32),
  value_pool text NOT NULL CHECK (value_pool IN ('SAPLING','ORCHARD','IRONWOOD')),
  output_index bigint NOT NULL CHECK (output_index BETWEEN 0 AND 4294967295),
  ticket_id darkpool_private.opaque_ref,
  receiver_ref darkpool_private.opaque_ref NOT NULL,
  amount_zat darkpool_private.zatoshi NOT NULL,
  block_height bigint CHECK (block_height >= 0),
  block_hash bytea CHECK (octet_length(block_hash) = 32),
  chain_evidence_ref darkpool_private.opaque_ref,
  status_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (market_id, vault_context_ref) REFERENCES darkpool_private.markets (id, vault_context_ref),
  FOREIGN KEY (market_id, ticket_id, receiver_ref) REFERENCES darkpool_private.tickets (market_id, id, receiver_ref),
  UNIQUE (vault_context_ref, wallet_receipt_ref),
  UNIQUE (network, txid, value_pool, output_index),
  UNIQUE (market_id, ticket_id, id),
  UNIQUE (market_id, id),
  CHECK ((block_height IS NULL) = (block_hash IS NULL))
);
CREATE INDEX receipts_ticket_idx ON darkpool_private.payment_receipts (market_id, ticket_id);
CREATE INDEX receipts_height_idx ON darkpool_private.payment_receipts (market_id, block_height);

-- Logical group only: no receipt ordering, allocation, hashing or overshoot rule.
CREATE TABLE darkpool_private.accepted_payments (
  id darkpool_private.opaque_ref PRIMARY KEY,
  market_id darkpool_private.opaque_ref NOT NULL,
  ticket_id darkpool_private.opaque_ref NOT NULL,
  acceptance_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  FOREIGN KEY (market_id, ticket_id) REFERENCES darkpool_private.tickets (market_id, id),
  UNIQUE (market_id, ticket_id, id)
);
ALTER TABLE darkpool_private.tickets ADD CONSTRAINT tickets_accepted_payment_fk
  FOREIGN KEY (market_id, id, accepted_payment_ref)
  REFERENCES darkpool_private.accepted_payments (market_id, ticket_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE darkpool_private.accepted_payment_receipts (
  accepted_payment_id darkpool_private.opaque_ref NOT NULL,
  market_id darkpool_private.opaque_ref NOT NULL,
  ticket_id darkpool_private.opaque_ref NOT NULL,
  receipt_id darkpool_private.opaque_ref NOT NULL UNIQUE,
  PRIMARY KEY (accepted_payment_id, receipt_id),
  FOREIGN KEY (market_id, ticket_id, accepted_payment_id)
    REFERENCES darkpool_private.accepted_payments (market_id, ticket_id, id),
  FOREIGN KEY (market_id, ticket_id, receipt_id)
    REFERENCES darkpool_private.payment_receipts (market_id, ticket_id, id)
);

-- Retain the observed principal even while return amount/eligibility is unresolved.
CREATE TABLE darkpool_private.payment_liabilities (
  id darkpool_private.opaque_ref PRIMARY KEY,
  market_id darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.markets,
  receipt_id darkpool_private.opaque_ref NOT NULL UNIQUE,
  ticket_id darkpool_private.opaque_ref,
  principal_zat darkpool_private.zatoshi,
  policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  state_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (market_id, receipt_id) REFERENCES darkpool_private.payment_receipts (market_id, id),
  FOREIGN KEY (market_id, ticket_id, receipt_id) REFERENCES darkpool_private.payment_receipts (market_id, ticket_id, id),
  UNIQUE (market_id, ticket_id, id)
);

CREATE TABLE darkpool_private.ledger_sets (
  market_id darkpool_private.opaque_ref PRIMARY KEY REFERENCES darkpool_private.markets,
  encoding_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  frozen_at timestamptz
);
CREATE TABLE darkpool_private.ledger_records (
  market_id darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.ledger_sets,
  ticket_id darkpool_private.opaque_ref NOT NULL,
  version smallint NOT NULL CHECK (version = 1),
  side text NOT NULL CHECK (side IN ('YES','NO')),
  accepted_amount_zat darkpool_private.zatoshi NOT NULL CHECK (accepted_amount_zat > 0),
  accepted_payment_ref darkpool_private.opaque_ref NOT NULL,
  receiver_ref darkpool_private.opaque_ref NOT NULL,
  record_blinding bytea,
  blinding_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  PRIMARY KEY (market_id, ticket_id),
  FOREIGN KEY (market_id, ticket_id, receiver_ref) REFERENCES darkpool_private.tickets (market_id, id, receiver_ref),
  FOREIGN KEY (market_id, ticket_id, accepted_payment_ref)
    REFERENCES darkpool_private.accepted_payments (market_id, ticket_id, id)
);
CREATE TABLE darkpool_private.ledger_commitments (
  market_id darkpool_private.opaque_ref PRIMARY KEY REFERENCES darkpool_private.ledger_sets,
  version smallint NOT NULL CHECK (version = 1),
  accepted_ticket_count darkpool_private.zatoshi NOT NULL,
  merkle_root bytea NOT NULL CHECK (octet_length(merkle_root) > 0),
  commitment_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  locked_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.resolutions (
  id darkpool_private.opaque_ref PRIMARY KEY,
  market_id darkpool_private.opaque_ref NOT NULL UNIQUE REFERENCES darkpool_private.markets,
  version smallint NOT NULL CHECK (version = 1),
  outcome text NOT NULL CHECK (outcome IN ('YES','NO','VOID')),
  evidence text[] NOT NULL,
  rule_version darkpool_private.opaque_ref NOT NULL,
  actor darkpool_private.opaque_ref NOT NULL,
  resolved_at timestamptz NOT NULL,
  UNIQUE (market_id, id)
);

-- One accepted-stake entitlement per ticket. Exceptions are separate liabilities;
-- no schema default declares a receipt refundable or fixes its return amount.
CREATE TABLE darkpool_private.entitlements (
  id darkpool_private.opaque_ref PRIMARY KEY,
  market_id darkpool_private.opaque_ref NOT NULL,
  ticket_id darkpool_private.opaque_ref NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ACCEPTED_STAKE','PAYMENT_EXCEPTION')),
  liability_id darkpool_private.opaque_ref,
  policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  amount_zat darkpool_private.zatoshi,
  FOREIGN KEY (market_id, ticket_id) REFERENCES darkpool_private.tickets (market_id, id),
  FOREIGN KEY (market_id, ticket_id, liability_id) REFERENCES darkpool_private.payment_liabilities (market_id, ticket_id, id),
  CHECK ((kind = 'ACCEPTED_STAKE' AND liability_id IS NULL)
    OR (kind = 'PAYMENT_EXCEPTION' AND liability_id IS NOT NULL)),
  UNIQUE (market_id, ticket_id, id),
  UNIQUE (liability_id)
);
CREATE UNIQUE INDEX entitlements_accepted_ticket_idx ON darkpool_private.entitlements (ticket_id)
  WHERE kind = 'ACCEPTED_STAKE';

CREATE TABLE darkpool_private.settlements (
  id darkpool_private.opaque_ref PRIMARY KEY,
  version smallint NOT NULL CHECK (version = 1),
  market_id darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.markets,
  resolution_ref darkpool_private.opaque_ref NOT NULL,
  ledger_market_id darkpool_private.opaque_ref,
  ledger_root bytea,
  plan_hash bytea,
  hashing_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  total_output_zat darkpool_private.zatoshi NOT NULL,
  expected_fee_zat darkpool_private.zatoshi NOT NULL,
  allocated_funds_zat darkpool_private.zatoshi NOT NULL,
  state_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  tx_ref darkpool_private.opaque_ref,
  authorization_started_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (market_id, resolution_ref) REFERENCES darkpool_private.resolutions (market_id, id),
  FOREIGN KEY (ledger_market_id) REFERENCES darkpool_private.ledger_commitments (market_id),
  CHECK (ledger_market_id IS NULL OR ledger_market_id = market_id),
  CHECK ((ledger_market_id IS NULL) = (ledger_root IS NULL)),
  CHECK (authorization_started_at IS NULL OR plan_hash IS NOT NULL),
  CHECK (total_output_zat + expected_fee_zat <= allocated_funds_zat),
  UNIQUE (market_id, id)
);
CREATE INDEX settlements_tx_idx ON darkpool_private.settlements (tx_ref) WHERE tx_ref IS NOT NULL;

CREATE TABLE darkpool_private.claims (
  id darkpool_private.opaque_ref PRIMARY KEY,
  version smallint NOT NULL CHECK (version = 1),
  market_id darkpool_private.opaque_ref NOT NULL,
  ticket_id darkpool_private.opaque_ref NOT NULL,
  entitlement_id darkpool_private.opaque_ref NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PAYOUT','REFUND')),
  refund_reason text CHECK (refund_reason IN ('VOID','NO_WINNER_REFUND','PAYMENT_EXCEPTION')),
  idempotency_scope_ref darkpool_private.opaque_ref NOT NULL,
  idempotency_key darkpool_private.opaque_ref NOT NULL,
  idempotency_policy_ref darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.policy_refs,
  payout_address text NOT NULL CHECK (length(payout_address) > 0),
  destination_validation_ref darkpool_private.opaque_ref NOT NULL,
  entitlement_zat darkpool_private.zatoshi NOT NULL,
  state darkpool_private.claim_status NOT NULL,
  settlement_id darkpool_private.opaque_ref,
  tx_ref darkpool_private.opaque_ref,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (market_id, ticket_id, entitlement_id)
    REFERENCES darkpool_private.entitlements (market_id, ticket_id, id),
  FOREIGN KEY (market_id, settlement_id) REFERENCES darkpool_private.settlements (market_id, id),
  CHECK ((kind = 'PAYOUT' AND refund_reason IS NULL) OR (kind = 'REFUND' AND refund_reason IS NOT NULL)),
  CHECK (state NOT IN ('BROADCAST','CONFIRMED') OR (tx_ref IS NOT NULL AND settlement_id IS NOT NULL)),
  UNIQUE (idempotency_scope_ref, idempotency_key),
  UNIQUE (market_id, id)
);
-- Failures retain the reservation. No terminal/expiry/release policy is inferred.
CREATE UNIQUE INDEX claims_reserved_entitlement_idx ON darkpool_private.claims (entitlement_id)
  WHERE state <> 'UNCLAIMED';
CREATE INDEX claims_ticket_idx ON darkpool_private.claims (market_id, ticket_id);
CREATE INDEX claims_state_idx ON darkpool_private.claims (state, updated_at);
CREATE INDEX claims_settlement_idx ON darkpool_private.claims (settlement_id);
CREATE VIEW darkpool_private.refunds AS
  SELECT id, market_id, ticket_id, entitlement_id, refund_reason, state, settlement_id, tx_ref
  FROM darkpool_private.claims WHERE kind = 'REFUND';
CREATE TABLE darkpool_private.settlement_items (
  settlement_id darkpool_private.opaque_ref NOT NULL,
  market_id darkpool_private.opaque_ref NOT NULL,
  claim_id darkpool_private.opaque_ref NOT NULL UNIQUE,
  destination text NOT NULL CHECK (length(destination) > 0),
  amount_zat darkpool_private.zatoshi NOT NULL,
  PRIMARY KEY (settlement_id, claim_id),
  FOREIGN KEY (market_id, settlement_id) REFERENCES darkpool_private.settlements (market_id, id),
  FOREIGN KEY (market_id, claim_id) REFERENCES darkpool_private.claims (market_id, id)
);
CREATE TABLE darkpool_private.audit_events (
  id darkpool_private.opaque_ref PRIMARY KEY,
  version smallint NOT NULL CHECK (version = 1),
  market_id darkpool_private.opaque_ref NOT NULL REFERENCES darkpool_private.markets,
  event text NOT NULL CHECK (event IN ('MARKET_OPENED','MARKET_PAUSED','MARKET_REOPENED',
    'MARKET_LOCK_FINALIZATION_STARTED','MARKET_LOCKED','LEDGER_COMMITTED','MARKET_RESOLVED',
    'MARKET_VOIDED','TICKET_CONFIRMED','CLAIM_RESERVED','SETTLEMENT_PLAN_CREATED','TX_AUTHORIZED',
    'TX_BROADCAST','CLAIM_CONFIRMED','REFUND_CONFIRMED')),
  timestamp timestamptz NOT NULL,
  source darkpool_private.opaque_ref NOT NULL,
  trigger_ref darkpool_private.opaque_ref NOT NULL,
  prior_state darkpool_private.market_status,
  new_state darkpool_private.market_status,
  chain_ref darkpool_private.opaque_ref,
  CHECK ((prior_state IS NULL) = (new_state IS NULL))
);
CREATE INDEX audit_market_time_idx ON darkpool_private.audit_events (market_id, timestamp, id);

-- Explicit allowlist only. No count, private vault mapping, side/stake/odds fields.
-- No public grants: provisioning must grant only this schema/view to a reader.
CREATE VIEW darkpool_public.markets WITH (security_barrier = true) AS
 SELECT id, version, network, question, yes_definition, no_definition, opens_at,
   closes_at, resolution_rule, resolution_sources, void_conditions, status
 FROM darkpool_private.markets;

CREATE FUNCTION darkpool_private.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable product record';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON darkpool_private.audit_events
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON darkpool_private.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER policies_immutable BEFORE UPDATE OR DELETE ON darkpool_private.policy_refs
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();

CREATE FUNCTION darkpool_private.guard_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'UNCLAIMED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reservation requires reviewed reconciliation';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.market_id,NEW.ticket_id,NEW.entitlement_id,NEW.kind,NEW.refund_reason,
      NEW.idempotency_scope_ref,NEW.idempotency_key,NEW.idempotency_policy_ref,
      NEW.payout_address,NEW.destination_validation_ref,NEW.entitlement_zat)
    IS DISTINCT FROM ROW(OLD.id,OLD.market_id,OLD.ticket_id,OLD.entitlement_id,OLD.kind,OLD.refund_reason,
      OLD.idempotency_scope_ref,OLD.idempotency_key,OLD.idempotency_policy_ref,
      OLD.payout_address,OLD.destination_validation_ref,OLD.entitlement_zat)
    OR (OLD.state <> 'UNCLAIMED' AND NEW.state = 'UNCLAIMED')
    OR (OLD.state = 'CONFIRMED' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.tx_ref IS NOT NULL AND NEW.tx_ref IS DISTINCT FROM OLD.tx_ref)
    OR (OLD.settlement_id IS NOT NULL AND NEW.settlement_id IS DISTINCT FROM OLD.settlement_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'claim binding or reservation cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_binding BEFORE UPDATE OR DELETE ON darkpool_private.claims
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_claim();
CREATE TRIGGER claims_no_truncate BEFORE TRUNCATE ON darkpool_private.claims
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE FUNCTION darkpool_private.guard_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
    (to_jsonb(NEW) - 'amount_zat') IS DISTINCT FROM (to_jsonb(OLD) - 'amount_zat') OR
    EXISTS (SELECT 1 FROM darkpool_private.claims WHERE entitlement_id = OLD.id AND state <> 'UNCLAIMED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'entitlement binding or reserved principal is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entitlement_binding BEFORE UPDATE OR DELETE ON darkpool_private.entitlements
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_entitlement();
CREATE FUNCTION darkpool_private.validate_claim_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE e darkpool_private.entitlements;
BEGIN
  SELECT * INTO e FROM darkpool_private.entitlements WHERE id = NEW.entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Foreign key supplies missing-record error.
  IF (e.kind = 'PAYMENT_EXCEPTION' AND
       (NEW.kind <> 'REFUND' OR NEW.refund_reason IS DISTINCT FROM 'PAYMENT_EXCEPTION'))
    OR (e.kind = 'ACCEPTED_STAKE' AND NEW.refund_reason = 'PAYMENT_EXCEPTION')
    OR (NEW.state <> 'UNCLAIMED' AND (e.amount_zat IS NULL OR e.amount_zat <> NEW.entitlement_zat)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'claim must match known entitlement';
  END IF;
  IF e.kind = 'PAYMENT_EXCEPTION' AND NEW.state <> 'UNCLAIMED' AND NOT EXISTS
    (SELECT 1 FROM darkpool_private.policy_refs WHERE id = e.policy_ref AND status = 'PINNED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'exception refund policy requires review';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_entitlement BEFORE INSERT OR UPDATE ON darkpool_private.claims
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.validate_claim_entitlement();

CREATE FUNCTION darkpool_private.guard_market_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND
    ((to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','updated_at']) OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'opened market rules are frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER markets_rules BEFORE UPDATE ON darkpool_private.markets
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_market_rules();
CREATE FUNCTION darkpool_private.guard_market_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE m text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.market_id IS DISTINCT FROM OLD.market_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'policy market binding is immutable';
  END IF;
  m := CASE WHEN TG_OP = 'DELETE' THEN OLD.market_id ELSE NEW.market_id END;
  PERFORM 1 FROM darkpool_private.markets WHERE id = m AND status = 'DRAFT' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'opened market policies are frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER market_policies_frozen BEFORE INSERT OR UPDATE OR DELETE ON darkpool_private.market_policy_refs
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_market_policy();

CREATE FUNCTION darkpool_private.guard_ledger_set() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'frozen ledger set is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER ledger_set_frozen BEFORE UPDATE OR DELETE ON darkpool_private.ledger_sets
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_ledger_set();
CREATE FUNCTION darkpool_private.guard_ledger_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE m text; frozen timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.market_id,NEW.ticket_id) IS DISTINCT FROM ROW(OLD.market_id,OLD.ticket_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger membership binding is immutable';
  END IF;
  m := CASE WHEN TG_OP = 'DELETE' THEN OLD.market_id ELSE NEW.market_id END;
  SELECT frozen_at INTO frozen FROM darkpool_private.ledger_sets WHERE market_id = m FOR UPDATE;
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'frozen ledger membership is immutable';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM 1 FROM darkpool_private.tickets WHERE market_id = m AND id = NEW.ticket_id
      AND payment_state = 'CONFIRMED' AND side = NEW.side
      AND accepted_amount_zat = NEW.accepted_amount_zat AND accepted_payment_ref = NEW.accepted_payment_ref;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger record must match confirmed ticket';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER ledger_membership BEFORE INSERT OR UPDATE OR DELETE ON darkpool_private.ledger_records
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_ledger_record();
CREATE TRIGGER ledger_commitment_immutable BEFORE UPDATE OR DELETE ON darkpool_private.ledger_commitments
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE FUNCTION darkpool_private.guard_commitment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM darkpool_private.ledger_sets WHERE market_id = NEW.market_id AND frozen_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR NEW.accepted_ticket_count <> (SELECT count(*) FROM darkpool_private.ledger_records WHERE market_id = NEW.market_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commitment requires frozen membership and matching count';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_commitment_frozen BEFORE INSERT ON darkpool_private.ledger_commitments
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_commitment();

CREATE FUNCTION darkpool_private.guard_ticket_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE frozen timestamptz;
BEGIN
  IF ROW(NEW.id,NEW.market_id,NEW.vault_context_ref,NEW.side,NEW.requested_amount_zat,
    NEW.receiver_ref,NEW.diversifier_ref,NEW.claim_commitment,NEW.claim_commitment_profile,NEW.payment_deadline_ref)
    IS DISTINCT FROM ROW(OLD.id,OLD.market_id,OLD.vault_context_ref,OLD.side,OLD.requested_amount_zat,
    OLD.receiver_ref,OLD.diversifier_ref,OLD.claim_commitment,OLD.claim_commitment_profile,OLD.payment_deadline_ref) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'issued ticket context is immutable';
  END IF;
  SELECT frozen_at INTO frozen FROM darkpool_private.ledger_sets WHERE market_id = OLD.market_id FOR UPDATE;
  IF frozen IS NOT NULL AND ROW(NEW.accepted_amount_zat,NEW.accepted_payment_ref,NEW.accepted_at)
    IS DISTINCT FROM ROW(OLD.accepted_amount_zat,OLD.accepted_payment_ref,OLD.accepted_at) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'frozen ticket stake is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_binding BEFORE UPDATE ON darkpool_private.tickets
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_ticket_binding();

CREATE FUNCTION darkpool_private.guard_settlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.authorization_started_at IS NOT NULL AND
    (TG_OP = 'DELETE' OR (to_jsonb(NEW) - ARRAY['state_policy_ref','tx_ref','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state_policy_ref','tx_ref','updated_at'])) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authorized settlement plan is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.tx_ref IS NOT NULL AND NEW.tx_ref IS DISTINCT FROM OLD.tx_ref THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'transaction identity requires reconciliation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER settlement_binding BEFORE UPDATE OR DELETE ON darkpool_private.settlements
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_settlement();
CREATE FUNCTION darkpool_private.guard_settlement_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE s text; authorized timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.market_id,NEW.settlement_id,NEW.claim_id)
      IS DISTINCT FROM ROW(OLD.market_id,OLD.settlement_id,OLD.claim_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement item binding is immutable';
  END IF;
  s := CASE WHEN TG_OP = 'DELETE' THEN OLD.settlement_id ELSE NEW.settlement_id END;
  SELECT authorization_started_at INTO authorized FROM darkpool_private.settlements WHERE id = s FOR UPDATE;
  IF authorized IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authorized settlement outputs are immutable';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM 1 FROM darkpool_private.claims WHERE id = NEW.claim_id AND market_id = NEW.market_id
      AND payout_address = NEW.destination AND entitlement_zat = NEW.amount_zat;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'output must match bound claim';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER settlement_output_binding BEFORE INSERT OR UPDATE OR DELETE ON darkpool_private.settlement_items
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_settlement_item();
CREATE FUNCTION darkpool_private.guard_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Serialize against settlement insertion through the market row as well.
  PERFORM 1 FROM darkpool_private.markets WHERE id = OLD.market_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM darkpool_private.settlements WHERE market_id = OLD.market_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement resolution is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER resolution_binding BEFORE UPDATE OR DELETE ON darkpool_private.resolutions
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_resolution();
CREATE FUNCTION darkpool_private.lock_settlement_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM darkpool_private.markets WHERE id = NEW.market_id FOR UPDATE;
  IF NEW.ledger_root IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM darkpool_private.ledger_commitments WHERE market_id = NEW.market_id AND merkle_root = NEW.ledger_root) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement ledger root mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_context BEFORE INSERT OR UPDATE ON darkpool_private.settlements
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.lock_settlement_context();
-- Ordinary product roles must never receive DELETE/TRUNCATE/DDL privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA darkpool_private, darkpool_public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA darkpool_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Storage guards only. Reviewed-profile labels do not prove protocol correctness.
-- No threshold is selected, including no implied minimum-finality policy. A
-- representable count is not authorization to OPEN with an unreviewed profile.
ALTER TABLE darkpool_private.markets DROP CONSTRAINT markets_deposit_confirmations_check;
ALTER TABLE darkpool_private.markets DROP CONSTRAINT markets_payout_confirmations_check;
ALTER TABLE darkpool_private.markets ADD CHECK (deposit_confirmations >= 0);
ALTER TABLE darkpool_private.markets ADD CHECK (payout_confirmations >= 0);
CREATE OR REPLACE FUNCTION darkpool_private.guard_ledger_set() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'frozen ledger set is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.frozen_at IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM darkpool_private.policy_refs
        WHERE id = NEW.encoding_policy_ref AND status = 'PINNED') OR EXISTS
      (SELECT 1 FROM darkpool_private.ledger_records r JOIN darkpool_private.policy_refs p ON p.id = r.blinding_policy_ref
       WHERE r.market_id = OLD.market_id AND
       (r.record_blinding IS NULL OR octet_length(r.record_blinding) = 0 OR p.status <> 'PINNED')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger freeze requires reviewed profiles and persisted blindings';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION darkpool_private.guard_commitment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM darkpool_private.ledger_sets WHERE market_id = NEW.market_id AND frozen_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR NEW.accepted_ticket_count <> (SELECT count(*) FROM darkpool_private.ledger_records WHERE market_id = NEW.market_id)
    OR NOT EXISTS (SELECT 1 FROM darkpool_private.policy_refs WHERE id = NEW.commitment_policy_ref AND status = 'PINNED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commitment requires frozen membership, matching count and reviewed profile';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION darkpool_private.lock_settlement_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM darkpool_private.markets WHERE id = NEW.market_id FOR UPDATE;
  IF NEW.ledger_root IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM darkpool_private.ledger_commitments WHERE market_id = NEW.market_id AND merkle_root = NEW.ledger_root) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement ledger root mismatch';
  END IF;
  IF NEW.plan_hash IS NOT NULL OR NEW.authorization_started_at IS NOT NULL THEN
    IF NEW.plan_hash IS NULL OR octet_length(NEW.plan_hash) = 0
      OR NOT EXISTS (SELECT 1 FROM darkpool_private.policy_refs WHERE id = NEW.hashing_policy_ref AND status = 'PINNED')
      OR NEW.total_output_zat <> (SELECT coalesce(sum(amount_zat),0) FROM darkpool_private.settlement_items WHERE settlement_id = NEW.id)
      OR EXISTS (SELECT 1 FROM darkpool_private.settlement_items i JOIN darkpool_private.claims c ON c.id = i.claim_id
        WHERE i.settlement_id = NEW.id AND (c.state = 'UNCLAIMED' OR c.settlement_id IS DISTINCT FROM NEW.id)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authorization requires reviewed hash and reconciled bound outputs';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A known claim-settlement association must point to its actual output; both
-- sides can be written in one transaction without choosing preparation ordering.
ALTER TABLE darkpool_private.claims ADD CONSTRAINT claims_settlement_item_fk
  FOREIGN KEY (settlement_id, id) REFERENCES darkpool_private.settlement_items (settlement_id, claim_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Parent locks above serialize concurrent freeze/authorization with membership.
-- Prevent ordinary roles granted mutation access from bypassing row triggers via
-- TRUNCATE. DDL/owner rights are never appropriate for application connections.
CREATE TRIGGER ledger_sets_no_truncate BEFORE TRUNCATE ON darkpool_private.ledger_sets
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER ledger_records_no_truncate BEFORE TRUNCATE ON darkpool_private.ledger_records
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER ledger_commitments_no_truncate BEFORE TRUNCATE ON darkpool_private.ledger_commitments
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER entitlements_no_truncate BEFORE TRUNCATE ON darkpool_private.entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER settlements_no_truncate BEFORE TRUNCATE ON darkpool_private.settlements
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER settlement_items_no_truncate BEFORE TRUNCATE ON darkpool_private.settlement_items
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();

CREATE TRIGGER ticket_mapping_retained BEFORE DELETE ON darkpool_private.tickets
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER tickets_no_truncate BEFORE TRUNCATE ON darkpool_private.tickets
  FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER receipts_retained BEFORE DELETE ON darkpool_private.payment_receipts
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER liabilities_retained BEFORE DELETE ON darkpool_private.payment_liabilities
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE FUNCTION darkpool_private.guard_receipt_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.id,NEW.market_id,NEW.vault_context_ref,NEW.network,NEW.wallet_receipt_ref,
      NEW.txid,NEW.value_pool,NEW.output_index,NEW.receiver_ref,NEW.amount_zat)
    IS DISTINCT FROM ROW(OLD.id,OLD.market_id,OLD.vault_context_ref,OLD.network,OLD.wallet_receipt_ref,
      OLD.txid,OLD.value_pool,OLD.output_index,OLD.receiver_ref,OLD.amount_zat)
    OR (OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'observed note identity and principal are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_identity BEFORE UPDATE ON darkpool_private.payment_receipts
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_receipt_identity();

CREATE FUNCTION darkpool_private.guard_ledger_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'freeze requires existing ledger membership validation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_set_insert BEFORE INSERT ON darkpool_private.ledger_sets
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_ledger_insert();

CREATE FUNCTION darkpool_private.guard_accepted_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE m text; frozen timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'accepted receipt group binding is immutable';
  END IF;
  m := CASE WHEN TG_OP = 'DELETE' THEN OLD.market_id ELSE NEW.market_id END;
  SELECT frozen_at INTO frozen FROM darkpool_private.ledger_sets WHERE market_id = m FOR UPDATE;
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'frozen accepted receipt groups are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER accepted_group_freeze BEFORE INSERT OR UPDATE OR DELETE ON darkpool_private.accepted_payments
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_accepted_group();
CREATE TRIGGER accepted_receipts_freeze BEFORE INSERT OR UPDATE OR DELETE ON darkpool_private.accepted_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION darkpool_private.guard_accepted_group();

CREATE OR REPLACE FUNCTION darkpool_private.guard_settlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.plan_hash IS NOT NULL AND
    (TG_OP = 'DELETE' OR (to_jsonb(NEW) - ARRAY['state_policy_ref','tx_ref','updated_at','authorization_started_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state_policy_ref','tx_ref','updated_at','authorization_started_at'])) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sealed settlement plan is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND
    ((OLD.tx_ref IS NOT NULL AND NEW.tx_ref IS DISTINCT FROM OLD.tx_ref) OR
     (OLD.authorization_started_at IS NOT NULL AND NEW.authorization_started_at IS DISTINCT FROM OLD.authorization_started_at)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authorization or transaction identity requires reconciliation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION darkpool_private.guard_settlement_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE s text; sealed bytea;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.market_id,NEW.settlement_id,NEW.claim_id)
      IS DISTINCT FROM ROW(OLD.market_id,OLD.settlement_id,OLD.claim_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement item binding is immutable';
  END IF;
  s := CASE WHEN TG_OP = 'DELETE' THEN OLD.settlement_id ELSE NEW.settlement_id END;
  SELECT plan_hash INTO sealed FROM darkpool_private.settlements WHERE id = s FOR UPDATE;
  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sealed settlement outputs are immutable';
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_private FROM PUBLIC;

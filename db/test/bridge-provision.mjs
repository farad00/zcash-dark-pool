// Installed only inside a newly OID-bound lifecycle fixture. Not an operational grant.
import { assertSyntheticLifecycle } from "./lifecycle-fixtures.mjs";
import { statusPrivilegeCheck } from "../../services/test-bridge/payment-status.mjs";
export async function provisionBridgeStatus(f) {
  assertSyntheticLifecycle();
  const suffix = /^darkpool_phase9_([a-f0-9]{16})$/.exec(f.database)?.[1];
  const role = f.roles.other;
  if (!suffix || role !== "darkpool_e2e_other_" + suffix)
    throw new Error("BRIDGE_TEST_ONLY");
  await f.sql(`BEGIN;
CREATE SCHEMA darkpool_test_bridge;
REVOKE ALL ON SCHEMA darkpool_test_bridge FROM PUBLIC;
CREATE FUNCTION darkpool_test_bridge.payment_status(capability bytea, market text, ticket text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE answer text;
BEGIN
 IF current_database()<>'${f.database}' OR session_user<>'${role}' OR octet_length(capability)<>32 THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='status unavailable'; END IF;
 SELECT CASE WHEN w.hold_ref IS NOT NULL THEN 'UNAVAILABLE'
  WHEN t.payment_state='CONFIRMED' AND t.accepted_amount_zat=t.requested_amount_zat
   AND t.accepted_payment_ref IS NOT NULL AND EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts p
    WHERE p.market_id=t.market_id AND p.ticket_id=t.id AND p.accepted_payment_id=t.accepted_payment_ref) THEN 'CONFIRMED'
  ELSE 'AWAITING_PAYMENT' END INTO answer
 FROM darkpool_private.issuance_attempts a JOIN darkpool_private.tickets t ON t.id=a.ticket_id AND t.market_id=a.market_id
 JOIN darkpool_private.watcher_state w ON w.market_id=t.market_id
 WHERE a.token_hash=capability AND a.state='ISSUED' AND a.market_id=market AND a.ticket_id=ticket
  AND a.commitment=t.claim_commitment;
 IF answer IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='status unavailable'; END IF;
 RETURN jsonb_build_object('status',answer,'environment','SYNTHETIC_TEST_ONLY','financial_authorization','NOT_GRANTED');
END $fn$;
REVOKE ALL ON FUNCTION darkpool_test_bridge.payment_status(bytea,text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA darkpool_test_bridge TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_test_bridge.payment_status(bytea,text,text) TO "${role}";
SET LOCAL ROLE "${role}";
${statusPrivilegeCheck.replace("current_user=session_user", "true")} AS permitted \\gset
\\if :permitted
COMMIT;
\\else
SELECT 1/0;
\\endif`);
}

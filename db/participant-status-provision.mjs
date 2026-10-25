// Pure, create-only provisioning SQL. No CLI or connection; never changes evidence.
import { statusPrivileges } from "../services/genuine-deposit/status.mjs";
export function participantStatusScript({ database, role, environment }) {
  const fixture = /^darkpool_phase9_([a-f0-9]{16})$/.exec(database)?.[1];
  if (
    !(
      environment === "DISPOSABLE_TEST" &&
      fixture &&
      role === `darkpool_e2e_other_${fixture}`
    ) &&
    !(
      environment === "TESTNET_OBSERVATION" &&
      database === "darkpool_testnet_observation_v1" &&
      role === "darkpool_obs_v1_status"
    )
  )
    throw Error("PARTICIPANT_STATUS_PROVISION_REJECTED");
  return `BEGIN;
CREATE SCHEMA darkpool_participant_status;
REVOKE ALL ON SCHEMA darkpool_participant_status FROM PUBLIC;
CREATE FUNCTION darkpool_participant_status.payment_status(capability bytea, market text, ticket text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE answer text;
BEGIN
 IF current_database()<>'${database}' OR session_user<>'${role}' OR capability IS NULL OR octet_length(capability)<>32 THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='status unavailable'; END IF;
 SELECT CASE WHEN w.hold_ref IS NOT NULL THEN 'UNAVAILABLE'
  WHEN t.payment_state='CONFIRMED' AND t.accepted_amount_zat=t.requested_amount_zat
   AND t.accepted_payment_ref IS NOT NULL AND EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts p
    JOIN darkpool_private.watcher_evidence e ON e.market_id=p.market_id AND e.kind='ACCEPTANCE' AND e.details->>'group_id'=p.accepted_payment_id
    WHERE p.market_id=t.market_id AND p.ticket_id=t.id AND p.accepted_payment_id=t.accepted_payment_ref) THEN 'CONFIRMED'
  WHEN EXISTS(SELECT 1 FROM darkpool_private.payment_receipts p WHERE p.market_id=t.market_id AND p.ticket_id=t.id
   AND p.status_policy_ref IN ('phase9-observed','phase9-pending','phase9-candidate','phase9-under','phase9-over','phase9-late','phase9-additional')) THEN 'DETECTED'
  ELSE 'AWAITING_PAYMENT' END INTO answer
 FROM darkpool_private.issuance_attempts a JOIN darkpool_private.tickets t ON t.id=a.ticket_id AND t.market_id=a.market_id
 JOIN darkpool_private.watcher_state w ON w.market_id=t.market_id
 WHERE a.token_hash=capability AND a.state='ISSUED' AND a.market_id=market AND a.ticket_id=ticket AND a.commitment=t.claim_commitment;
 IF answer IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='status unavailable'; END IF;
 RETURN jsonb_build_object('status',answer,'environment','${environment}','financial_authorization','NOT_GRANTED');
END $fn$;
REVOKE ALL ON FUNCTION darkpool_participant_status.payment_status(bytea,text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA darkpool_participant_status TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_participant_status.payment_status(bytea,text,text) TO "${role}";
SET LOCAL ROLE "${role}";
${statusPrivileges.replace("current_user=session_user", "true")} AS permitted \\gset
\\if :permitted
COMMIT;
\\else
SELECT 1/0;
\\endif`;
}

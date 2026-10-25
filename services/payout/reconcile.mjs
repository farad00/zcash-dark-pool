import {
  begin,
  commit,
  json,
  canonicalData,
  sqlText,
  withPayoutSession,
} from "./session.mjs";
const deny = () => {
  throw new Error("PAYOUT_RECONCILIATION_REJECTED");
};
const kinds = [
  "CONSTRUCTION_REPORTED",
  "SUBMISSION_ACCEPTED_REPORTED",
  "SUBMISSION_UNCERTAIN",
  "PROCESS_INTERRUPTED",
  "INCLUSION_REPORTED",
  "REORG_REPORTED",
  "SPEND_CONFLICT_REPORTED",
];
// Authenticated internal cautionary report, NOT verified wallet/chain evidence.
// Every report quarantines; none enables spending, replacement or confirmation.
export async function reportInSession(session, claimId, report) {
  try {
    if (
      !report ||
      Object.keys(report).sort().join(",") !==
        ["report_key", "kind", "transaction_id", "artifact_ref", "evidence_ref"]
          .sort()
          .join(",") ||
      !kinds.includes(report.kind) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(report.report_key) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(report.evidence_ref) ||
      (report.transaction_id !== null &&
        (typeof report.transaction_id !== "string" ||
          !/^[0-9a-f]{64}$/.test(report.transaction_id))) ||
      (report.artifact_ref !== null &&
        (typeof report.artifact_ref !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(report.artifact_ref)))
    )
      deny();
    const statement = `SELECT darkpool_payout.report(${sqlText(claimId)},${json(report)});`;
    await session.query(begin);
    const receipt = await session.query(statement);
    const saved = await session.query(statement); // Exact retry/readback, no new event.
    if (
      canonicalData(saved) !== canonicalData(receipt) ||
      receipt.planning_state !== "RECONCILIATION_REQUIRED" ||
      receipt.spending_authorized !== false ||
      receipt.submission_enabled !== false ||
      receipt.replacement_authorized !== false ||
      receipt.confirmation_authorized !== false
    )
      deny();
    await commit(session);
    return Object.freeze(receipt);
  } catch {
    deny();
  }
}
export async function recordPayoutObservation(claimId, report, env) {
  try {
    return await withPayoutSession(env, (s) =>
      reportInSession(s, claimId, report),
    );
  } catch {
    deny();
  }
}

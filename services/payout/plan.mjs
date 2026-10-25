import { validateDestination } from "../claims/primitives.mjs";
import {
  begin,
  commit,
  json,
  canonicalData,
  sqlText,
  withPayoutSession,
} from "./session.mjs";
const deny = () => {
  throw new Error("PAYOUT_PLAN_REJECTED");
};
const fields = [
  "kind",
  "version",
  "intent_id",
  "claim_id",
  "claim_revision",
  "market_id",
  "ticket_id",
  "entitlement_id",
  "network",
  "vault_context_ref",
  "account_ref",
  "ledger_root",
  "resolution_ref",
  "publication_receipt_ref",
  "outcome",
  "entitlement_kind",
  "refund_reason",
  "amount_zat",
  "payout_ua",
  "orchard_receiver_hex",
  "receiver_policy",
  "fee_mode",
  "external_funding_ref",
  "fee_ceiling_zat",
  "policy_ref",
  "execution_class",
  "spending_authorized",
  "submission_enabled",
].sort();
const positive = (s) => {
  if (typeof s !== "string" || !/^[1-9][0-9]{0,15}$/.test(s)) deny();
  const n = BigInt(s);
  if (n > 2100000000000000n) deny();
  return n;
};
// Only authoritative SQL context; NEVER a claimant-selected instruction.
// This is a private intent, not a signed SPEC section 26 plan or fee quote.
export async function validateIntentContext(data) {
  try {
    if (
      !data ||
      Object.keys(data).sort().join(",") !==
        ["existing", "intent", "remaining_fee_zat"].sort().join(",")
    )
      deny();
    const i = data.intent;
    if (
      !i ||
      Object.keys(i).sort().join(",") !== fields.join(",") ||
      i.kind !== "PRIVATE_PAYOUT_INTENT" ||
      i.version !== 1 ||
      i.intent_id !== "payout-intent:" + i.claim_id ||
      !/^claim:[0-9a-f-]{36}$/.test(i.claim_id) ||
      i.claim_revision !== "2" ||
      i.network !== "testnet" ||
      i.receiver_policy !== "ORCHARD_REQUIRED" ||
      i.fee_mode !== "EXTERNALLY_SUBSIDIZED" ||
      i.policy_ref !== "phase15-plan-only-v1" ||
      !["EXTERNAL", "SYNTHETIC_TEST"].includes(i.execution_class) ||
      i.spending_authorized !== false ||
      i.submission_enabled !== false ||
      !/^[0-9a-f]{64}$/.test(i.ticket_id) ||
      !/^[0-9a-f]{64}$/.test(i.ledger_root) ||
      !/^[0-9a-f]{64}$/.test(i.publication_receipt_ref) ||
      !/^[0-9a-f]{86}$/.test(i.orchard_receiver_hex) ||
      !["YES", "NO", "VOID"].includes(i.outcome) ||
      !["PAYOUT", "REFUND"].includes(i.entitlement_kind) ||
      (i.entitlement_kind === "PAYOUT" &&
        (i.refund_reason !== null || i.outcome === "VOID")) ||
      (i.entitlement_kind === "REFUND" &&
        !["VOID", "NO_WINNER_REFUND"].includes(i.refund_reason)) ||
      (i.refund_reason === "VOID" && i.outcome !== "VOID") ||
      (i.refund_reason === "NO_WINNER_REFUND" && i.outcome === "VOID")
    )
      deny();
    for (const key of [
      "market_id",
      "entitlement_id",
      "vault_context_ref",
      "account_ref",
      "resolution_ref",
      "external_funding_ref",
    ])
      if (
        typeof i[key] !== "string" ||
        !i[key].length ||
        i[key].length > 256 ||
        !i[key].isWellFormed() ||
        i[key].includes("\0")
      )
        deny();
    const amount = positive(i.amount_zat),
      ceiling = positive(i.fee_ceiling_zat);
    if (
      amount + ceiling > 2100000000000000n ||
      typeof data.remaining_fee_zat !== "string" ||
      !/^(0|[1-9][0-9]{0,15})$/.test(data.remaining_fee_zat)
    )
      deny();
    if (data.existing === null) {
      if (BigInt(data.remaining_fee_zat) < ceiling) deny();
    } else if (canonicalData(data.existing) !== canonicalData(i)) deny();
    const destination = await validateDestination(i.payout_ua);
    if (destination.orchard_receiver_hex !== i.orchard_receiver_hex) deny();
    return Object.freeze({ ...i });
  } catch {
    deny();
  }
}
export async function planInSession(session, claimId) {
  try {
    const cid = sqlText(claimId);
    await session.query(begin);
    const intent = await validateIntentContext(
      await session.query(`SELECT darkpool_payout.begin_plan(${cid});`),
    );
    const receipt = await session.query(
      `SELECT darkpool_payout.store_plan(${cid},${json(intent)});`,
    );
    const saved = await session.query(
      `SELECT darkpool_payout.begin_plan(${cid});`,
    );
    if (
      canonicalData(saved.existing) !== canonicalData(intent) ||
      receipt.intent_id !== intent.intent_id ||
      receipt.spending_authorized !== false ||
      receipt.submission_enabled !== false
    )
      deny();
    await commit(session);
    return Object.freeze(receipt);
  } catch {
    deny();
  }
}
export async function planPayoutIntent(claimId, env) {
  try {
    return await withPayoutSession(env, (s) => planInSession(s, claimId));
  } catch {
    deny();
  }
}

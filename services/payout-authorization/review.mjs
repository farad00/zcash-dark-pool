import { validateIntentContext } from "../payout/plan.mjs";
import {
  begin,
  commit,
  json,
  canonicalData,
  sqlText,
  withPayoutSession,
} from "../payout/session.mjs";
import {
  checkDisabledTestnetPolicy,
  unavailableExecutionDependencies,
} from "./contracts.mjs";
const deny = () => {
  throw new Error("PAYOUT_REVIEW_REJECTED");
};
export async function inspectReviewPacket(packet) {
  try {
    if (
      !packet ||
      Object.keys(packet).sort().join(",") !==
        [
          "kind",
          "version",
          "review_id",
          "intent",
          "policy",
          "declared_market_payout_confirmations",
        ]
          .sort()
          .join(",") ||
      packet.kind !== "PRIVATE_OPERATOR_REVIEW_PACKET" ||
      packet.version !== 1 ||
      packet.review_id !== "payout-review:" + packet.intent?.intent_id ||
      (packet.declared_market_payout_confirmations !== null &&
        (!Number.isSafeInteger(packet.declared_market_payout_confirmations) ||
          packet.declared_market_payout_confirmations < 0))
    )
      deny();
    checkDisabledTestnetPolicy(packet.policy);
    await validateIntentContext({
      intent: packet.intent,
      existing: packet.intent,
      remaining_fee_zat: "0",
    });
    return Object.freeze({
      state: "BLOCKED_PREREQUISITES",
      spending_authorized: false,
      signing_enabled: false,
      submission_enabled: false,
      market_finality_matches_proposal:
        packet.declared_market_payout_confirmations === 3,
      dependencies: unavailableExecutionDependencies(),
    });
  } catch {
    deny();
  }
}
export async function previewInSession(session, intentId) {
  try {
    await session.query(begin);
    const packet = await session.query(
      `SELECT darkpool_payout_review.preview(${sqlText(intentId)});`,
    );
    await inspectReviewPacket(packet);
    await commit(session);
    return packet; // PRIVATE operator display only. Never return through public API.
  } catch {
    deny();
  }
}
export async function previewPayoutAuthorization(intentId, env) {
  try {
    return await withPayoutSession(env, (s) => previewInSession(s, intentId));
  } catch {
    deny();
  }
}
export async function requestReviewInSession(session, request) {
  try {
    if (
      !request ||
      Object.keys(request).sort().join(",") !==
        ["intent_id", "request_key", "expected_packet"].sort().join(",") ||
      typeof request.request_key !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(request.request_key)
    )
      deny();
    await inspectReviewPacket(request.expected_packet);
    const statement = `SELECT darkpool_payout_review.request(${sqlText(request.intent_id)},${sqlText(request.request_key)},${json(request.expected_packet)});`;
    await session.query(begin);
    const receipt = await session.query(statement);
    const saved = await session.query(statement);
    if (
      canonicalData(receipt) !== canonicalData(saved) ||
      receipt.review_id !== request.expected_packet.review_id ||
      receipt.state !== "BLOCKED_PREREQUISITES" ||
      receipt.spending_authorized !== false ||
      receipt.signing_enabled !== false ||
      receipt.submission_enabled !== false
    )
      deny();
    await commit(session);
    return Object.freeze(receipt);
  } catch {
    deny();
  }
}
export async function requestPayoutAuthorizationReview(request, env) {
  try {
    return await withPayoutSession(env, (s) =>
      requestReviewInSession(s, request),
    );
  } catch {
    deny();
  }
}

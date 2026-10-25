import { prepareResolutionSettlement } from "../../packages/protocol/phase12/preparation.ts";
import {
  begin,
  commit,
  json,
  wire,
  withResolutionSession,
  canonicalData as canonical,
} from "./session.mjs";

function reject() {
  throw new Error("RESOLUTION_REJECTED");
}
function integer(s) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,154})$/.test(s)) reject();
  return BigInt(s);
}
/** Rebuild exclusively from authoritative DB material, using original blindings
 * and historical seal/revision even on replay. The Phase 12 preview stays false;
 * durable authorization is a separate authenticated SQL transition. */
export function computeResolution(data) {
  try {
    const { authority, approval, seal } = data;
    const { resources, rule } = authority;
    const review = approval.request.review;
    if (
      seal.context.market_id !== approval.market_id ||
      approval.request.expected_root !== seal.response.commitment.merkle_root ||
      approval.resolution.rule_version !== rule.rule_version ||
      approval.oracle_login !== authority.oracle_login ||
      approval.resolution.actor !== authority.actor_ref ||
      review.observation_at !== authority.observation_at ||
      approval.resolution.evidence.length === 0 ||
      !rule.resolution_sources.includes(review.source_ref) ||
      !["DEFENSIBLE", "AMBIGUOUS"].includes(review.decision) ||
      (review.decision === "AMBIGUOUS" &&
        approval.resolution.outcome !== "VOID")
    )
      reject();
    const bounds = {
      min: integer(seal.min_stake_zat),
      max: integer(seal.max_stake_zat),
    };
    const records = seal.records.map((r) => {
      if (
        typeof r.record_blinding !== "string" ||
        !/^[0-9a-f]{64}$/.test(r.record_blinding)
      )
        reject();
      return {
        ...r,
        accepted_amount_zat: integer(r.accepted_amount_zat),
        record_blinding: new Uint8Array(Buffer.from(r.record_blinding, "hex")),
      };
    });
    const result = prepareResolutionSettlement(
      {
        status: "LOCKED",
        revision: integer(approval.request.expected_revision),
        frozen_at: seal.context.locked_at,
        safety_hold_ref: null,
        context: seal.context,
        records,
      },
      {
        request_key: approval.request_key,
        expected_revision: integer(approval.request.expected_revision),
        resolution: approval.resolution,
      },
      {
        commitment: seal.response.commitment,
        oracle_rule: rule,
        ledger_limits: {
          stake_bounds: bounds,
          max_tickets: integer(resources.max_tickets),
          max_text_bytes: resources.max_text_bytes,
          max_amount_bytes: resources.max_amount_bytes,
          max_ledger_bytes: resources.max_ledger_bytes,
        },
        settlement_policy: {
          fee_mode: "EXTERNALLY_SUBSIDIZED",
          stake_bounds: bounds,
          max_total_zat: integer(resources.max_total_zat),
          max_numerator_zat_squared: integer(
            resources.max_numerator_zat_squared,
          ),
        },
        review_oracle: (frozenRule, resolution) => {
          if (
            canonical(wire(frozenRule)) !== canonical(rule) ||
            canonical(wire(resolution)) !== canonical(approval.resolution)
          )
            reject();
          // This is the retained authenticated human review, not a default oracle
          // truth judgment or an arbitrary callback from a public request.
          return review.decision;
        },
      },
      null,
    );
    const prepared = wire(result);
    if (data.saved) {
      if (canonical(data.saved.preparation) !== canonical(prepared)) reject();
      const expected = result.calculation.entitlements.map((e) => ({
        ticket_id: e.ticket_id,
        winning_payout_zat: e.winning_payout_zat.toString(),
        refund_zat: e.refund_zat.toString(),
        amount_zat: (e.winning_payout_zat + e.refund_zat).toString(),
      }));
      if (canonical(data.stored_entitlements) !== canonical(expected)) reject();
    }
    return prepared;
  } catch {
    reject();
  }
}

export async function resolveInSession(session, requestKey) {
  if (
    typeof requestKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(requestKey)
  )
    reject();
  await session.query(begin);
  const key = `convert_from(decode('${Buffer.from(requestKey).toString("hex")}','hex'),'UTF8')`;
  const data = await session.query(
    `SELECT darkpool_resolution.begin_resolution(${key});`,
  );
  const prepared = computeResolution(data);
  const response = await session.query(
    `SELECT darkpool_resolution.finish_resolution(${key},${json(prepared)});`,
  );
  const saved = await session.query(
    `SELECT darkpool_resolution.begin_resolution(${key});`,
  );
  if (
    !saved.saved ||
    canonical(computeResolution(saved)) !== canonical(prepared) ||
    canonical(saved.saved.response) !== canonical(response)
  )
    reject();
  await commit(session);
  return response;
}
export async function finalizeResolution(requestKey, env) {
  return withResolutionSession(env, (session) =>
    resolveInSession(session, requestKey),
  );
}

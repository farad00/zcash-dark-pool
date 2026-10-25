import { verifyClaim, reserveClaim, preparePayout } from "./claim.mts";
import { matchesCredential, validateDestination } from "./primitives.mjs";
import { computeResolution } from "../resolution/prepare.mjs";
import {
  begin,
  commit,
  json,
  wire,
  canonicalData,
  withClaimSession,
} from "./session.mjs";
const deny = () => {
  throw new Error("CLAIM_REJECTED");
};
const integer = (s) => {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,154})$/.test(s)) deny();
  return BigInt(s);
};
const text = (s) => {
  if (
    typeof s !== "string" ||
    !s.length ||
    s.length > 8192 ||
    !s.isWellFormed()
  )
    deny();
  return `convert_from(decode('${Buffer.from(s).toString("hex")}','hex'),'UTF8')`;
};

function binding(raw) {
  return {
    ...raw,
    market_revision: integer(raw.market_revision),
    amount_zat: integer(raw.amount_zat),
  };
}
function reservation(raw) {
  if (!raw) return null;
  const b = binding(raw.binding);
  return {
    ...raw,
    revision: integer(raw.revision),
    binding: b,
    instruction:
      raw.instruction === null
        ? null
        : { ...raw.instruction, binding: binding(raw.instruction.binding) },
  };
}
function preparation(raw) {
  const p = structuredClone(raw);
  p.binding.revision = integer(p.binding.revision);
  const policy = p.binding.policy;
  policy.stake_bounds = {
    min: integer(policy.stake_bounds.min),
    max: integer(policy.stake_bounds.max),
  };
  policy.max_total_zat = integer(policy.max_total_zat);
  policy.max_numerator_zat_squared = integer(policy.max_numerator_zat_squared);
  for (const key of Object.keys(p.calculation)) {
    if (!["mode", "outcome", "entitlements"].includes(key))
      p.calculation[key] = integer(p.calculation[key]);
  }
  p.calculation.entitlements = p.calculation.entitlements.map((e) => ({
    ...e,
    winning_payout_zat: integer(e.winning_payout_zat),
    refund_zat: integer(e.refund_zat),
  }));
  return p;
}
export function claimContext(data) {
  // Validate saved durable results and ALL actual entitlement amounts before
  // passing the original preview (still false) to Phase 13's independent checks.
  const calculated = computeResolution(data);
  const p = preparation(calculated),
    limits = data.authority.resources;
  const gate = {
    ...data.gate,
    market_revision: integer(data.gate.market_revision),
  };
  if (
    !["PAYING", "REFUNDING"].includes(gate.market_state) ||
    gate.resolution_ref !== data.saved.resolution_id ||
    gate.publication_receipt_ref !== data.saved.publication_receipt_id ||
    gate.ledger_root !== data.approval.request.expected_root ||
    data.execution_class !== data.saved.execution_class ||
    data.execution_class !== data.authority.execution_class
  )
    deny();
  return {
    gate,
    safety_hold_ref: null,
    snapshot: {
      status: "LOCKED",
      revision: p.binding.revision,
      frozen_at: data.seal.context.locked_at,
      context: data.seal.context,
      safety_hold_ref: null,
      records: data.seal.records.map((r) => {
        if (
          typeof r.record_blinding !== "string" ||
          !/^[0-9a-f]{64}$/.test(r.record_blinding)
        )
          deny();
        return {
          ...r,
          accepted_amount_zat: integer(r.accepted_amount_zat),
          record_blinding: new Uint8Array(
            Buffer.from(r.record_blinding, "hex"),
          ),
        };
      }),
    },
    preparation_request: {
      request_key: data.approval.request_key,
      expected_revision: p.binding.revision,
      resolution: data.approval.resolution,
    },
    preparation_configuration: {
      commitment: data.seal.response.commitment,
      oracle_rule: data.authority.rule,
      ledger_limits: {
        stake_bounds: p.binding.policy.stake_bounds,
        max_tickets: integer(limits.max_tickets),
        max_text_bytes: limits.max_text_bytes,
        max_amount_bytes: limits.max_amount_bytes,
        max_ledger_bytes: limits.max_ledger_bytes,
      },
      settlement_policy: p.binding.policy,
      review_oracle: (rule, outcome) => {
        if (
          canonicalData(wire(rule)) !== canonicalData(data.authority.rule) ||
          canonicalData(wire(outcome)) !==
            canonicalData(data.approval.resolution)
        )
          deny();
        return data.approval.request.review.decision;
      },
    },
    preparation: p,
    credential: data.credential,
    entitlement_ref: data.entitlement_ref,
    existing: reservation(data.existing),
  };
}
async function knownReceivingReceivers(uas) {
  const unique = [...new Set(uas)],
    receivers = new Set();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (next < unique.length) {
        const index = next++;
        const decoded = await validateDestination(unique[index]);
        receivers.add(decoded.orchard_receiver_hex);
      }
    }),
  );
  return receivers;
}

/** Secret is transient server memory only; SQL receives market/ticket/key,
 * existing commitment and verified immutable binding, NEVER the raw secret. */
export async function claimInSession(session, request, prepare = false) {
  let owned;
  try {
    if (
      !request ||
      Object.keys(request).sort().join(",") !==
        [
          "market_id",
          "ticket_id",
          "claim_secret",
          "payout_ua",
          "idempotency_key",
        ]
          .sort()
          .join(",") ||
      !(request.claim_secret instanceof Uint8Array) ||
      request.claim_secret.length !== 32
    )
      deny();
    owned = { ...request, claim_secret: new Uint8Array(request.claim_secret) };
    const mid = text(owned.market_id),
      tid = text(owned.ticket_id),
      key = text(owned.idempotency_key);
    await session.query(begin);
    const data = await session.query(
      `SELECT darkpool_claims.begin_claim(${mid},${tid},${key});`,
    );
    // Reject an unauthenticated bearer before expensive whole-ledger work.
    // Phase 13 repeats this check against the same locked authoritative record.
    if (
      !matchesCredential(
        owned.market_id,
        owned.ticket_id,
        owned.claim_secret,
        data.credential?.commitment,
      )
    )
      deny();
    const context = claimContext(data);
    let receiving;
    const proposal = await verifyClaim(owned, context, {
      authorize: (gate) => {
        // These bindings were authenticated by SQL with current locks held;
        // no boolean/adapter from a claimant can enter this function.
        if (canonicalData(wire(gate)) !== canonicalData(data.gate)) deny();
        return "AUTHORIZED";
      },
      destination: async (ua) => {
        const decoded = await validateDestination(ua);
        receiving = await knownReceivingReceivers(data.receiving_uas);
        return decoded;
      },
      freshness: (destination) => {
        if (
          !receiving ||
          receiving.has(destination.orchard_receiver_hex) ||
          data.prior_receivers.some(
            (p) =>
              p.receiver === destination.orchard_receiver_hex &&
              p.claim_id !== data.reservation_id,
          )
        )
          deny();
        return "FRESH";
      },
    });
    if (prepare && !context.existing) deny();
    const change = prepare
      ? preparePayout(context.existing)
      : reserveClaim(proposal, context.existing);
    const response = await session.query(
      `SELECT darkpool_claims.store(${mid},${tid},${key},${json(change)},${text(data.credential.commitment)},${prepare ? "true" : "false"});`,
    );
    const saved = await session.query(
      `SELECT darkpool_claims.begin_claim(${mid},${tid},${key});`,
    );
    if (
      canonicalData(saved.existing) !== canonicalData(wire(change.next)) ||
      response.reservation_id !== saved.reservation_id
    )
      deny();
    await commit(session);
    return Object.freeze(response);
  } catch {
    deny();
  } finally {
    owned?.claim_secret.fill(0);
  }
}
export async function reserveDurableClaim(request, env) {
  try {
    return await withClaimSession(env, (s) =>
      claimInSession(s, request, false),
    );
  } catch {
    deny();
  }
}
export async function prepareDurablePayout(request, env) {
  try {
    return await withClaimSession(env, (s) => claimInSession(s, request, true));
  } catch {
    deny();
  }
}

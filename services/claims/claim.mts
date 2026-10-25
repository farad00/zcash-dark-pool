/** Server-only pure decisions. No DB reservation, publication or spending API. */
import { matchesCredential } from "./primitives.mjs";
import { prepareResolutionSettlement } from "../../packages/protocol/phase12/preparation.ts";
import type {
  LockedSnapshot,
  PreparationRequest,
  PreparationConfiguration,
  SettlementPreparation,
} from "../../packages/protocol/phase12/preparation.ts";
import type {
  MarketStatus,
  ClaimStatus,
  Resolution,
} from "../../packages/protocol/src/domain.ts";

export interface ClaimRequest {
  readonly market_id: string;
  readonly ticket_id: string;
  readonly claim_secret: Uint8Array;
  readonly payout_ua: string;
  readonly idempotency_key: string;
}
export interface ClaimGate {
  readonly market_id: string;
  readonly market_state: MarketStatus;
  readonly market_revision: bigint;
  readonly ledger_root: string;
  readonly resolution_ref: string;
  readonly outcome: Resolution["outcome"];
  readonly mode: SettlementPreparation["calculation"]["mode"];
  readonly publication_receipt_ref: string;
  readonly claim_policy_ref: string;
}
/** Trusted private storage export. Never populate from claimant JSON. */
export interface ClaimContext {
  readonly gate: ClaimGate;
  readonly safety_hold_ref: string | null;
  readonly snapshot: LockedSnapshot;
  readonly preparation_request: PreparationRequest;
  readonly preparation_configuration: PreparationConfiguration;
  readonly preparation: SettlementPreparation;
  readonly credential: Readonly<{
    ticket_id: string;
    profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1";
    commitment: string;
  }> | null;
  readonly entitlement_ref: string;
  readonly existing: ClaimReservation | null;
}
export interface ClaimChecks {
  /** Required approved profile: authenticate actual publication/resolution
   * receipts, current state/revision/hold, and mode->claim-state mapping.
   * No default or request-controlled callback/boolean is accepted.
   */
  readonly authorize: (gate: ClaimGate) => "AUTHORIZED";
  readonly destination: (
    ua: string,
  ) => Promise<Readonly<{ payout_ua: string; orchard_receiver_hex: string }>>;
  /** Check known receiving/payout receiver reuse. Global historical non-use of
   * someone else's shielded address cannot be proved; claimant supplies a fresh UA.
   */
  readonly freshness: (
    destination: Readonly<{ payout_ua: string; orchard_receiver_hex: string }>,
  ) => "FRESH";
}
export interface ClaimBinding extends ClaimGate {
  readonly ticket_id: string;
  readonly entitlement_ref: string;
  readonly idempotency_key: string;
  readonly payout_ua: string;
  readonly orchard_receiver_hex: string;
  readonly amount_zat: bigint;
  readonly kind: "PAYOUT" | "REFUND";
  readonly refund_reason: null | "VOID" | "NO_WINNER_REFUND";
  readonly fee_mode: "EXTERNALLY_SUBSIDIZED";
}
export interface ClaimProposal {
  readonly kind: "PRIVATE_UNRESERVED_CLAIM";
  readonly binding: ClaimBinding;
}
export interface PayoutInstruction {
  readonly kind: "PRIVATE_PAYOUT_PREPARATION";
  readonly spending_authorized: false;
  /** Full tuple is the identity; no new plan-hash/credential encoding. */
  readonly binding: ClaimBinding;
  readonly receiver_policy: "ORCHARD_REQUIRED";
}
export interface ClaimReservation {
  readonly revision: bigint;
  readonly state: ClaimStatus;
  readonly binding: ClaimBinding;
  readonly instruction: PayoutInstruction | null;
  readonly tx_ref: string | null;
  readonly reconciliation_required: boolean;
}
export interface ClaimChange {
  readonly expected_revision: bigint | null;
  readonly next: ClaimReservation;
}
function deny(): never {
  throw new Error("CLAIM_REJECTED");
}
function exact(v: unknown, keys: readonly string[]): void {
  if (
    !v ||
    typeof v !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    deny();
  const found = Reflect.ownKeys(v);
  if (
    found.length !== keys.length ||
    found.some((k) => typeof k !== "string" || !keys.includes(k))
  )
    deny();
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) deny();
  }
}
function nonempty(v: unknown, max = 8192): asserts v is string {
  if (
    typeof v !== "string" ||
    !v.length ||
    v.includes("\0") ||
    new TextEncoder().encode(v).length > max
  )
    deny();
  for (const c of v) {
    const p = c.codePointAt(0)!;
    if (p >= 0xd800 && p <= 0xdfff) deny();
  }
}
function sameBinding(a: ClaimBinding, b: ClaimBinding): boolean {
  const keys = Object.keys(a) as (keyof ClaimBinding)[];
  exact(b, keys);
  return keys.every((k) => a[k] === b[k]);
}
function ownBinding(binding: ClaimBinding): ClaimBinding {
  exact(binding, [
    "market_id",
    "market_state",
    "market_revision",
    "ledger_root",
    "resolution_ref",
    "outcome",
    "mode",
    "publication_receipt_ref",
    "claim_policy_ref",
    "ticket_id",
    "entitlement_ref",
    "idempotency_key",
    "payout_ua",
    "orchard_receiver_hex",
    "amount_zat",
    "kind",
    "refund_reason",
    "fee_mode",
  ]);
  if (
    typeof binding.amount_zat !== "bigint" ||
    binding.amount_zat <= 0n ||
    binding.fee_mode !== "EXTERNALLY_SUBSIDIZED" ||
    !/^[0-9a-f]{64}$/.test(binding.ticket_id) ||
    !/^[0-9a-f]{64}$/.test(binding.ledger_root) ||
    !/^[0-9a-f]{86}$/.test(binding.orchard_receiver_hex) ||
    !(
      (binding.kind === "PAYOUT" && binding.refund_reason === null) ||
      (binding.kind === "REFUND" &&
        ["VOID", "NO_WINNER_REFUND"].includes(binding.refund_reason ?? ""))
    )
  )
    deny();
  if (
    (binding.kind === "PAYOUT" &&
      (binding.mode !== "WINNING_PAYOUT" || binding.outcome === "VOID")) ||
    (binding.kind === "REFUND" &&
      !(
        (binding.mode === "VOID_REFUND" &&
          binding.outcome === "VOID" &&
          binding.refund_reason === "VOID") ||
        (binding.mode === "NO_WINNER_REFUND" &&
          binding.outcome !== "VOID" &&
          binding.refund_reason === "NO_WINNER_REFUND")
      ))
  )
    deny();
  return Object.freeze({ ...binding });
}
function checkRecord(record: ClaimReservation, binding: ClaimBinding): void {
  ownBinding(binding);
  exact(record, [
    "revision",
    "state",
    "binding",
    "instruction",
    "tx_ref",
    "reconciliation_required",
  ]);
  if (
    typeof record.revision !== "bigint" ||
    record.revision < 1n ||
    !sameBinding(binding, record.binding) ||
    ![
      "RESERVED",
      "TX_PREPARING",
      "AWAITING_SIGNATURE",
      "BROADCAST",
      "CONFIRMED",
      "RETRYABLE_FAILURE",
      "TERMINAL_FAILURE",
    ].includes(record.state) ||
    (record.tx_ref !== null && typeof record.tx_ref !== "string") ||
    typeof record.reconciliation_required !== "boolean"
  )
    deny();
  if (record.instruction !== null) {
    exact(record.instruction, [
      "kind",
      "spending_authorized",
      "binding",
      "receiver_policy",
    ]);
    if (
      record.instruction.kind !== "PRIVATE_PAYOUT_PREPARATION" ||
      record.instruction.spending_authorized !== false ||
      record.instruction.receiver_policy !== "ORCHARD_REQUIRED" ||
      !sameBinding(binding, record.instruction.binding)
    )
      deny();
  }
  if (
    (record.state === "TX_PREPARING" && record.instruction === null) ||
    (record.state === "RESERVED" && record.instruction !== null)
  )
    deny();
}

function ownRecord(record: ClaimReservation): ClaimReservation {
  checkRecord(record, record.binding);
  if (
    Object.isFrozen(record) &&
    Object.isFrozen(record.binding) &&
    (record.instruction === null ||
      (Object.isFrozen(record.instruction) &&
        Object.isFrozen(record.instruction.binding)))
  )
    return record;
  const binding = ownBinding(record.binding);
  return Object.freeze({
    ...record,
    binding,
    instruction:
      record.instruction === null
        ? null
        : Object.freeze({ ...record.instruction, binding }),
  });
}

/** All rejections are indistinguishable error text; entire HTTP timing/rate
 * limiting is NOT claimed constant-time. Secret/destination never appear in errors.
 */
export async function verifyClaim(
  request: ClaimRequest,
  context: ClaimContext,
  checks: ClaimChecks,
): Promise<ClaimProposal> {
  let secret: Uint8Array | undefined;
  try {
    exact(request, [
      "market_id",
      "ticket_id",
      "claim_secret",
      "payout_ua",
      "idempotency_key",
    ]);
    if (
      !(request.claim_secret instanceof Uint8Array) ||
      request.claim_secret.length !== 32
    )
      deny();
    secret = new Uint8Array(request.claim_secret);
    const market = request.market_id,
      ticket = request.ticket_id,
      ua = request.payout_ua,
      key = request.idempotency_key;
    nonempty(market);
    if (!/^[0-9a-f]{64}$/.test(ticket) || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
      deny();
    nonempty(ua, 1024);
    exact(context.gate, [
      "market_id",
      "market_state",
      "market_revision",
      "ledger_root",
      "resolution_ref",
      "outcome",
      "mode",
      "publication_receipt_ref",
      "claim_policy_ref",
    ]);
    const gate = Object.freeze({ ...context.gate });
    nonempty(gate.resolution_ref);
    nonempty(gate.publication_receipt_ref);
    nonempty(gate.claim_policy_ref);
    if (
      market !== gate.market_id ||
      context.safety_hold_ref !== null ||
      typeof gate.market_revision !== "bigint" ||
      gate.market_revision < 1n ||
      typeof checks.authorize !== "function" ||
      checks.authorize(gate) !== "AUTHORIZED"
    )
      deny();
    // SPEC §20: trusted market/state, ticket/membership, credential, eligibility,
    // prior claim, address, deterministic entitlement, then proposed reservation.
    const credential = context.credential;
    if (
      !credential ||
      credential.ticket_id !== ticket ||
      credential.profile !== "DARKPOOL_CLAIM_V1_ID_FRAME_1" ||
      !context.snapshot.records.some((r) => r.ticket_id === ticket)
    )
      deny();
    if (!matchesCredential(market, ticket, secret, credential.commitment))
      deny();
    const prepared = prepareResolutionSettlement(
      context.snapshot,
      context.preparation_request,
      context.preparation_configuration,
      context.preparation,
    );
    if (
      gate.market_id !== prepared.binding.context.market_id ||
      gate.ledger_root !== prepared.binding.commitment.merkle_root ||
      gate.outcome !== prepared.binding.resolution.outcome ||
      gate.mode !== prepared.calculation.mode
    )
      deny();
    const item = prepared.calculation.entitlements.find(
      (e) => e.ticket_id === ticket,
    );
    if (!item) deny();
    const refund =
      prepared.calculation.mode === "NO_WINNER_REFUND" ||
      prepared.calculation.mode === "VOID_REFUND";
    const amount = refund ? item.refund_zat : item.winning_payout_zat;
    if (amount <= 0n) deny();
    const entitlement = context.entitlement_ref;
    nonempty(entitlement);
    const existing = context.existing;
    if (
      existing &&
      (existing.state === "CONFIRMED" ||
        existing.binding.idempotency_key !== key ||
        existing.binding.payout_ua !== ua)
    )
      deny();
    if (
      typeof checks.destination !== "function" ||
      typeof checks.freshness !== "function"
    )
      deny();
    const destination = await checks.destination(ua);
    exact(destination, ["payout_ua", "orchard_receiver_hex"]);
    if (
      destination.payout_ua !== ua ||
      !/^[0-9a-f]{86}$/.test(destination.orchard_receiver_hex)
    )
      deny();
    const ownedDestination = Object.freeze({ ...destination });
    // Exact retries keep their existing receiver; freshness must allow that
    // same reservation while rejecting receiver reuse for a new obligation.
    if (checks.freshness(ownedDestination) !== "FRESH") deny();
    const binding: ClaimBinding = Object.freeze({
      ...gate,
      ticket_id: ticket,
      entitlement_ref: entitlement,
      idempotency_key: key,
      payout_ua: ua,
      orchard_receiver_hex: ownedDestination.orchard_receiver_hex,
      amount_zat: amount,
      kind: refund ? "REFUND" : "PAYOUT",
      refund_reason: refund
        ? gate.mode === "VOID_REFUND"
          ? "VOID"
          : "NO_WINNER_REFUND"
        : null,
      fee_mode: "EXTERNALLY_SUBSIDIZED",
    });
    if (existing) {
      checkRecord(existing, binding);
      if (existing.state === "CONFIRMED") deny();
    }
    return Object.freeze({ kind: "PRIVATE_UNRESERVED_CLAIM", binding });
  } catch {
    return deny();
  } finally {
    secret?.fill(0);
  }
}

/** Pure compare-and-swap proposal, NOT an atomic store. An approved durable
 * adapter must compare expected_revision and enforce unique ticket/entitlement
 * and key scope in one transaction. Never dispatch an uncommitted proposal.
 */
export function reserveClaim(
  proposal: ClaimProposal,
  current: ClaimReservation | null,
): ClaimChange {
  exact(proposal, ["kind", "binding"]);
  if (proposal.kind !== "PRIVATE_UNRESERVED_CLAIM") deny();
  const binding = ownBinding(proposal.binding);
  if (current) {
    checkRecord(current, proposal.binding);
    return Object.freeze({
      expected_revision: current.revision,
      next: ownRecord(current),
    });
  }
  return Object.freeze({
    expected_revision: null,
    next: Object.freeze({
      revision: 1n,
      state: "RESERVED",
      binding,
      instruction: null,
      tx_ref: null,
      reconciliation_required: false,
    }),
  });
}
/** Only construct from a committed reservation supplied by trusted storage. */
export function preparePayout(current: ClaimReservation): ClaimChange {
  current = ownRecord(current);
  checkRecord(current, current.binding);
  if (
    current.reconciliation_required ||
    current.tx_ref !== null ||
    !["RESERVED", "TX_PREPARING", "RETRYABLE_FAILURE"].includes(current.state)
  )
    deny();
  if (current.state === "TX_PREPARING" && current.instruction)
    return Object.freeze({
      expected_revision: current.revision,
      next: current,
    });
  const instruction: PayoutInstruction =
    current.instruction ??
    Object.freeze({
      kind: "PRIVATE_PAYOUT_PREPARATION",
      spending_authorized: false,
      binding: ownBinding(current.binding),
      receiver_policy: "ORCHARD_REQUIRED",
    });
  return Object.freeze({
    expected_revision: current.revision,
    next: Object.freeze({
      ...current,
      revision: current.revision + 1n,
      state: "TX_PREPARING",
      instruction,
    }),
  });
}
/** Safe pre-submission failure only. Never releases principal or changes identity. */
export function failBeforeSubmission(current: ClaimReservation): ClaimChange {
  current = ownRecord(current);
  checkRecord(current, current.binding);
  if (
    current.tx_ref !== null ||
    current.reconciliation_required ||
    !["RESERVED", "TX_PREPARING"].includes(current.state)
  )
    deny();
  return Object.freeze({
    expected_revision: current.revision,
    next: Object.freeze({
      ...current,
      revision: current.revision + 1n,
      state: "RETRYABLE_FAILURE",
    }),
  });
}

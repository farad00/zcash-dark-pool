/**
 * Private, pure entitlement calculation: SPEC §§1,16–19,24.
 * Callers supply the COMPLETE frozen CONFIRMED ledger for ONE market, not a
 * claimant subset. This module cannot establish acceptance, freeze, resolution
 * authority, wallet solvency or payment. Never expose its results publicly.
 */
import type { Ticket, Resolution } from "../src/domain.ts";
import type { AmountBounds } from "../src/money.ts";
import { checkedAdd, checkedMultiply } from "../src/money.ts";

export type AcceptedTicket = Pick<
  Ticket,
  "ticket_id" | "side" | "accepted_amount_zat"
>;

export interface SettlementPolicy {
  /** Explicit SPEC §18 branch, not a default or live-market policy approval. */
  readonly fee_mode: "EXTERNALLY_SUBSIDIZED";
  /** Existing frozen market bounds; no universal economic cap is invented. */
  readonly stake_bounds: AmountBounds;
  /** Caller-selected accounting/storage and wide intermediate limits. */
  readonly max_total_zat: bigint;
  readonly max_numerator_zat_squared: bigint;
}

export interface TicketEntitlement {
  readonly ticket_id: Ticket["ticket_id"];
  readonly winning_payout_zat: bigint;
  readonly refund_zat: bigint;
}

export interface SettlementCalculation {
  readonly mode:
    "EMPTY" | "WINNING_PAYOUT" | "NO_WINNER_REFUND" | "VOID_REFUND";
  readonly outcome: Resolution["outcome"];
  readonly yes_stake_zat: bigint;
  readonly no_stake_zat: bigint;
  readonly total_accepted_zat: bigint;
  readonly winning_stake_zat: bigint;
  readonly distributable_pool_zat: bigint;
  readonly total_winning_payout_zat: bigint;
  readonly total_refund_zat: bigint;
  /** All tickets, sorted by canonical Phase 7 ID, including zero-paid losers. */
  readonly entitlements: readonly TicketEntitlement[];
}

function nonnegative(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError("Expected nonnegative integer zatoshis");
  }
}

function compareIds(a: string, b: string): number {
  // Phase 7 IDs: fixed-width lowercase ASCII hex. No locale/case normalization.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SPEC §18 externally subsidized fees only. Network fees are outside D=T;
 * there is no platform rake. Pool-funded refund allocation remains unpinned.
 * Throws fixed TypeError/RangeError messages without echoing private input.
 */
export function calculateSubsidizedSettlement(
  tickets: readonly AcceptedTicket[],
  outcome: Resolution["outcome"],
  policy: SettlementPolicy,
): SettlementCalculation {
  if (outcome !== "YES" && outcome !== "NO" && outcome !== "VOID") {
    throw new TypeError("Invalid resolution outcome");
  }
  if (policy?.fee_mode !== "EXTERNALLY_SUBSIDIZED") {
    throw new TypeError("Explicit externally subsidized fee policy required");
  }
  nonnegative(policy.stake_bounds?.min);
  nonnegative(policy.stake_bounds?.max);
  nonnegative(policy.max_total_zat);
  nonnegative(policy.max_numerator_zat_squared);
  if (policy.stake_bounds.min > policy.stake_bounds.max) {
    throw new RangeError("Invalid stake bounds");
  }
  if (!Array.isArray(tickets)) throw new TypeError("Expected accepted ledger");

  const seen = new Set<string>();
  let yes = 0n;
  let no = 0n;
  let total = 0n;
  const ordered: AcceptedTicket[] = [];
  for (const ticket of tickets) {
    if (
      typeof ticket?.ticket_id !== "string" ||
      ticket.ticket_id.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(ticket.ticket_id)
    ) {
      throw new TypeError("Invalid canonical ticket identifier");
    }
    if (seen.has(ticket.ticket_id))
      throw new TypeError("Duplicate ticket identifier");
    seen.add(ticket.ticket_id);
    if (ticket.side !== "YES" && ticket.side !== "NO") {
      throw new TypeError("Invalid ticket side");
    }
    const stake = ticket.accepted_amount_zat;
    nonnegative(stake);
    if (
      stake === 0n ||
      stake < policy.stake_bounds.min ||
      stake > policy.stake_bounds.max
    ) {
      throw new RangeError("Accepted stake outside frozen bounds");
    }
    total = checkedAdd(total, stake, policy.max_total_zat);
    if (ticket.side === "YES")
      yes = checkedAdd(yes, stake, policy.max_total_zat);
    else no = checkedAdd(no, stake, policy.max_total_zat);
    ordered.push({
      ticket_id: ticket.ticket_id,
      side: ticket.side,
      accepted_amount_zat: stake,
    });
  }
  ordered.sort((a, b) => compareIds(a.ticket_id, b.ticket_id));
  const winning = outcome === "YES" ? yes : outcome === "NO" ? no : 0n;
  const mode =
    total === 0n
      ? "EMPTY"
      : outcome === "VOID"
        ? "VOID_REFUND"
        : winning === 0n
          ? "NO_WINNER_REFUND"
          : "WINNING_PAYOUT";
  const payouts = new Map<string, bigint>();
  if (mode === "WINNING_PAYOUT") {
    const winners = ordered
      .filter((ticket) => ticket.side === outcome)
      .map((ticket) => {
        const numerator = checkedMultiply(
          ticket.accepted_amount_zat,
          total,
          policy.max_numerator_zat_squared,
        );
        return {
          ticket_id: ticket.ticket_id,
          base: numerator / winning,
          remainder: numerator % winning,
        };
      });
    let baseTotal = 0n;
    for (const winner of winners) {
      baseTotal = checkedAdd(baseTotal, winner.base, policy.max_total_zat);
    }
    let residual = total - baseTotal;
    if (residual < 0n || residual >= BigInt(winners.length)) {
      throw new RangeError("Settlement residual invariant failed");
    }
    winners.sort((a, b) =>
      a.remainder > b.remainder
        ? -1
        : a.remainder < b.remainder
          ? 1
          : compareIds(a.ticket_id, b.ticket_id),
    );
    for (const winner of winners) {
      payouts.set(
        winner.ticket_id,
        checkedAdd(winner.base, residual > 0n ? 1n : 0n, policy.max_total_zat),
      );
      if (residual > 0n) residual -= 1n;
    }
    if (residual !== 0n)
      throw new RangeError("Settlement residual invariant failed");
  }
  const refunds = mode === "NO_WINNER_REFUND" || mode === "VOID_REFUND";
  let payoutTotal = 0n;
  let refundTotal = 0n;
  const entitlements = ordered.map((ticket) => {
    const payout = payouts.get(ticket.ticket_id) ?? 0n;
    const refund = refunds ? ticket.accepted_amount_zat : 0n;
    payoutTotal = checkedAdd(payoutTotal, payout, policy.max_total_zat);
    refundTotal = checkedAdd(refundTotal, refund, policy.max_total_zat);
    return Object.freeze({
      ticket_id: ticket.ticket_id,
      winning_payout_zat: payout,
      refund_zat: refund,
    });
  });
  if (checkedAdd(payoutTotal, refundTotal, policy.max_total_zat) !== total) {
    throw new RangeError("Settlement conservation invariant failed");
  }
  return Object.freeze({
    mode,
    outcome,
    yes_stake_zat: yes,
    no_stake_zat: no,
    total_accepted_zat: total,
    winning_stake_zat: winning,
    distributable_pool_zat: total,
    total_winning_payout_zat: payoutTotal,
    total_refund_zat: refundTotal,
    entitlements: Object.freeze(entitlements),
  });
}

/**
 * In-memory V1 logical types derived from SPEC. These are NOT wire encodings,
 * DB schemas, validators or authorization evidence. Private types must not be
 * serialized into public routes/logs. readonly prevents accidental mutation;
 * persistence, runtime validation and atomicity are later-phase responsibilities.
 */
declare const referenceKind: unique symbol;
export type Reference<Kind extends string> = string & {
  readonly [referenceKind]: Kind;
};
export type MarketId = Reference<"market-id">;
/** Issuance must prove >=128 bits CSPRNG entropy; representation/handshake remain unpinned. */
export type TicketId = Reference<"ticket-id">;
export type UtcTimestamp = Reference<"utc-timestamp">;
export type Hash256 = Reference<"hash-256">;
export type ClaimCommitment = Reference<"claim-commitment">;
export type Testnet = "testnet";
export type Side = "YES" | "NO";

export const MARKET_STATUSES = [
  "DRAFT",
  "OPEN",
  "PAUSED",
  "LOCKED",
  "RESOLVED",
  "PAYING",
  "VOID",
  "REFUNDING",
  "CLOSED",
] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

/** Suggested vocabulary, SPEC §11. Does not implement classification rules. */
export const PAYMENT_STATUSES = [
  "AWAITING_PAYMENT",
  "DETECTED",
  "UNDERPAID",
  "CONFIRMED",
  "LATE",
  "EXCESS",
  "INVALID",
  "REFUND_REQUIRED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
/** Suggested vocabulary, SPEC §21. BROADCAST is not paid. */
export const CLAIM_STATUSES = [
  "UNCLAIMED",
  "RESERVED",
  "TX_PREPARING",
  "AWAITING_SIGNATURE",
  "BROADCAST",
  "CONFIRMED",
  "RETRYABLE_FAILURE",
  "TERMINAL_FAILURE",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Explicit unresolved profile reference; never a default implementation of a policy. */
export type PolicyRef =
  | { readonly status: "UNPINNED"; readonly issue: string }
  | {
      readonly status: "PINNED";
      readonly reviewed_profile_ref: Reference<"profile">;
    };

export interface Version1 {
  readonly version: 1;
  readonly network: Testnet;
}

/** Allocated by maintained wallet APIs in ONE market vault, fresh for EACH ticket. */
export interface TicketReceiver {
  readonly network: Testnet;
  readonly vault_context_ref: Reference<"vault-context">;
  readonly receiver_ref: Reference<"shielded-receiver">;
  readonly diversifier_ref: Reference<"scoped-diversifier">;
}

/** A maintained wallet adapter must validate testnet + supported shielded UA.
 * This type cannot itself prove validity/freshness or authorize transparent selection.
 */
export type ShieldedUa = Reference<"wallet-validated-testnet-shielded-ua">;

export interface Market extends Version1 {
  readonly market_id: MarketId;
  readonly question: string;
  readonly yes_definition: string;
  readonly no_definition: string;
  readonly opens_at: UtcTimestamp;
  readonly close_rule: {
    readonly utc_close_time: UtcTimestamp;
    readonly chain_boundary_policy: PolicyRef;
  };
  readonly resolution_rule: string;
  readonly resolution_sources: readonly string[];
  readonly void_conditions: readonly string[];
  readonly min_stake_zat: bigint;
  readonly max_stake_zat: bigint;
  readonly payment_acceptance_policy: PolicyRef;
  readonly fee_policy: PolicyRef;
  readonly zero_winner_policy: "NO_WINNER_REFUND";
  readonly status: MarketStatus;
}

/** Confidential independent bearer record, SPEC §4; NO claim_secret/user_id. */
export interface Ticket extends Version1 {
  readonly ticket_id: TicketId;
  readonly market_id: MarketId;
  readonly side: Side;
  readonly requested_amount_zat: bigint;
  readonly accepted_amount_zat: bigint;
  readonly receiver_ref: TicketReceiver["receiver_ref"];
  readonly diversifier_ref: TicketReceiver["diversifier_ref"];
  readonly claim_commitment: ClaimCommitment;
  readonly created_at: UtcTimestamp;
  readonly payment_deadline_ref: Reference<"payment-deadline">;
  readonly payment_state: PaymentStatus;
  // SPEC has not enumerated a separate ticket_state vocabulary.
  readonly ticket_state: PolicyRef;
  readonly accepted_payment_ref: Reference<"accepted-payment"> | null;
  readonly accepted_at: UtcTimestamp | null;
  readonly claim_state: ClaimStatus;
}

/** Local bearer credentials, not server record/API creation request/export encoding. */
export interface LocalTicket extends Version1 {
  readonly market_id: MarketId;
  readonly ticket_id: TicketId;
  readonly side: Side;
  readonly requested_amount_zat: bigint;
  readonly claim_secret: Uint8Array;
  readonly receiver: ShieldedUa;
  readonly created_at: UtcTimestamp;
}

/** Persistent private claim record; transient secret verification is a later phase. */
export interface Claim extends Version1 {
  readonly claim_ref: Reference<"claim">;
  readonly market_id: MarketId;
  readonly ticket_id: TicketId;
  readonly idempotency_key: Reference<"idempotency-key">;
  readonly payout_ua: ShieldedUa;
  readonly entitlement_zat: bigint;
  readonly state: ClaimStatus;
  readonly settlement_ref: Reference<"settlement"> | null;
  readonly tx_ref: Reference<"transaction"> | null;
}

export interface Resolution extends Version1 {
  readonly market_id: MarketId;
  readonly outcome: Side | "VOID";
  readonly resolved_at: UtcTimestamp;
  readonly evidence: readonly string[];
  readonly rule_version: Reference<"resolution-rule-version">;
  readonly actor: Reference<"actor">;
}

/** Private logical record only. Blinding bytes/placement/tree rules remain unpinned. */
export interface LedgerRecord extends Version1 {
  readonly market_id: MarketId;
  readonly ticket_id: TicketId;
  readonly side: Side;
  readonly accepted_amount_zat: bigint;
  readonly accepted_payment_ref: Reference<"accepted-payment">;
  readonly receiver_ref: TicketReceiver["receiver_ref"];
  readonly record_blinding: Uint8Array;
}

/** The public lock object, SPEC §13, with no private records or blindings. */
export interface LedgerCommitment {
  readonly market_id: MarketId;
  readonly ledger_version: 1;
  readonly accepted_ticket_count: bigint;
  readonly merkle_root: Hash256;
  readonly locked_at: UtcTimestamp;
}

/** Private item, not a calculation/approval/authorization API. */
export interface SettlementItem extends Version1 {
  readonly ticket_id: TicketId;
  readonly claim_ref: Reference<"claim">;
  readonly destination: ShieldedUa;
  readonly amount_zat: bigint;
}

/** SPEC §26. Hash construction and plan approval are intentionally not implemented. */
export interface SettlementPlan extends Version1 {
  readonly settlement_id: Reference<"settlement">;
  readonly market_id: MarketId;
  readonly resolution_ref: Reference<"resolution">;
  readonly ledger_root: Hash256;
  readonly outputs: readonly SettlementItem[];
  readonly total_output_zat: bigint;
  readonly expected_fee_zat: bigint;
  readonly plan_hash: Hash256;
}

/** Economic reason is distinct from the nine public states; exceptions require review. */
export type RefundReason =
  | { readonly kind: "VOID" | "NO_WINNER_REFUND" }
  | { readonly kind: "PAYMENT_EXCEPTION"; readonly policy: PolicyRef };
export interface Refund extends Version1 {
  readonly ticket_id: TicketId;
  readonly reason: RefundReason;
  readonly claim: Claim;
}

export const AUDIT_EVENT_KINDS = [
  "MARKET_OPENED",
  "MARKET_PAUSED",
  "MARKET_REOPENED",
  "MARKET_LOCK_FINALIZATION_STARTED",
  "MARKET_LOCKED",
  "LEDGER_COMMITTED",
  "MARKET_RESOLVED",
  "MARKET_VOIDED",
  "TICKET_CONFIRMED",
  "CLAIM_RESERVED",
  "SETTLEMENT_PLAN_CREATED",
  "TX_AUTHORIZED",
  "TX_BROADCAST",
  "CLAIM_CONFIRMED",
  "REFUND_CONFIRMED",
] as const;
/** Narrow logical audit envelope, SPEC §§7,32. No free-form secret-bearing payload. */
export interface AuditEvent extends Version1 {
  readonly event: (typeof AUDIT_EVENT_KINDS)[number];
  readonly market_id: MarketId;
  readonly timestamp: UtcTimestamp;
  readonly source: Reference<"actor-or-system">;
  readonly trigger_ref: Reference<"audit-trigger">;
  readonly transition: {
    readonly prior_state: MarketStatus;
    readonly new_state: MarketStatus;
  } | null;
  readonly chain_ref: Reference<"chain-evidence"> | null;
}

/** Minimum allowed public metadata; no optional count profile or status-read policy chosen. */
export interface PublicMarket extends Version1 {
  readonly market_id: MarketId;
  readonly question: string;
  readonly yes_definition: string;
  readonly no_definition: string;
  readonly opens_at: UtcTimestamp;
  readonly closes_at: UtcTimestamp;
  readonly resolution_rule: string;
  readonly resolution_sources: readonly string[];
  readonly void_conditions: readonly string[];
  readonly status: MarketStatus;
}

export function isSide(value: unknown): value is Side {
  return value === "YES" || value === "NO";
}

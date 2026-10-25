import type {
  AuditEvent,
  Claim,
  LedgerCommitment,
  LocalTicket,
  Market,
  MarketStatus,
  PublicMarket,
  SettlementPlan,
  Ticket,
  Testnet,
} from "../src/domain.js";
import type { ClaimCommitmentInputV1 } from "../src/claim-commitment.js";

type Assert<T extends true> = T;
type Absent<T, Keys extends PropertyKey> =
  Extract<keyof T, Keys> extends never ? true : false;
export type TicketPrivacy = Assert<
  Absent<Ticket, "user_id" | "claim_secret" | "ufvk" | "spending_key">
>;
export type ClaimPrivacy = Assert<Absent<Claim, "claim_secret" | "user_id">>;
export type AuditPrivacy = Assert<
  Absent<
    AuditEvent,
    "claim_secret" | "spending_key" | "seed" | "shares" | "payload"
  >
>;
export type LocalBearer = Assert<
  "claim_secret" extends keyof LocalTicket ? true : false
>;
export type ZatoshiStake = Assert<
  Ticket["requested_amount_zat"] extends bigint ? true : false
>;
export type ZatoshiPlan = Assert<
  SettlementPlan["total_output_zat"] extends bigint ? true : false
>;
export type PublicBookPrivacy = Assert<
  Absent<
    PublicMarket,
    | "side"
    | "ticket_id"
    | "odds"
    | "pool_total"
    | "yes_count"
    | "no_count"
    | "total_confirmed_count"
    | "payout_ua"
    | "ufvk"
    | "tickets"
  >
>;
export type LockPrivacy = Assert<
  Absent<
    LedgerCommitment,
    "records" | "record_blinding" | "receiver_ref" | "ufvk"
  >
>;
export type NoInternalPublicState = Assert<
  Extract<MarketStatus, "LOCK_FINALIZING" | "NO_WINNER_REFUND"> extends never
    ? true
    : false
>;
export type OnlyTestnet = Assert<Testnet extends "testnet" ? true : false>;

declare const ticket: Ticket;
declare const market: Market;
// @ts-expect-error Secret belongs only to the client bearer credential.
void ticket.claim_secret;
// @ts-expect-error Economic values cannot be floating point.
const amount: Ticket["requested_amount_zat"] = 0.01;
// @ts-expect-error Readonly domain records guard accidental in-place edits.
market.close_rule.utc_close_time = market.opens_at;
// @ts-expect-error Unpinned policy cannot be replaced by an invented string rule.
const policy: Market["fee_policy"] = "operator-keeps-dust";
void amount;
void policy;
// @ts-expect-error Only the approved V1 encoding can be requested.
const claimVersion: ClaimCommitmentInputV1["version"] = 2;
void claimVersion;

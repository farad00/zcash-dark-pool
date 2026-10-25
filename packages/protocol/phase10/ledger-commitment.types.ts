import type { LedgerRecord } from "../src/domain.ts";
import {
  recomputeLedgerCommitment,
  createPrivateBlindedLedger,
} from "./ledger-commitment.ts";
import type {
  LedgerContext,
  LedgerLimits,
  UnblindedLedgerRecord,
} from "./ledger-commitment.ts";
declare const context: LedgerContext;
declare const limits: LedgerLimits;
declare const records: readonly LedgerRecord[];
declare const unblinded: readonly UnblindedLedgerRecord[];
const publicResult = recomputeLedgerCommitment(context, records, limits);
const count: string = publicResult.accepted_ticket_count;
void count;
createPrivateBlindedLedger(context, unblinded, limits);
// @ts-expect-error Unblinded records cannot be silently used for recomputation.
recomputeLedgerCommitment(context, unblinded, limits);
// @ts-expect-error Public results contain no private records.
void publicResult.records;
// @ts-expect-error Public results contain no blindings.
void publicResult.record_blinding;
// @ts-expect-error Public root is immutable.
publicResult.merkle_root = "different";

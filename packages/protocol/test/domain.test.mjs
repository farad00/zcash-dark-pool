import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIM_STATUSES,
  MARKET_STATUSES,
  PAYMENT_STATUSES,
  isSide,
} from "../dist/index.js";

test("SPEC §7: exactly nine public states; no internal close/refund mode added", () => {
  assert.deepEqual(MARKET_STATUSES, [
    "DRAFT",
    "OPEN",
    "PAUSED",
    "LOCKED",
    "RESOLVED",
    "PAYING",
    "VOID",
    "REFUNDING",
    "CLOSED",
  ]);
  assert.equal(new Set(MARKET_STATUSES).size, 9);
});

test("U07 portion: positions remain binary; suggested payment/claim vocabularies", () => {
  assert.equal(isSide("YES"), true);
  assert.equal(isSide("NO"), true);
  for (const value of ["VOID", "yes", "", 0, null, {}])
    assert.equal(isSide(value), false);
  assert.deepEqual(PAYMENT_STATUSES, [
    "AWAITING_PAYMENT",
    "DETECTED",
    "UNDERPAID",
    "CONFIRMED",
    "LATE",
    "EXCESS",
    "INVALID",
    "REFUND_REQUIRED",
  ]);
  assert.deepEqual(CLAIM_STATUSES, [
    "UNCLAIMED",
    "RESERVED",
    "TX_PREPARING",
    "AWAITING_SIGNATURE",
    "BROADCAST",
    "CONFIRMED",
    "RETRYABLE_FAILURE",
    "TERMINAL_FAILURE",
  ]);
});

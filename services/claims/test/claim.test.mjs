import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  verifyClaim,
  reserveClaim,
  preparePayout,
  failBeforeSubmission,
} from "../claim.mts";
import { matchesCredential, validateDestination } from "../primitives.mjs";
import { deriveClaimCommitment } from "../../../packages/protocol/src/claim-commitment.ts";
import { recomputeLedgerCommitment } from "../../../packages/protocol/phase10/ledger-commitment.ts";
import { prepareResolutionSettlement } from "../../../packages/protocol/phase12/preparation.ts";

const env = { DARKPOOL_SYNTHETIC_TEST: "1", ZCASH_NETWORK: "testnet" };
for (const k of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"])
  if (process.env[k]) env[k] = process.env[k];
const ua = execFileSync(
  fileURLToPath(
    new URL(
      `../../../target/debug/examples/payment-request-fixture${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  ),
  [],
  { env, windowsHide: true, encoding: "utf8" },
).trim();
const id = (n) => n.toString(16).padStart(64, "0");
const reject = (promise) =>
  assert.rejects(promise, (e) => e.message === "CLAIM_REJECTED");
function fixture(outcome = "YES", sides = ["YES", "NO"], index = 0) {
  const market = "synthetic-phase13",
    context = {
      profile: "DARKPOOL_LEDGER_V1_BIN1_B2B256",
      version: 1,
      network: "testnet",
      market_id: market,
      locked_at: "2026-10-19T12:00:00.000000Z",
    };
  const limits = {
    stake_bounds: { min: 1n, max: 1000n },
    max_tickets: 100n,
    max_text_bytes: 4096,
    max_amount_bytes: 16,
    max_ledger_bytes: 100000,
  };
  const records = sides.map((side, i) => ({
    version: 1,
    network: "testnet",
    market_id: market,
    ticket_id: id(i + 1),
    side,
    accepted_amount_zat: BigInt(i + 2),
    accepted_payment_ref: `synthetic-payment-${i}`,
    receiver_ref: `synthetic-receiver-${i}`,
    record_blinding: new Uint8Array(32).fill(i + 1),
  }));
  const snapshot = {
    status: "LOCKED",
    revision: 2n,
    frozen_at: context.locked_at,
    safety_hold_ref: null,
    context,
    records,
  };
  const preparation_request = {
    request_key: "synthetic_resolution",
    expected_revision: 2n,
    resolution: {
      version: 1,
      network: "testnet",
      market_id: market,
      outcome,
      resolved_at: "2026-10-19T13:00:00.000000Z",
      evidence: ["synthetic-objective-evidence"],
      rule_version: "synthetic-rule-v1",
      actor: "synthetic-referee",
    },
  };
  const preparation_configuration = {
    commitment: recomputeLedgerCommitment(context, records, limits),
    oracle_rule: {
      question: "Synthetic event?",
      yes_definition: "Yes",
      no_definition: "No",
      resolution_rule: "Synthetic observation at 13:00 UTC",
      resolution_sources: ["synthetic-source"],
      void_conditions: ["Ambiguous"],
      rule_version: "synthetic-rule-v1",
    },
    ledger_limits: limits,
    settlement_policy: {
      fee_mode: "EXTERNALLY_SUBSIDIZED",
      stake_bounds: { ...limits.stake_bounds },
      max_total_zat: 10000n,
      max_numerator_zat_squared: 100000000n,
    },
    review_oracle: () => "DEFENSIBLE",
  };
  const preparation = prepareResolutionSettlement(
    snapshot,
    preparation_request,
    preparation_configuration,
    null,
  );
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i),
    ticket = id(index + 1);
  const request = {
    market_id: market,
    ticket_id: ticket,
    claim_secret: secret,
    payout_ua: ua,
    idempotency_key: "synthetic_claim_1",
  };
  const gate = {
    market_id: market,
    market_state: preparation.calculation.mode.includes("REFUND")
      ? "REFUNDING"
      : "PAYING",
    market_revision: 5n,
    ledger_root: preparation.binding.commitment.merkle_root,
    resolution_ref: "synthetic-durable-resolution",
    outcome,
    mode: preparation.calculation.mode,
    publication_receipt_ref: "synthetic-verified-publication",
    claim_policy_ref: "SYNTHETIC_CLAIMS_TEST_ONLY",
  };
  const ctx = {
    gate,
    safety_hold_ref: null,
    snapshot,
    preparation_request,
    preparation_configuration,
    preparation,
    credential: {
      ticket_id: ticket,
      profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1",
      commitment: deriveClaimCommitment({
        version: 1,
        market_id: market,
        ticket_id: ticket,
        claim_secret: secret,
      }),
    },
    entitlement_ref: `synthetic-entitlement-${index}`,
    existing: null,
  };
  const used = new Set();
  const checks = {
    // TEST profile only: no deployment approval of claimable states/key scope.
    authorize: (g) => {
      assert.equal(g.claim_policy_ref, "SYNTHETIC_CLAIMS_TEST_ONLY");
      assert.equal(g.publication_receipt_ref, "synthetic-verified-publication");
      assert.equal(g.resolution_ref, "synthetic-durable-resolution");
      assert.equal(g.market_revision, 5n);
      assert.equal(
        g.market_state,
        g.mode.includes("REFUND") ? "REFUNDING" : "PAYING",
      );
      return "AUTHORIZED";
    },
    destination: validateDestination,
    freshness: (d) => {
      if (
        used.has(d.orchard_receiver_hex) &&
        ctx.existing?.binding.orchard_receiver_hex !== d.orchard_receiver_hex
      )
        throw new Error("synthetic reused receiver");
      return "FRESH";
    },
  };
  return {
    request,
    ctx,
    checks,
    used,
    run: () => verifyClaim(request, ctx, checks),
  };
}
test("winning YES credential creates exact private non-spending payout preparation", async () => {
  const f = fixture(),
    before = f.request.claim_secret.slice(),
    p = await f.run(),
    r = reserveClaim(p, null).next,
    i = preparePayout(r).next;
  assert.equal(r.state, "RESERVED");
  assert.equal(i.state, "TX_PREPARING");
  assert.equal(i.instruction.spending_authorized, false);
  assert.equal(i.binding.amount_zat, 5n);
  assert.equal(i.binding.ledger_root, f.ctx.gate.ledger_root);
  assert.equal(i.binding.resolution_ref, f.ctx.gate.resolution_ref);
  assert.equal(i.binding.payout_ua, ua);
  assert.equal(i.binding.orchard_receiver_hex.length, 86);
  assert.equal(i.instruction.receiver_policy, "ORCHARD_REQUIRED");
  assert.equal(i.binding.fee_mode, "EXTERNALLY_SUBSIDIZED");
  assert.deepEqual(f.request.claim_secret, before);
});
test("winning NO uses the same original credential and exact full entitlement", async () => {
  const p = await fixture("NO", ["YES", "NO"], 1).run();
  assert.equal(p.binding.amount_zat, 5n);
  assert.equal(p.binding.kind, "PAYOUT");
});
test("independent frozen Phase 2 literal credential vectors match native comparison", () => {
  const v = JSON.parse(
    readFileSync(
      new URL(
        "../../../test-vectors/claim-commitment-v1.json",
        import.meta.url,
      ),
    ),
  );
  for (const x of v.vectors) {
    const s = new Uint8Array(Buffer.from(x.input.claim_secret_hex, "hex"));
    assert.equal(
      matchesCredential(
        x.input.market_id,
        x.input.ticket_id,
        s,
        x.expected_digest_hex,
      ),
      true,
    );
    s[0] ^= 1;
    assert.equal(
      matchesCredential(
        x.input.market_id,
        x.input.ticket_id,
        s,
        x.expected_digest_hex,
      ),
      false,
    );
  }
});
test("invalid/missing secret, ticket-only and wrong credential profile reject uniformly", async () => {
  for (const change of [
    (f) => {
      f.request.claim_secret = new Uint8Array(32).fill(99);
    },
    (f) => {
      f.request.claim_secret = new Uint8Array(31);
    },
    (f) => {
      delete f.request.claim_secret;
    },
    (f) => {
      f.ctx.credential.profile = "other";
    },
    (f) => {
      f.ctx.credential.commitment = "00".repeat(32);
    },
  ]) {
    const f = fixture();
    change(f);
    await reject(f.run());
  }
});
test("unknown ticket, absent credential and excluded membership do not disclose eligibility", async () => {
  for (const change of [
    (f) => {
      f.request.ticket_id = id(999);
    },
    (f) => {
      f.ctx.credential = null;
    },
    (f) => {
      f.ctx.snapshot.records.shift();
    },
  ]) {
    const f = fixture();
    change(f);
    await reject(f.run());
  }
});
test("losing accepted ticket never creates a positive payout instruction", async () => {
  await reject(fixture("YES", ["YES", "NO"], 1).run());
});
test("malformed, checksum-corrupt, wrong-network and transparent-only destinations reject", async () => {
  for (const bad of [
    "utest1invalid",
    ua.slice(0, -1),
    ua.toUpperCase(),
    "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
    "u1invalid",
    `${ua}?memo=secret`,
  ]) {
    const f = fixture();
    f.request.payout_ua = bad;
    await reject(f.run());
  }
});
test("destination validator cannot substitute another UA or malformed receiver", async () => {
  for (const result of [
    { payout_ua: "different", orchard_receiver_hex: "ab".repeat(43) },
    { payout_ua: ua, orchard_receiver_hex: "ab" },
  ]) {
    const f = fixture();
    f.checks.destination = async () => result;
    await reject(f.run());
  }
});
test("known receiver reuse rejects new obligation but same reserved retry recovers", async () => {
  const f = fixture(),
    p = await f.run();
  f.used.add(p.binding.orchard_receiver_hex);
  await reject(f.run());
  f.ctx.existing = reserveClaim(p, null).next;
  assert.deepEqual(await f.run(), p);
});
test("identical retry reuses reservation and prepared instruction", async () => {
  const f = fixture(),
    p = await f.run(),
    r = reserveClaim(p, null).next;
  f.ctx.existing = r;
  const p2 = await f.run();
  assert.equal(reserveClaim(p2, r).next, r);
  const prepared = preparePayout(r).next;
  assert.equal(preparePayout(prepared).next, prepared);
  f.ctx.existing = prepared;
  assert.deepEqual(await f.run(), p);
});
test("changed idempotency key or payout destination fails closed after reservation", async () => {
  for (const change of [
    (f) => {
      f.request.idempotency_key = "conflict";
    },
    (f) => {
      f.request.payout_ua = "utest1different";
    },
  ]) {
    const f = fixture();
    f.ctx.existing = reserveClaim(await f.run(), null).next;
    change(f);
    await reject(f.run());
  }
});
test("root/outcome/resolution and preparation tampering are rejected", async () => {
  for (const change of [
    (f) => {
      f.ctx.gate.ledger_root = "ff".repeat(32);
    },
    (f) => {
      f.ctx.gate.outcome = "NO";
    },
    (f) => {
      f.ctx.gate.resolution_ref = "wrong";
    },
    (f) => {
      f.ctx.snapshot.records[0].record_blinding.fill(99);
    },
    (f) => {
      const p = structuredClone(f.ctx.preparation);
      p.calculation.entitlements[0].winning_payout_zat = 999n;
      f.ctx.preparation = p;
    },
  ]) {
    const f = fixture();
    change(f);
    await reject(f.run());
  }
});
test("pending publication, missing resolution, stale revision, hold and unauthorized states reject", async () => {
  for (const change of [
    (f) => {
      f.ctx.gate.publication_receipt_ref = null;
    },
    (f) => {
      f.ctx.gate.resolution_ref = "";
    },
    (f) => {
      f.ctx.gate.market_revision = 4n;
    },
    (f) => {
      f.ctx.safety_hold_ref = "hold";
    },
    (f) => {
      f.ctx.gate.market_state = "LOCKED";
    },
    (f) => {
      f.ctx.gate.market_state = "RESOLVED";
    },
    (f) => {
      f.ctx.gate.market_state = "CLOSED";
    },
  ]) {
    const f = fixture();
    change(f);
    await reject(f.run());
  }
  const f = fixture();
  f.checks.authorize = () => true;
  await reject(f.run());
});
test("VOID refunds both sides through the same credential flow", async () => {
  for (const n of [0, 1]) {
    const p = await fixture("VOID", ["YES", "NO"], n).run();
    assert.equal(p.binding.amount_zat, BigInt(n + 2));
    assert.equal(p.binding.kind, "REFUND");
    assert.equal(p.binding.refund_reason, "VOID");
  }
});
test("no-winner refunds accepted stakes with no fee deduction", async () => {
  const p = await fixture("NO", ["YES"], 0).run();
  assert.equal(p.binding.amount_zat, 2n);
  assert.equal(p.binding.refund_reason, "NO_WINNER_REFUND");
});
test("CAS interleavings model duplicate/concurrent submissions and prepare once", async () => {
  // Synthetic store demonstrates REQUIRED CAS semantics, not PostgreSQL evidence.
  const f = fixture(),
    proposals = await Promise.all(Array.from({ length: 8 }, () => f.run()));
  let stored = null,
    commits = 0;
  const apply = (change) => {
    if ((stored?.revision ?? null) !== change.expected_revision) return false;
    stored = change.next;
    commits++;
    return true;
  };
  const reserve = proposals.map((p) => reserveClaim(p, null));
  assert.equal(reserve.filter(apply).length, 1);
  assert.equal(commits, 1);
  const preparations = Array.from({ length: 8 }, () => preparePayout(stored));
  assert.equal(preparations.filter(apply).length, 1);
  assert.equal(commits, 2);
  assert.equal(stored.state, "TX_PREPARING");
  assert.equal(
    new Set(preparations.map((c) => c.next.instruction.binding.idempotency_key))
      .size,
    1,
  );
});
test("conflicting parallel candidates cannot replace the committed binding", async () => {
  const f = fixture(),
    a = await f.run();
  f.request.idempotency_key = "another_key";
  const b = await f.run();
  const current = reserveClaim(a, null).next;
  assert.throws(() => reserveClaim(b, current), /CLAIM_REJECTED/);
});
test("pre-submission failure preserves identity, liability and original instruction", async () => {
  const r = reserveClaim(await fixture().run(), null).next;
  for (const start of [r, preparePayout(r).next]) {
    const failed = failBeforeSubmission(start).next;
    assert.equal(failed.state, "RETRYABLE_FAILURE");
    assert.equal(failed.binding.amount_zat, start.binding.amount_zat);
    const retry = preparePayout(failed).next;
    assert.deepEqual(retry.binding, start.binding);
    if (start.instruction) assert.equal(retry.instruction, start.instruction);
  }
});
test("uncertain/submitted/confirmed states never construct a replacement instruction", async () => {
  const r = preparePayout(reserveClaim(await fixture().run(), null).next).next;
  for (const patch of [
    { state: "AWAITING_SIGNATURE" },
    { state: "BROADCAST", tx_ref: "synthetic-tx" },
    { state: "CONFIRMED", tx_ref: "synthetic-tx" },
    { state: "TERMINAL_FAILURE" },
    { state: "RETRYABLE_FAILURE", reconciliation_required: true },
    { state: "RETRYABLE_FAILURE", tx_ref: "uncertain-tx" },
  ]) {
    const x = { ...r, ...patch };
    assert.throws(() => preparePayout(x), /CLAIM_REJECTED/);
    assert.throws(() => failBeforeSubmission(x), /CLAIM_REJECTED/);
  }
});
test("confirmed ticket cannot authenticate a second winner or refund claim", async () => {
  const f = fixture(),
    r = reserveClaim(await f.run(), null).next;
  f.ctx.existing = { ...r, state: "CONFIRMED", tx_ref: "synthetic-tx" };
  await reject(f.run());
});
test("secret redaction, closed request and immutable private output boundaries", async () => {
  const f = fixture();
  f.checks.authorize = () => {
    throw new Error(
      `secret ${Buffer.from(f.request.claim_secret).toString("hex")} ${ua}`,
    );
  };
  await reject(f.run());
  const g = fixture();
  g.request.amount_zat = 999n;
  await reject(g.run());
  const h = fixture();
  const p = await h.run(),
    prepared = preparePayout(reserveClaim(p, null).next).next;
  assert.throws(() => {
    p.binding.amount_zat = 999n;
  }, TypeError);
  assert.throws(() => {
    prepared.instruction.binding.payout_ua = "changed";
  }, TypeError);
  const serialized = JSON.stringify(prepared, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  for (const forbidden of [
    "claim_secret",
    "record_blinding",
    "receiver_ref",
    "claim_commitment",
    "claim_secret_hex",
  ])
    assert.ok(!serialized.includes('"' + forbidden + '"'));
});
test("invalid amounts and positive losing/refund crossover bindings cannot prepare", async () => {
  const r = reserveClaim(await fixture().run(), null).next;
  for (const patch of [
    { amount_zat: 0n },
    { amount_zat: -1n },
    { amount_zat: 1 },
    { fee_mode: "POOL_FUNDED" },
    { kind: "PAYOUT", refund_reason: "VOID" },
  ])
    assert.throws(
      () => preparePayout({ ...r, binding: { ...r.binding, ...patch } }),
      /CLAIM_REJECTED/,
    );
});

test("storage round trips own immutable instruction data and reject incomplete preparation", async () => {
  const r = reserveClaim(await fixture().run(), null).next;
  const mutable = structuredClone(r),
    prepared = preparePayout(mutable).next;
  mutable.binding.payout_ua = "changed";
  mutable.binding.amount_zat = 999n;
  assert.equal(prepared.binding.amount_zat, 5n);
  assert.equal(prepared.binding.payout_ua, ua);
  assert.equal(prepared.instruction.binding.payout_ua, ua);
  assert.ok(Object.isFrozen(prepared.binding));
  const saved = structuredClone(prepared),
    retried = preparePayout(saved).next;
  saved.instruction.binding.payout_ua = "changed";
  assert.equal(retried.instruction.binding.payout_ua, ua);
  assert.throws(
    () => preparePayout({ ...r, state: "TX_PREPARING" }),
    /CLAIM_REJECTED/,
  );
});

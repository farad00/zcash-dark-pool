import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareResolutionSettlement as prepare } from "./preparation.ts";
import { recomputeLedgerCommitment } from "../phase10/ledger-commitment.ts";

const id = (n) => n.toString(16).padStart(64, "0");
function fixture(
  outcome = "YES",
  positions = [
    ["YES", 2n],
    ["YES", 1n],
    ["NO", 2n],
  ],
) {
  const context = {
    profile: "DARKPOOL_LEDGER_V1_BIN1_B2B256",
    version: 1,
    network: "testnet",
    market_id: "synthetic-phase12",
    locked_at: "2026-10-19T12:00:00.000001Z",
  };
  const limits = {
    stake_bounds: { min: 1n, max: (1n << 128n) - 1n },
    max_tickets: 100n,
    max_text_bytes: 4096,
    max_amount_bytes: 16,
    max_ledger_bytes: 100000,
  };
  const records = positions.map(([side, stake], i) => ({
    version: 1,
    network: "testnet",
    market_id: context.market_id,
    ticket_id: id(i + 1),
    side,
    accepted_amount_zat: stake,
    accepted_payment_ref: `synthetic-payment-${i}`,
    receiver_ref: `synthetic-receiver-${i}`,
    record_blinding: new Uint8Array(32).fill(i + 1),
  }));
  const oracle = {
    question: "Was the synthetic gauge >= 10 at 13:00 UTC?",
    yes_definition: "Gauge >= 10",
    no_definition: "Gauge < 10",
    resolution_rule:
      "Observe the synthetic primary at 2026-10-19T13:00:00Z; use fallback if primary unavailable; VOID if neither is defensible.",
    resolution_sources: ["synthetic-primary", "synthetic-fallback"],
    void_conditions: ["Neither source defensible"],
    rule_version: "synthetic-rule-v1",
  };
  const resolution = {
    version: 1,
    network: "testnet",
    market_id: context.market_id,
    outcome,
    resolved_at: "2026-10-19T13:01:00.000000Z",
    evidence: ["synthetic-primary:observation-at-13:00"],
    rule_version: oracle.rule_version,
    actor: "synthetic-authorized-referee",
  };
  const snapshot = {
    status: "LOCKED",
    revision: 2n,
    frozen_at: context.locked_at,
    safety_hold_ref: null,
    context,
    records,
  };
  const request = {
    request_key: "synthetic_resolution_1",
    expected_revision: 2n,
    resolution,
  };
  // This adapter is a synthetic reviewed decision, not a production oracle.
  const review = (rule, r) => {
    assert.equal(r.outcome, outcome); // Separate synthetic reviewed decision.
    assert.deepEqual([...rule.resolution_sources], oracle.resolution_sources);
    assert.equal(r.actor, "synthetic-authorized-referee");
    assert.deepEqual(
      [...r.evidence],
      ["synthetic-primary:observation-at-13:00"],
    );
    assert.ok(r.resolved_at >= "2026-10-19T13:00:00.000000Z");
    return "DEFENSIBLE";
  };
  const config = {
    commitment: recomputeLedgerCommitment(context, records, limits),
    oracle_rule: oracle,
    ledger_limits: limits,
    settlement_policy: {
      fee_mode: "EXTERNALLY_SUBSIDIZED",
      stake_bounds: { ...limits.stake_bounds },
      max_total_zat: (1n << 128n) - 1n,
      max_numerator_zat_squared: (1n << 256n) - 1n,
    },
    review_oracle: review,
  };
  return {
    snapshot,
    request,
    config,
    run: (saved = null) => prepare(snapshot, request, config, saved),
  };
}
const amounts = (p) =>
  p.calculation.entitlements.map((x) => x.winning_payout_zat);

test("YES preparation binds exact root, market, rule, evidence and outcome", () => {
  const f = fixture(),
    p = f.run();
  assert.deepEqual(amounts(p), [3n, 2n, 0n]);
  assert.equal(p.calculation.total_accepted_zat, 5n);
  assert.equal(
    p.binding.commitment.merkle_root,
    f.config.commitment.merkle_root,
  );
  assert.equal(p.binding.context.market_id, f.request.resolution.market_id);
  assert.equal(p.binding.resolution.outcome, "YES");
  assert.equal(p.binding.resolution.rule_version, "synthetic-rule-v1");
  assert.deepEqual(
    [...p.binding.resolution.evidence],
    f.request.resolution.evidence,
  );
  assert.equal(p.lifecycle_authorized, false);
  assert.equal(p.kind, "PRIVATE_PREPARATION_ONLY");
});
test("NO preparation conserves the same whole accepted pool", () => {
  const p = fixture("NO").run();
  assert.deepEqual(amounts(p), [0n, 0n, 5n]);
  assert.equal(p.calculation.total_winning_payout_zat, 5n);
});
test("no-winner refunds return every accepted stake without a haircut", () => {
  const p = fixture("NO", [
    ["YES", 2n],
    ["YES", 1n],
  ]).run();
  assert.equal(p.calculation.mode, "NO_WINNER_REFUND");
  assert.deepEqual(amounts(p), [0n, 0n]);
  assert.deepEqual(
    p.calculation.entitlements.map((x) => x.refund_zat),
    [2n, 1n],
  );
});
test("VOID and ambiguous review refund all accepted principal", () => {
  const f = fixture("VOID");
  f.config.review_oracle = () => "AMBIGUOUS";
  const p = f.run();
  assert.equal(p.calculation.mode, "VOID_REFUND");
  assert.equal(p.calculation.total_refund_zat, 5n);
  for (const side of ["YES", "NO"]) {
    f.request.resolution.outcome = side;
    assert.throws(() => f.run(), /ORACLE_REVIEW_REJECTED/);
  }
});
test("empty verified ledger has no payout or refund for every outcome", () => {
  for (const outcome of ["YES", "NO", "VOID"]) {
    const p = fixture(outcome, []).run();
    assert.equal(p.calculation.mode, "EMPTY");
    assert.equal(p.calculation.total_accepted_zat, 0n);
    assert.deepEqual(p.calculation.entitlements, []);
  }
});
test("largest remainders and lexical ID ties survive reversed snapshot order", () => {
  const f = fixture("YES", [
    ["YES", 1n],
    ["YES", 1n],
    ["YES", 1n],
    ["NO", 2n],
  ]);
  const p = f.run();
  assert.deepEqual(amounts(p), [2n, 2n, 1n, 0n]);
  f.snapshot.records.reverse();
  assert.deepEqual(f.run(p), p);
});
test("all small synthetic preparations conserve payouts plus refunds", () => {
  for (const y of [1n, 2n, 3n])
    for (const n of [1n, 2n, 3n])
      for (const outcome of ["YES", "NO", "VOID"]) {
        const p = fixture(outcome, [
          ["YES", y],
          ["NO", n],
        ]).run().calculation;
        assert.equal(p.total_winning_payout_zat + p.total_refund_zat, y + n);
        assert.equal(p.distributable_pool_zat, y + n);
      }
});
test("independent Phase 10 literal root is verified without generating blindings", () => {
  const v = JSON.parse(
    readFileSync(new URL("../phase10/ledger-vectors.json", import.meta.url)),
  ).cases.find((x) => x.case === "leaves-1");
  const f = fixture();
  f.snapshot.context = v.context;
  f.snapshot.frozen_at = v.context.locked_at;
  f.snapshot.records = v.records.map((r) => ({
    ...r,
    accepted_amount_zat: BigInt(r.accepted_amount_zat),
    record_blinding: new Uint8Array(Buffer.from(r.record_blinding, "hex")),
  }));
  f.request.resolution.market_id = v.context.market_id;
  f.config.commitment = {
    market_id: v.context.market_id,
    ledger_version: 1,
    accepted_ticket_count: "1",
    merkle_root: v.root,
    locked_at: v.context.locked_at,
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues() {
        throw new Error("RNG forbidden");
      },
    },
  });
  try {
    assert.equal(f.run().binding.commitment.merkle_root, v.root);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});
test("wrong retained root, count, market and timestamp fail verification", () => {
  for (const patch of [
    { merkle_root: "ff".repeat(32) },
    { accepted_ticket_count: "2" },
    { market_id: "wrong-market" },
    { locked_at: "2026-10-19T12:00:00.000002Z" },
  ]) {
    const f = fixture();
    f.config.commitment = { ...f.config.commitment, ...patch };
    assert.throws(() => f.run(), /LOCKED_ROOT_VERIFICATION_FAILED/);
  }
});
test("missing/changed blindings and changed ledger fields fail closed", () => {
  for (const patch of [
    { record_blinding: undefined },
    { record_blinding: new Uint8Array(31) },
    { record_blinding: new Uint8Array(32).fill(99) },
    { side: "NO" },
    { accepted_amount_zat: 3n },
    { accepted_payment_ref: "different" },
  ]) {
    const f = fixture();
    Object.assign(f.snapshot.records[0], patch);
    assert.throws(() => f.run());
  }
});
test("duplicate IDs, records, zero stakes and unsupported policy reject", () => {
  for (const change of [
    (f) => f.snapshot.records.push(f.snapshot.records[0]),
    (f) => {
      f.snapshot.records[0].accepted_amount_zat = 0n;
    },
    (f) => {
      f.config.settlement_policy.fee_mode = "POOL_FUNDED";
    },
    (f) => {
      f.config.ledger_limits.stake_bounds.max = 1n;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => f.run());
  }
});
test("non-LOCKED, unfrozen, safety-held and revision-conflicting snapshots reject", () => {
  for (const patch of [
    { status: "OPEN" },
    { status: "RESOLVED" },
    { frozen_at: null },
    { safety_hold_ref: "synthetic-hold" },
    { revision: 3n },
    { revision: 2 },
  ]) {
    const f = fixture();
    Object.assign(f.snapshot, patch);
    assert.throws(() => f.run());
  }
  const f = fixture();
  f.request.expected_revision = 1n;
  assert.throws(() => f.run(), /PREPARATION_REVISION_CONFLICT/);
});
test("missing review, unauthorized actor and conflicting evidence are rejected", () => {
  const f = fixture();
  f.config.review_oracle = undefined;
  assert.throws(() => f.run(), /ORACLE_REVIEW_REQUIRED/);
  for (const patch of [
    { actor: "unauthorized" },
    { evidence: ["synthetic-fallback:contradictory"] },
    { resolved_at: "2026-10-19T12:30:00.000000Z" },
  ]) {
    const q = fixture();
    Object.assign(q.request.resolution, patch);
    assert.throws(() => q.run(), /ORACLE_REVIEW_REJECTED/);
  }
  for (const value of [true, false, undefined, "UNKNOWN"]) {
    const q = fixture();
    q.config.review_oracle = () => value;
    assert.throws(() => q.run(), /ORACLE_REVIEW_REJECTED/);
  }
});
test("wrong outcome, market, network and rule version reject before review", () => {
  for (const patch of [
    { outcome: "MAYBE" },
    { market_id: "other" },
    { network: "mainnet" },
    { rule_version: "replacement" },
  ]) {
    const f = fixture();
    Object.assign(f.request.resolution, patch);
    f.config.review_oracle = () => {
      assert.fail("must not review malformed binding");
    };
    assert.throws(() => f.run(), /ORACLE_BINDING_INVALID/);
  }
});
test("missing/duplicate evidence, invalid timestamps and malformed rule text reject", () => {
  for (const patch of [
    { evidence: [] },
    { evidence: ["same", "same"] },
    { evidence: [""] },
    { resolved_at: "2026-02-30T13:01:00.000000Z" },
    { resolved_at: "2026-10-19T11:00:00.000000Z" },
  ]) {
    const f = fixture();
    Object.assign(f.request.resolution, patch);
    assert.throws(() => f.run());
  }
  for (const patch of [
    { resolution_sources: [] },
    { void_conditions: [] },
    { resolution_rule: "" },
    { question: "\ud800" },
  ]) {
    const f = fixture();
    Object.assign(f.config.oracle_rule, patch);
    assert.throws(() => f.run());
  }
});
test("exact retry is deterministic and changed evidence/outcome/request/policy conflicts", () => {
  const f = fixture(),
    p = f.run();
  assert.deepEqual(f.run(p), p);
  for (const change of [
    (q) => {
      q.request.resolution.outcome = "NO";
      q.config.review_oracle = () => "DEFENSIBLE";
    },
    (q) => {
      q.request.resolution.evidence = ["changed-evidence"];
      q.config.review_oracle = () => "DEFENSIBLE";
    },
    (q) => {
      q.request.request_key = "different-key";
    },
    (q) => {
      q.config.oracle_rule.resolution_rule += " changed";
    },
    (q) => {
      q.config.settlement_policy.max_total_zat -= 1n;
    },
    (q) => {
      q.request.resolution.resolved_at = "2026-10-19T13:01:00.000001Z";
    },
  ]) {
    const q = fixture();
    change(q);
    assert.throws(() => q.run(p), /PREPARATION_RETRY_CONFLICT/);
  }
});
test("even a newly self-consistent replacement ledger conflicts with prior preparation", () => {
  const f = fixture(),
    p = f.run();
  f.snapshot.records[0].accepted_amount_zat = 3n;
  f.config.commitment = recomputeLedgerCommitment(
    f.snapshot.context,
    f.snapshot.records,
    f.config.ledger_limits,
  );
  assert.throws(() => f.run(p), /PREPARATION_RETRY_CONFLICT/);
  const forged = structuredClone(p);
  forged.calculation.entitlements[0].winning_payout_zat = 1n;
  const q = fixture();
  assert.throws(() => q.run(forged), /PREPARATION_RETRY_CONFLICT/);
});
test("maximum arithmetic and aggregate overflow reuse frozen Phase 10 checks", () => {
  const max = (1n << 128n) - 1n;
  assert.equal(
    fixture("YES", [["YES", max]]).run().calculation.total_accepted_zat,
    max,
  );
  assert.throws(
    () =>
      fixture("YES", [
        ["YES", max],
        ["NO", 1n],
      ]).run(),
    /exceeds bound/,
  );
  const f = fixture();
  f.config.settlement_policy.max_numerator_zat_squared = 1n;
  assert.throws(() => f.run(), /exceeds bound/);
});
test("caller inputs and private blindings cannot mutate returned bindings", () => {
  const f = fixture(),
    p = f.run();
  f.request.resolution.evidence[0] = "changed";
  f.config.oracle_rule.resolution_sources[0] = "changed";
  f.snapshot.records[0].record_blinding.fill(0);
  assert.equal(
    p.binding.resolution.evidence[0],
    "synthetic-primary:observation-at-13:00",
  );
  assert.equal(
    p.binding.oracle_rule.resolution_sources[0],
    "synthetic-primary",
  );
  assert.throws(() => {
    p.binding.resolution.outcome = "NO";
  }, TypeError);
  assert.throws(() => {
    p.calculation.entitlements[0].winning_payout_zat = 0n;
  }, TypeError);
  const serialized = JSON.stringify(p, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  for (const field of [
    "record_blinding",
    "receiver_ref",
    "accepted_payment_ref",
    "records",
    "claim_secret",
    "destination",
    "plan_hash",
  ])
    assert.ok(!serialized.includes('"' + field + '"'));
});
test("review receives frozen oracle data and cannot race captured inputs", () => {
  const f = fixture();
  f.config.review_oracle = (rule, r) => {
    assert.ok(Object.isFrozen(rule));
    assert.ok(Object.isFrozen(rule.resolution_sources));
    assert.ok(Object.isFrozen(r.evidence));
    f.snapshot.revision = 99n;
    f.request.request_key = "changed";
    f.snapshot.records[0].accepted_amount_zat = 50n;
    return "DEFENSIBLE";
  };
  const p = f.run();
  assert.equal(p.binding.revision, 2n);
  assert.equal(p.binding.request_key, "synthetic_resolution_1");
  assert.equal(p.calculation.total_accepted_zat, 5n);
});
test("closed schemas reject getters/extras; review errors redact private text", () => {
  const f = fixture();
  Object.defineProperty(f.request.resolution, "actor", {
    get() {
      assert.fail("getter invoked");
    },
    enumerable: true,
  });
  assert.throws(() => f.run(), /PREPARATION_INPUT_INVALID/);
  const g = fixture();
  g.snapshot.publication_verified = true;
  assert.throws(() => g.run());
  const h = fixture();
  h.config.review_oracle = () => {
    throw new Error("private-sensitive-evidence");
  };
  assert.throws(
    () => h.run(),
    (e) => e.message === "ORACLE_REVIEW_REJECTED",
  );
});

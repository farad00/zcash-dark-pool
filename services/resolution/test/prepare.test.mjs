import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { computeResolution, resolveInSession } from "../prepare.mjs";
import { canonicalData, wire } from "../session.mjs";
const vector = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/protocol/phase10/ledger-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
).cases.find((v) => v.case === "leaves-3");
const clone = (v) => JSON.parse(JSON.stringify(v));
function fixture() {
  const rule = {
    question: "Synthetic gauge",
    yes_definition: ">=10",
    no_definition: "<10",
    resolution_rule:
      "Observe synthetic-source at 2026-10-19T13:00:00.000000Z; VOID when ambiguous.",
    resolution_sources: ["synthetic-source"],
    void_conditions: ["ambiguous"],
    rule_version: "synthetic-rule-v1",
  };
  return {
    authority: {
      rule,
      oracle_login: "synthetic_oracle",
      actor_ref: "synthetic_operator",
      observation_at: "2026-10-19T13:00:00.000000Z",
      execution_class: "SYNTHETIC_TEST",
      resources: {
        max_tickets: "100",
        max_text_bytes: 8192,
        max_amount_bytes: 128,
        max_ledger_bytes: 1000000,
        max_total_zat: ((1n << 256n) - 1n).toString(),
        max_numerator_zat_squared: ((1n << 512n) - 1n).toString(),
      },
    },
    approval: {
      market_id: vector.context.market_id,
      request_key: "synthetic_approval",
      oracle_login: "synthetic_oracle",
      request: {
        expected_revision: "2",
        expected_root: vector.root,
        review: {
          decision: "DEFENSIBLE",
          source_ref: "synthetic-source",
          observation_at: "2026-10-19T13:00:00.000000Z",
          rationale: "Synthetic retained human review",
        },
      },
      resolution: {
        version: 1,
        network: "testnet",
        market_id: vector.context.market_id,
        outcome: "YES",
        resolved_at: "2026-10-19T13:01:00.000000Z",
        evidence: ["synthetic-source:observation"],
        rule_version: rule.rule_version,
        actor: "synthetic_operator",
      },
    },
    seal: {
      context: clone(vector.context),
      records: clone(vector.records),
      min_stake_zat: "1",
      max_stake_zat: ((1n << 256n) - 1n).toString(),
      response: {
        commitment: {
          market_id: vector.context.market_id,
          ledger_version: 1,
          accepted_ticket_count: String(vector.records.length),
          merkle_root: vector.root,
          locked_at: vector.context.locked_at,
        },
      },
    },
    saved: null,
  };
}
function saved(data) {
  const prepared = computeResolution(data);
  return {
    ...clone(data),
    saved: {
      preparation: prepared,
      response: { result: "RESOLUTION_RECORDED" },
    },
    stored_entitlements: prepared.calculation.entitlements.map((e) => ({
      ...e,
      amount_zat: (
        BigInt(e.winning_payout_zat) + BigInt(e.refund_zat)
      ).toString(),
    })),
  };
}
test("coordinator independently verifies literal frozen root and exact conserved bigint outputs", () => {
  const d = fixture(),
    result = computeResolution(d),
    c = result.calculation;
  assert.equal(result.binding.commitment.merkle_root, vector.root);
  assert.equal(result.lifecycle_authorized, false);
  assert.equal(
    BigInt(c.total_winning_payout_zat) + BigInt(c.total_refund_zat),
    BigInt(c.total_accepted_zat),
  );
});
test("missing, changed and duplicate retained ledger records fail closed with redacted errors", () => {
  for (const change of [
    (d) => {
      d.seal.records[0].record_blinding = null;
    },
    (d) => {
      d.seal.records[0].record_blinding = "ff".repeat(32);
    },
    (d) => {
      d.seal.records.push(clone(d.seal.records[0]));
    },
    (d) => {
      d.seal.response.commitment.merkle_root = "00".repeat(32);
    },
  ]) {
    const d = fixture();
    change(d);
    assert.throws(
      () => computeResolution(d),
      (e) => e.message === "RESOLUTION_REJECTED",
    );
  }
});
test("authenticated actor, source, observation and ambiguity bindings cannot be substituted", () => {
  for (const change of [
    (d) => {
      d.approval.oracle_login = "different";
    },
    (d) => {
      d.approval.resolution.actor = "forged";
    },
    (d) => {
      d.approval.request.review.observation_at = "2000-01-01T00:00:00.000000Z";
    },
    (d) => {
      d.approval.request.review.source_ref = "unknown";
    },
    (d) => {
      d.approval.request.review.decision = "AMBIGUOUS";
    },
  ]) {
    const d = fixture();
    change(d);
    assert.throws(() => computeResolution(d), /RESOLUTION_REJECTED/);
  }
});
test("readback checks actual immutable entitlement amounts as well as saved preparation", () => {
  const d = saved(fixture());
  assert.deepEqual(computeResolution(d), d.saved.preparation);
  d.stored_entitlements[0].amount_zat = "999999";
  assert.throws(() => computeResolution(d));
  const other = saved(fixture());
  other.saved.preparation.calculation.outcome = "NO";
  assert.throws(() => computeResolution(other));
});
test("unconfirmed or lost commit acknowledgement cannot report successful resolution", async () => {
  for (const acknowledgement of [null, { committed: false }, "lost"]) {
    const initial = fixture(),
      retained = saved(initial);
    let step = 0;
    const session = {
      async query() {
        step++;
        if (step === 1) return {};
        if (step === 2) return initial;
        if (step === 3) return retained.saved.response;
        if (step === 4) return retained;
        if (acknowledgement === "lost")
          throw new Error("SYNTHETIC_COMMIT_LOSS");
        return acknowledgement;
      },
    };
    await assert.rejects(resolveInSession(session, "synthetic_approval"));
    assert.equal(step, 5);
  }
});
test("deterministic retries do not change calculation, review or private source objects", () => {
  const d = fixture(),
    before = clone(d);
  assert.deepEqual(computeResolution(d), computeResolution(d));
  assert.deepEqual(d, before);
});
test("internal storage framing supports authorization booleans without changing protocol encodings", () => {
  assert.equal(
    canonicalData(wire({ z: false, a: 123456789012345678901n })),
    '{"a":"123456789012345678901","z":false}',
  );
  assert.throws(() => canonicalData({ value: "\ud800" }));
});

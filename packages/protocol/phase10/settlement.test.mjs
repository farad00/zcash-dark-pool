import assert from "node:assert/strict";
import test from "node:test";
import { calculateSubsidizedSettlement as settle } from "./settlement.ts";

// Synthetic fixed-width IDs satisfy Phase 7's representation, not its entropy.
const id = (n) => n.toString(16).padStart(64, "0");
const ticket = (n, side, stake) => ({
  ticket_id: id(n),
  side,
  accepted_amount_zat: stake,
});
const policy = Object.freeze({
  fee_mode: "EXTERNALLY_SUBSIDIZED",
  stake_bounds: Object.freeze({ min: 1n, max: (1n << 128n) - 1n }),
  max_total_zat: (1n << 128n) - 1n,
  max_numerator_zat_squared: (1n << 256n) - 1n,
});
const calculate = (tickets, outcome = "YES", configured = policy) =>
  settle(tickets, outcome, configured);
const paid = (result) =>
  result.entitlements.map((entry) => entry.winning_payout_zat);
const refunded = (result) =>
  result.entitlements.map((entry) => entry.refund_zat);
const sum = (values) => values.reduce((total, value) => total + value, 0n);

test("V12: literal SPEC example, totals and no rake", () => {
  const result = calculate([
    ticket(1, "YES", 200_000_000n),
    ticket(2, "YES", 100_000_000n),
    ticket(3, "NO", 100_000_000n),
  ]);
  assert.deepEqual(paid(result), [266_666_667n, 133_333_333n, 0n]);
  assert.equal(result.yes_stake_zat, 300_000_000n);
  assert.equal(result.no_stake_zat, 100_000_000n);
  assert.equal(result.total_accepted_zat, 400_000_000n);
  assert.equal(result.distributable_pool_zat, 400_000_000n);
  assert.equal(result.winning_stake_zat, 300_000_000n);
  assert.equal(result.total_winning_payout_zat, 400_000_000n);
  assert.equal(result.total_refund_zat, 0n);
});

test("V13: residual follows remainder, not stake size or ID priority", () => {
  assert.deepEqual(
    paid(
      calculate([
        ticket(1, "YES", 2n),
        ticket(2, "YES", 1n),
        ticket(3, "NO", 2n),
      ]),
    ),
    [3n, 2n, 0n],
  );
});

test("V14: two exact remainder ties use ascending canonical IDs", () => {
  const result = calculate([
    ticket(12, "YES", 1n),
    ticket(10, "YES", 1n),
    ticket(13, "NO", 2n),
    ticket(11, "YES", 1n),
  ]);
  assert.deepEqual(
    result.entitlements.map((entry) => entry.ticket_id),
    [id(10), id(11), id(12), id(13)],
  );
  assert.deepEqual(paid(result), [2n, 2n, 1n, 0n]);
});

test("NO resolution uses the same arithmetic", () => {
  assert.deepEqual(
    paid(
      calculate(
        [ticket(1, "NO", 2n), ticket(2, "NO", 1n), ticket(3, "YES", 2n)],
        "NO",
      ),
    ),
    [3n, 2n, 0n],
  );
});

test("V15: empty ledger for YES, NO and VOID", () => {
  for (const outcome of ["YES", "NO", "VOID"]) {
    const result = calculate([], outcome);
    assert.equal(result.mode, "EMPTY");
    assert.equal(result.total_accepted_zat, 0n);
    assert.equal(result.distributable_pool_zat, 0n);
    assert.equal(result.total_winning_payout_zat, 0n);
    assert.equal(result.total_refund_zat, 0n);
    assert.deepEqual(result.entitlements, []);
  }
});

for (const side of ["YES", "NO"]) {
  test(`V16: only ${side} wins; accepted stakes returned without artificial yield`, () => {
    const result = calculate([ticket(1, side, 2n), ticket(2, side, 1n)], side);
    assert.equal(result.mode, "WINNING_PAYOUT");
    assert.deepEqual(paid(result), [2n, 1n]);
    assert.deepEqual(refunded(result), [0n, 0n]);
  });
  test(`V17: only ${side}, empty winning side; exact NO_WINNER_REFUND`, () => {
    const result = calculate(
      [ticket(1, side, 2n), ticket(2, side, 1n)],
      side === "YES" ? "NO" : "YES",
    );
    assert.equal(result.mode, "NO_WINNER_REFUND");
    assert.equal(result.winning_stake_zat, 0n);
    assert.deepEqual(paid(result), [0n, 0n]);
    assert.deepEqual(refunded(result), [2n, 1n]);
    assert.equal(result.total_refund_zat, 3n);
  });
}

test("V20: VOID refunds both sides in full", () => {
  const result = calculate(
    [ticket(1, "YES", 1_000_000n), ticket(2, "NO", 2_000_000n)],
    "VOID",
  );
  assert.equal(result.mode, "VOID_REFUND");
  assert.deepEqual(paid(result), [0n, 0n]);
  assert.deepEqual(refunded(result), [1_000_000n, 2_000_000n]);
});

test("zero and invalid stakes reject in every economic branch", () => {
  for (const outcome of ["YES", "NO", "VOID"]) {
    for (const stake of [
      0n,
      -1n,
      1,
      1.5,
      NaN,
      Infinity,
      "1",
      null,
      undefined,
    ]) {
      assert.throws(
        () => calculate([ticket(1, "YES", stake)], outcome),
        RangeError,
      );
    }
  }
});

test("duplicate IDs reject rather than merge, including conflicting records", () => {
  for (const outcome of ["YES", "NO", "VOID"]) {
    for (const second of [ticket(1, "YES", 1n), ticket(1, "NO", 2n)]) {
      assert.throws(
        () => calculate([ticket(1, "YES", 1n), second], outcome),
        /Duplicate ticket identifier/,
      );
    }
  }
});

test("canonical Phase 7 IDs reject malformed, uppercase and normalized alternatives", () => {
  for (const bad of [
    "",
    "A",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    ` ${id(1)}`,
    `${id(1)}\n`,
    1,
    null,
  ]) {
    assert.throws(
      () => calculate([{ ...ticket(1, "YES", 1n), ticket_id: bad }]),
      TypeError,
    );
  }
});

test("invalid side, resolution and ledger containers reject", () => {
  for (const side of ["yes", "VOID", "", null, 1])
    assert.throws(() => calculate([ticket(1, side, 1n)]), TypeError);
  for (const outcome of ["yes", "", null, 1])
    assert.throws(() => calculate([], outcome), TypeError);
  for (const ledger of [null, {}, "", [null], new Array(1)])
    assert.throws(() => calculate(ledger), TypeError);
});

test("frozen market min and max are inclusive; outside rejects", () => {
  const bounded = { ...policy, stake_bounds: { min: 2n, max: 7n } };
  assert.deepEqual(
    paid(
      calculate([ticket(1, "YES", 2n), ticket(2, "YES", 7n)], "YES", bounded),
    ),
    [2n, 7n],
  );
  for (const stake of [1n, 8n])
    assert.throws(
      () => calculate([ticket(1, "YES", stake)], "YES", bounded),
      RangeError,
    );
});

test("no implicit financial defaults; unsupported fee modes reject", () => {
  for (const configured of [
    undefined,
    null,
    {},
    { ...policy, fee_mode: "POOL_FUNDED" },
  ]) {
    assert.throws(() => settle([], "YES", configured), TypeError);
  }
});

test("invalid bounds and accounting limits reject even for empty ledgers", () => {
  for (const configured of [
    { ...policy, stake_bounds: { min: 2n, max: 1n } },
    { ...policy, stake_bounds: { min: -1n, max: 1n } },
    { ...policy, stake_bounds: { min: 1n, max: 3 } },
    { ...policy, stake_bounds: null },
    { ...policy, max_total_zat: -1n },
    { ...policy, max_numerator_zat_squared: 100 },
  ])
    assert.throws(() => calculate([], "YES", configured), RangeError);
});

test("maximum configured 128-bit stake uses an exact 256-bit product", () => {
  const maximum = policy.stake_bounds.max;
  assert.deepEqual(paid(calculate([ticket(1, "YES", maximum)])), [maximum]);
  assert.throws(() => calculate([ticket(1, "YES", maximum + 1n)]), RangeError);
});

test("combined-side and same-side addition overflow rejects, including refunds", () => {
  for (const side of ["YES", "NO"]) {
    for (const outcome of ["YES", "NO", "VOID"]) {
      assert.throws(
        () =>
          calculate(
            [ticket(1, "YES", policy.max_total_zat), ticket(2, side, 1n)],
            outcome,
          ),
        /addition exceeds bound/,
      );
    }
  }
});

test("wide multiplication bound is checked without truncation or wraparound", () => {
  const configured = { ...policy, max_numerator_zat_squared: 24n };
  assert.throws(
    () => calculate([ticket(1, "YES", 5n)], "YES", configured),
    /multiplication exceeds bound/,
  );
  assert.deepEqual(
    paid(
      calculate([ticket(1, "YES", 5n)], "YES", {
        ...configured,
        max_numerator_zat_squared: 25n,
      }),
    ),
    [5n],
  );
});

test("values beyond Number precision remain exact", () => {
  const large = 9_007_199_254_740_993n;
  const result = calculate([ticket(1, "YES", large), ticket(2, "NO", large)]);
  assert.deepEqual(paid(result), [18_014_398_509_481_986n, 0n]);
});

function* permutations(values) {
  if (values.length === 0) yield [];
  for (let index = 0; index < values.length; index++) {
    for (const tail of permutations(values.filter((_, i) => i !== index)))
      yield [values[index], ...tail];
  }
}

test("all 24 input permutations and repeated calls produce identical full output", () => {
  const ledger = [
    ticket(1, "YES", 1n),
    ticket(2, "YES", 1n),
    ticket(3, "YES", 1n),
    ticket(4, "NO", 2n),
  ];
  for (const outcome of ["YES", "NO", "VOID"]) {
    const expected = calculate(ledger, outcome);
    for (const permutation of permutations(ledger))
      assert.deepEqual(calculate(permutation, outcome), expected);
    assert.deepEqual(calculate(ledger, outcome), expected);
  }
});

test("input is unchanged; returned calculation and each entitlement are immutable", () => {
  const ledger = Object.freeze([
    Object.freeze(ticket(2, "YES", 1n)),
    Object.freeze(ticket(1, "NO", 1n)),
  ]);
  const before = structuredClone(ledger);
  const result = calculate(ledger);
  assert.deepEqual(ledger, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.entitlements));
  assert.ok(result.entitlements.every(Object.isFrozen));
  assert.throws(() => {
    result.entitlements[0].winning_payout_zat = 0n;
  }, TypeError);
});

test("exhaustive small ledgers conserve all funds and obey quota/residual ranking", () => {
  // 5^4 × 2 outcomes = 1250 cases; expectations use rational cross-products.
  for (let a = 1n; a <= 5n; a++)
    for (let b = 1n; b <= 5n; b++)
      for (let c = 1n; c <= 5n; c++)
        for (let d = 1n; d <= 5n; d++) {
          const ledger = [
            ticket(1, "YES", a),
            ticket(2, "YES", b),
            ticket(3, "NO", c),
            ticket(4, "NO", d),
          ];
          for (const outcome of ["YES", "NO"]) {
            const result = calculate(ledger, outcome);
            const total = a + b + c + d;
            const winners = ledger.filter((entry) => entry.side === outcome);
            const winning = sum(
              winners.map((entry) => entry.accepted_amount_zat),
            );
            assert.equal(sum(paid(result)), total);
            assert.equal(sum(refunded(result)), 0n);
            const quotas = winners.map((entry) => {
              const actual = result.entitlements.find(
                (value) => value.ticket_id === entry.ticket_id,
              ).winning_payout_zat;
              const numerator = entry.accepted_amount_zat * total;
              const floor = numerator / winning;
              assert.ok(actual === floor || actual === floor + 1n);
              return {
                id: entry.ticket_id,
                residual: numerator - floor * winning,
                extra: actual - floor,
              };
            });
            for (const awarded of quotas.filter(
              (entry) => entry.extra === 1n,
            )) {
              for (const unawarded of quotas.filter(
                (entry) => entry.extra === 0n,
              )) {
                assert.ok(
                  awarded.residual > unawarded.residual ||
                    (awarded.residual === unawarded.residual &&
                      awarded.id < unawarded.id),
                );
              }
            }
            for (const loser of ledger.filter(
              (entry) => entry.side !== outcome,
            )) {
              assert.equal(
                result.entitlements.find(
                  (entry) => entry.ticket_id === loser.ticket_id,
                ).winning_payout_zat,
                0n,
              );
            }
          }
        }
});

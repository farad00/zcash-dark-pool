import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkedAdd,
  checkedMultiply,
  formatZatoshi,
  parseZecToZatoshi,
} from "../dist/index.js";

const bounds = { min: 0n, max: (1n << 128n) - 1n }; // Synthetic utility bound, not market policy.

test("U01: exact conversion, eight-place formatting and caller-supplied bounds", () => {
  for (const [text, amount, display] of [
    ["0", 0n, "0.00000000"],
    ["0.01", 1_000_000n, "0.01000000"],
    ["0.00000001", 1n, "0.00000001"],
    ["2.12345678", 212_345_678n, "2.12345678"],
    ["90071992.54740993", 9_007_199_254_740_993n, "90071992.54740993"],
  ]) {
    assert.equal(parseZecToZatoshi(text, bounds), amount);
    assert.equal(formatZatoshi(amount), display);
    assert.equal(parseZecToZatoshi(display, bounds), amount);
  }
  const stakeBounds = { min: 1n, max: 1_000_000n };
  assert.equal(parseZecToZatoshi("0.00000001", stakeBounds), stakeBounds.min);
  assert.equal(parseZecToZatoshi("0.01", stakeBounds), stakeBounds.max);
  for (const value of ["0", "0.01000001"])
    assert.throws(() => parseZecToZatoshi(value, stakeBounds));
});

test("U02: malformed decimals never truncate or round into eligibility", () => {
  for (const value of [
    "",
    "-1",
    "+1",
    "NaN",
    "Infinity",
    "1e-8",
    "1E2",
    "1,00",
    "1,000",
    " 1",
    "1 ",
    "1\n",
    "\t1",
    ".1",
    "1.",
    "01",
    "00.1",
    "0.000000001",
    "1.000000000",
    "١",
    "１",
    "1_000",
    "0x10",
    1,
    1n,
    NaN,
    Infinity,
    null,
    {},
  ])
    assert.throws(() => parseZecToZatoshi(value, bounds));
  assert.throws(
    () => parseZecToZatoshi("9".repeat(10_000), bounds),
    RangeError,
  );
  assert.throws(() => parseZecToZatoshi("1", { min: 2n, max: 1n }));
  assert.throws(() => parseZecToZatoshi("1", { min: -1n, max: 1n }));
  assert.throws(() => parseZecToZatoshi("1", { min: 0n, max: 1 }));
  assert.throws(() => formatZatoshi(-1n));
  assert.throws(() => formatZatoshi(1));
});

test("U03: exact checked arithmetic beyond JS safe integers and at wide limits", () => {
  const max = bounds.max;
  assert.equal(checkedAdd(max - 1n, 1n, max), max);
  assert.throws(() => checkedAdd(max, 1n, max), RangeError);
  assert.equal(checkedMultiply(1n << 63n, 1n << 64n, max), 1n << 127n);
  assert.throws(() => checkedMultiply(1n << 64n, 1n << 64n, max), RangeError);
  assert.equal(checkedMultiply(0n, max, max), 0n);
  assert.equal(checkedMultiply(max, 1n, max), max);
  assert.equal(
    checkedAdd(9_007_199_254_740_992n, 1n, max),
    9_007_199_254_740_993n,
  );
  for (const operation of [checkedAdd, checkedMultiply]) {
    for (const args of [
      [-1n, 1n, max],
      [1n, -1n, max],
      [1n, 1n, -1n],
      [1, 1n, max],
      [max + 1n, 0n, max],
    ]) {
      assert.throws(() => operation(...args));
    }
  }
});

test("U01/U03: seeded round-trip and arithmetic properties (seed 0x706861736532)", () => {
  let seed = 0x706861736532n;
  const next = () => {
    seed = (seed * 6364136223846793005n + 1n) & ((1n << 64n) - 1n);
    return seed;
  };
  for (let index = 0; index < 1_000; index++) {
    const left = next();
    const right = next();
    assert.equal(parseZecToZatoshi(formatZatoshi(left), bounds), left);
    assert.equal(checkedAdd(left, right, bounds.max) - right, left);
    assert.equal(checkedMultiply(left, right, bounds.max) / right, left);
    const smallBound = 1_000n;
    const a = left % 1_001n;
    const b = right % 1_001n;
    if (a + b <= smallBound) assert.equal(checkedAdd(a, b, smallBound), a + b);
    else assert.throws(() => checkedAdd(a, b, smallBound));
    if (a * b <= smallBound)
      assert.equal(checkedMultiply(a, b, smallBound), a * b);
    else assert.throws(() => checkedMultiply(a, b, smallBound));
  }
});

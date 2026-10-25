import assert from "node:assert/strict";
import { test } from "node:test";
import { generateClaimSecret } from "../dist/index.js";

function withCrypto(value, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
}

test("U04: invokes platform getRandomValues once on each fresh 32-byte array", () => {
  const buffers = [];
  withCrypto(
    {
      getRandomValues(buffer) {
        assert.equal(buffer.byteLength, 32);
        buffers.push(buffer);
        buffer.fill(buffers.length);
        return buffer;
      },
    },
    () => {
      const first = generateClaimSecret();
      const second = generateClaimSecret();
      assert.equal(buffers.length, 2);
      assert.notEqual(first, second);
      assert.equal(first[0], 1);
      assert.equal(second[0], 2);
    },
  );
});

test("U04: unavailable/failing RNG fails closed and clears partial output", () => {
  for (const value of [undefined, {}])
    withCrypto(value, () =>
      assert.throws(generateClaimSecret, /Secure randomness unavailable/),
    );
  let buffer;
  withCrypto(
    {
      getRandomValues(value) {
        buffer = value;
        value.fill(17);
        throw new Error("synthetic external private data");
      },
    },
    () => {
      assert.throws(generateClaimSecret, {
        message: "Secure randomness failed",
      });
    },
  );
  assert.ok(buffer.every((value) => value === 0));
});

test("U04: real platform RNG sampling; uniqueness is not proof of entropy", () => {
  const samples = new Set();
  for (let index = 0; index < 100; index++) {
    const secret = generateClaimSecret();
    assert.equal(secret.length, 32);
    samples.add(Buffer.from(secret).toString("hex"));
    secret.fill(0);
  }
  assert.equal(samples.size, 100);
});

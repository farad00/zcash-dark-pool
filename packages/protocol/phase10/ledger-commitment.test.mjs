import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  LEDGER_PROFILE,
  LEDGER_DOMAINS,
  encodeLedgerContext,
  encodePrivateLedgerRecord,
  decodePrivateLedgerRecord,
  hashPrivateLedgerLeaf,
  computePrivateLedgerTreeHash,
  recomputeLedgerCommitment,
  verifyLedgerCommitment,
  createPrivateBlindedLedger,
} from "./ledger-commitment.ts";

const vectors = JSON.parse(
  readFileSync(new URL("./ledger-vectors.json", import.meta.url), "utf8"),
);
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (value) => Uint8Array.from(Buffer.from(value, "hex"));
const limits = Object.freeze({
  stake_bounds: Object.freeze({ min: 1n, max: (1n << 256n) - 1n }),
  max_tickets: 100n,
  max_text_bytes: 4096,
  max_amount_bytes: 32,
  max_ledger_bytes: 2_000_000,
});
function records(vector) {
  return vector.records.map((record) => ({
    ...record,
    accepted_amount_zat: BigInt(record.accepted_amount_zat),
    record_blinding: bytes(record.record_blinding),
  }));
}
const three = vectors.cases.find((value) => value.case === "leaves-3");
const one = vectors.cases.find((value) => value.case === "leaves-1");
const ctx = one.context;
const singleton = () => records(one);
const commit = (input = singleton(), context = ctx, configured = limits) =>
  recomputeLedgerCommitment(context, input, configured);
const expected = (vector) => ({
  market_id: vector.context.market_id,
  ledger_version: 1,
  accepted_ticket_count: String(vector.records.length),
  merkle_root: vector.root,
  locked_at: vector.context.locked_at,
});

for (const vector of vectors.cases) {
  test(`independent literal vector: ${vector.case}`, () => {
    const input = records(vector);
    assert.equal(
      hex(encodeLedgerContext(vector.context, limits)),
      vector.context_hex,
    );
    for (let i = 0; i < input.length; i++) {
      const encoded = encodePrivateLedgerRecord(
        vector.context,
        input[i],
        limits,
      );
      assert.equal(hex(encoded), vector.private_records[i]);
      assert.equal(hex(encoded.subarray(0, -32)), vector.record_bodies[i]);
      assert.equal(
        hex(
          Buffer.concat([
            Buffer.from(LEDGER_DOMAINS.leaf + "\0", "ascii"),
            encoded,
          ]),
        ),
        vector.leaf_preimages[i],
      );
      assert.deepEqual(
        decodePrivateLedgerRecord(vector.context, encoded, limits),
        input[i],
      );
      assert.equal(
        hex(hashPrivateLedgerLeaf(vector.context, input[i], limits)),
        vector.leaves[i],
      );
    }
    for (const node of vector.internal_nodes) {
      const preimage = Buffer.concat([
        Buffer.from(LEDGER_DOMAINS.node + "\0", "ascii"),
        bytes(vector.context_hex),
        bytes(node.left),
        bytes(node.right),
      ]);
      assert.equal(hex(preimage), node.preimage);
      assert.equal(hex(blake2b(preimage, { dkLen: 32 })), node.hash);
    }
    assert.equal(
      hex(blake2b(bytes(vector.empty_preimage), { dkLen: 32 })),
      vector.empty_hash,
    );
    assert.equal(
      hex(computePrivateLedgerTreeHash(vector.context, input, limits)),
      vector.tree_hash,
    );
    assert.deepEqual(
      recomputeLedgerCommitment(vector.context, input, limits),
      expected(vector),
    );
    assert.ok(
      verifyLedgerCommitment(vector.context, input, expected(vector), limits),
    );
    assert.notEqual(vector.root, vector.truncated_blake2b512);
    assert.equal(
      hex(blake2b(bytes(vector.root_preimage), { dkLen: 32 })),
      vector.root,
    );
  });
}

test("frozen profile and all domain literals are exact", () => {
  assert.equal(LEDGER_PROFILE, "DARKPOOL_LEDGER_V1_BIN1_B2B256");
  assert.deepEqual(LEDGER_DOMAINS, {
    leaf: "DARKPOOL_LEDGER_LEAF_V1",
    node: "DARKPOOL_LEDGER_NODE_V1",
    empty: "DARKPOOL_LEDGER_EMPTY_V1",
    root: "DARKPOOL_LEDGER_ROOT_V1",
  });
  assert.notEqual(
    vectors.cases.find((value) => value.case === "split-ab-c").root,
    vectors.cases.find((value) => value.case === "split-a-bc").root,
  );
});

test("reversed input produces the same root without mutating caller data", () => {
  for (const vector of vectors.cases) {
    const input = records(vector).reverse();
    const before = structuredClone(input);
    assert.deepEqual(
      recomputeLedgerCommitment(vector.context, input, limits),
      expected(vector),
    );
    assert.deepEqual(input, before);
  }
});

test("every committed record field or blinding mutation changes the root", () => {
  const original = commit();
  for (const patch of [
    { side: "NO" },
    { accepted_amount_zat: 2n },
    { ticket_id: "f".repeat(64) },
    { accepted_payment_ref: "different-payment" },
    { receiver_ref: "different-receiver" },
    { record_blinding: new Uint8Array(32).fill(255) },
  ]) {
    const input = singleton();
    Object.assign(input[0], patch);
    assert.notEqual(commit(input).merkle_root, original.merkle_root);
    assert.equal(verifyLedgerCommitment(ctx, input, original, limits), false);
  }
  assert.notEqual(commit([]).merkle_root, original.merkle_root);
});

test("market and exact timestamp bind the root; wrong profile/network/version rejects", () => {
  const original = commit();
  for (const patch of [
    { market_id: "another-market" },
    { locked_at: "2026-10-19T12:34:56.123457Z" },
  ]) {
    const context = { ...ctx, ...patch };
    const input = singleton().map((record) => ({
      ...record,
      market_id: context.market_id,
    }));
    assert.notEqual(commit(input, context).merkle_root, original.merkle_root);
    assert.equal(
      verifyLedgerCommitment(context, input, original, limits),
      false,
    );
  }
  for (const patch of [
    { profile: LEDGER_PROFILE + "X" },
    { network: "mainnet" },
    { version: 2 },
  ]) {
    assert.throws(() => commit(singleton(), { ...ctx, ...patch }));
    assert.equal(
      verifyLedgerCommitment(
        { ...ctx, ...patch },
        singleton(),
        original,
        limits,
      ),
      false,
    );
  }
  for (const patch of [
    { market_id: "wrong" },
    { network: "mainnet" },
    { version: 2 },
  ])
    assert.throws(() => commit([{ ...singleton()[0], ...patch }]));
});

test("duplicate ticket IDs and duplicate persisted blindings reject", () => {
  const input = records(three);
  assert.throws(() => commit([input[0], input[0]]));
  assert.throws(() =>
    commit([input[0], { ...input[1], ticket_id: input[0].ticket_id }]),
  );
  assert.throws(() =>
    commit([
      input[0],
      { ...input[1], record_blinding: input[0].record_blinding },
    ]),
  );
});

test("missing or malformed private records/blindings cannot verify", () => {
  const original = commit();
  for (const blind of [
    undefined,
    null,
    "0".repeat(64),
    new Uint8Array(31),
    new Uint8Array(33),
    new Array(32),
  ]) {
    const input = [{ ...singleton()[0], record_blinding: blind }];
    assert.throws(() => commit(input));
    assert.equal(verifyLedgerCommitment(ctx, input, original, limits), false);
  }
  const { record_blinding: ignored, ...lost } = singleton()[0];
  void ignored;
  assert.equal(verifyLedgerCommitment(ctx, [lost], original, limits), false);
  for (const input of [null, {}, [null], new Array(1)]) {
    assert.throws(() => commit(input));
    assert.equal(verifyLedgerCommitment(ctx, input, original, limits), false);
  }
});

test("invalid sides, stake values, and frozen stake bounds reject", () => {
  for (const value of [0n, -1n, 1, 1.2, "1", NaN, Infinity, undefined])
    assert.throws(() =>
      commit([{ ...singleton()[0], accepted_amount_zat: value }]),
    );
  for (const value of ["yes", "VOID", 0, null])
    assert.throws(() => commit([{ ...singleton()[0], side: value }]));
  const configured = { ...limits, stake_bounds: { min: 2n, max: 256n } };
  assert.throws(() => commit(singleton(), ctx, configured));
  for (const amount of [2n, 256n])
    assert.ok(
      commit(
        [{ ...singleton()[0], accepted_amount_zat: amount }],
        ctx,
        configured,
      ),
    );
  assert.throws(() =>
    commit([{ ...singleton()[0], accepted_amount_zat: 257n }], ctx, configured),
  );
});

test("noncanonical ticket identifiers reject rather than normalize", () => {
  for (const value of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    one.records[0].ticket_id + "\n",
    123,
  ])
    assert.throws(() => commit([{ ...singleton()[0], ticket_id: value }]));
});

test("text rejects malformed Unicode, empty and NUL; preserves exact Unicode/BOM", () => {
  for (const value of ["", "\0", "bad\ud800", "bad\udfff", null]) {
    assert.throws(() => commit([{ ...singleton()[0], receiver_ref: value }]));
    assert.throws(() => commit(singleton(), { ...ctx, market_id: value }));
  }
  const a = commit([{ ...singleton()[0], receiver_ref: "é" }]);
  const b = commit([{ ...singleton()[0], receiver_ref: "e\u0301" }]);
  assert.notEqual(a.merkle_root, b.merkle_root);
  const record = { ...singleton()[0], accepted_payment_ref: "\ufeffsynthetic" };
  assert.deepEqual(
    decodePrivateLedgerRecord(
      ctx,
      encodePrivateLedgerRecord(ctx, record, limits),
      limits,
    ),
    record,
  );
});

test("lock time validates Gregorian calendar, exact microseconds and UTC", () => {
  for (const stamp of [
    "0000-01-01T00:00:00.000000Z",
    "1900-02-29T00:00:00.000000Z",
    "2026-02-30T00:00:00.000000Z",
    "2026-13-01T00:00:00.000000Z",
    "2026-01-01T24:00:00.000000Z",
    "2026-01-01T00:60:00.000000Z",
    "2026-01-01T00:00:60.000000Z",
    "2026-01-01T00:00:00.000Z",
    ctx.locked_at + "\n",
    ctx.locked_at.replace("Z", "+00:00"),
  ])
    assert.throws(() => commit(singleton(), { ...ctx, locked_at: stamp }));
  for (const stamp of [
    "0001-01-01T00:00:00.000000Z",
    "2000-02-29T23:59:59.999999Z",
    "9999-12-31T23:59:59.999999Z",
  ])
    assert.ok(commit(singleton(), { ...ctx, locked_at: stamp }));
});

function join(...parts) {
  return Uint8Array.from(Buffer.concat(parts));
}
function framed(value) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return join(length, value);
}

test("strict decoder rejects truncations, trailing bytes and malformed magnitudes", () => {
  const encoded = bytes(one.private_records[0]);
  for (let length = 0; length < encoded.length; length++)
    assert.throws(() =>
      decodePrivateLedgerRecord(ctx, encoded.subarray(0, length), limits),
    );
  assert.throws(() =>
    decodePrivateLedgerRecord(ctx, join(encoded, Uint8Array.of(0)), limits),
  );
  const magnitudeOffset = bytes(one.context_hex).length + 32 + 1;
  for (const magnitude of [
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(0, 1),
  ]) {
    const malformed = join(
      encoded.subarray(0, magnitudeOffset),
      framed(magnitude),
      encoded.subarray(magnitudeOffset + 5),
    );
    assert.throws(() => decodePrivateLedgerRecord(ctx, malformed, limits));
  }
  const badLength = encoded.slice();
  badLength.set([255, 255, 255, 255], magnitudeOffset);
  assert.throws(() => decodePrivateLedgerRecord(ctx, badLength, limits));
});

test("strict decoder rejects invalid UTF-8 including overlong and surrogate bytes", () => {
  const encoded = bytes(one.private_records[0]);
  const paymentOffset = bytes(one.context_hex).length + 32 + 1 + 5;
  const paymentLength = Buffer.from(encoded).readUInt32BE(paymentOffset);
  for (const malformed of [
    [255],
    [0xc0, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xe2, 0x82],
    [0],
  ]) {
    const changed = join(
      encoded.subarray(0, paymentOffset),
      framed(Uint8Array.from(malformed)),
      encoded.subarray(paymentOffset + 4 + paymentLength),
    );
    assert.throws(() => decodePrivateLedgerRecord(ctx, changed, limits));
  }
});

test("decoder rejects wrong encoded context/side and handles offset Buffer input", () => {
  const encoded = bytes(one.private_records[0]);
  const profileLength = Buffer.byteLength(LEDGER_PROFILE);
  for (const offset of [
    4,
    4 + profileLength + 1,
    4 + profileLength + 2,
    4 + profileLength + 3 + 4,
    bytes(one.context_hex).length + 32,
  ]) {
    const changed = encoded.slice();
    changed[offset] = 255;
    assert.throws(() => decodePrivateLedgerRecord(ctx, changed, limits));
  }
  const offsetBuffer = Buffer.concat([Buffer.alloc(17), encoded]).subarray(17);
  assert.deepEqual(
    decodePrivateLedgerRecord(ctx, offsetBuffer, limits),
    singleton()[0],
  );
});

test("caller-supplied resource limits reject oversized work without alternate bytes", () => {
  for (const patch of [
    { max_tickets: 0n },
    { max_text_bytes: 1 },
    { max_amount_bytes: 1 },
    { max_ledger_bytes: 10 },
  ]) {
    const input = patch.max_amount_bytes
      ? records(three).slice(1, 2)
      : singleton();
    assert.throws(() => commit(input, ctx, { ...limits, ...patch }));
  }
  for (const patch of [
    { max_tickets: 1n << 64n },
    { max_tickets: 1 },
    { max_text_bytes: 0 },
    { max_text_bytes: 2 ** 32 },
    { max_amount_bytes: 1.5 },
    { max_ledger_bytes: NaN },
    { stake_bounds: { min: 2n, max: 1n } },
  ])
    assert.throws(() => commit([], ctx, { ...limits, ...patch }));
  assert.equal(
    commit([], ctx, { ...limits, max_tickets: 0n }).accepted_ticket_count,
    "0",
  );
});

test("closed schemas reject extras/accessors; errors do not echo sensitive inputs", () => {
  assert.throws(
    () =>
      commit([
        { ...singleton()[0], claim_secret: "SYNTHETIC-PRIVATE-SENTINEL" },
      ]),
    { message: "Invalid ledger commitment input" },
  );
  assert.throws(() => commit(singleton(), { ...ctx, extra: true }));
  const record = { ...singleton()[0] };
  Object.defineProperty(record, "receiver_ref", {
    get() {
      throw new Error("SYNTHETIC-PRIVATE-SENTINEL");
    },
  });
  assert.throws(() => commit([record]), {
    message: "Invalid ledger commitment input",
  });
  const hidden = { ...singleton()[0] };
  Object.defineProperty(hidden, "hidden_secret", { value: 1 });
  assert.throws(() => commit([hidden]));
});

test("only the approved five fields appear in immutable public output", () => {
  const result = commit();
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "market_id",
      "ledger_version",
      "accepted_ticket_count",
      "merkle_root",
      "locked_at",
    ].sort(),
  );
  assert.ok(Object.isFrozen(result));
  assert.doesNotThrow(() => JSON.stringify(result));
  const serialized = JSON.stringify(result);
  for (const value of [
    one.records[0].ticket_id,
    one.records[0].receiver_ref,
    one.records[0].accepted_payment_ref,
    one.records[0].record_blinding,
    "record_blinding",
    "accepted_amount_zat",
  ])
    assert.ok(!serialized.includes(value));
});

test("verification rejects malformed and changed publication objects", () => {
  const original = commit();
  for (const patch of [
    { market_id: "wrong" },
    { ledger_version: 2 },
    { locked_at: ctx.locked_at.replace("123456", "123457") },
    { accepted_ticket_count: "0" },
    { accepted_ticket_count: "01" },
    { accepted_ticket_count: "1\n" },
    { accepted_ticket_count: 1n },
    { accepted_ticket_count: "18446744073709551616" },
    { merkle_root: "a".repeat(63) },
    { merkle_root: original.merkle_root.toUpperCase() },
    { merkle_root: "0".repeat(64) },
    { private_records: singleton() },
  ])
    assert.equal(
      verifyLedgerCommitment(
        ctx,
        singleton(),
        { ...original, ...patch },
        limits,
      ),
      false,
    );
  const { locked_at: ignored, ...missing } = original;
  void ignored;
  assert.equal(
    verifyLedgerCommitment(ctx, singleton(), missing, limits),
    false,
  );
});

function withCrypto(replacement, work) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: replacement,
    configurable: true,
  });
  try {
    return work();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
}
function unblinded(input = records(three)) {
  return input.map(({ record_blinding, ...record }) => {
    void record_blinding;
    return record;
  });
}

test("initial blinding generation uses fresh platform CSPRNG buffers", () => {
  const input = unblinded(
    records(vectors.cases.find((value) => value.case === "leaves-7")),
  ).reverse();
  const before = structuredClone(input);
  const generated = createPrivateBlindedLedger(ctx, input, limits);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(generated));
  assert.equal(
    new Set(generated.map((record) => hex(record.record_blinding))).size,
    7,
  );
  assert.equal(
    new Set(generated.map((record) => record.record_blinding)).size,
    7,
  );
  assert.ok(
    generated.every(
      (record) =>
        record.record_blinding.length === 32 && Object.isFrozen(record),
    ),
  );
  const output = commit(generated);
  assert.ok(verifyLedgerCommitment(ctx, generated, output, limits));
});

test("initial generation rejects already/partially blinded input and invalid ledgers before RNG", () => {
  let calls = 0;
  withCrypto(
    {
      getRandomValues() {
        calls++;
        throw new Error("should not run");
      },
    },
    () => {
      for (const input of [
        singleton(),
        [{ ...unblinded()[0], record_blinding: undefined }],
        [unblinded()[0], unblinded()[0]],
        new Array(1),
      ])
        assert.throws(() => createPrivateBlindedLedger(ctx, input, limits));
    },
  );
  assert.equal(calls, 0);
});

test("RNG absence, failure and repeated output fail closed without secret diagnostics", () => {
  withCrypto(undefined, () =>
    assert.deepEqual(createPrivateBlindedLedger(ctx, [], limits), []),
  );
  withCrypto(undefined, () =>
    assert.throws(() => createPrivateBlindedLedger(ctx, unblinded(), limits), {
      message: "Ledger blinding generation failed",
    }),
  );
  withCrypto(
    {
      getRandomValues() {
        throw new Error("SYNTHETIC-SECRET-DIAGNOSTIC");
      },
    },
    () =>
      assert.throws(
        () => createPrivateBlindedLedger(ctx, unblinded(), limits),
        { message: "Ledger blinding generation failed" },
      ),
  );
  const returned = [];
  withCrypto(
    {
      getRandomValues(value) {
        value.fill(7);
        returned.push(value);
        return value;
      },
    },
    () =>
      assert.throws(
        () => createPrivateBlindedLedger(ctx, unblinded(), limits),
        { message: "Ledger blinding generation failed" },
      ),
  );
  assert.ok(returned.every((value) => value.every((byte) => byte === 0)));
});

test("recomputation and verification never regenerate or request blindings", () => {
  const original = commit();
  let calls = 0;
  withCrypto(
    {
      getRandomValues() {
        calls++;
        throw new Error("RNG prohibited");
      },
    },
    () => {
      assert.deepEqual(commit(), original);
      assert.ok(verifyLedgerCommitment(ctx, singleton(), original, limits));
      const lost = unblinded(singleton());
      assert.equal(verifyLedgerCommitment(ctx, lost, original, limits), false);
    },
  );
  assert.equal(calls, 0);
});

test("private encoding/decoding owns byte copies; byte mutations invalidate verification", () => {
  const input = singleton();
  const original = commit(input);
  const encoded = encodePrivateLedgerRecord(ctx, input[0], limits);
  const decoded = decodePrivateLedgerRecord(ctx, encoded, limits);
  input[0].record_blinding[0] ^= 1;
  assert.ok(verifyLedgerCommitment(ctx, [decoded], original, limits));
  assert.equal(verifyLedgerCommitment(ctx, input, original, limits), false);
  encoded[encoded.length - 1] ^= 1;
  assert.ok(verifyLedgerCommitment(ctx, [decoded], original, limits));
});

test("a self-consistent false book can hash, but fails against retained original root", () => {
  const input = records(three);
  const original = commit(input);
  const omitted = input.slice(0, 2);
  const replacement = commit(omitted);
  assert.ok(verifyLedgerCommitment(ctx, omitted, replacement, limits));
  assert.equal(verifyLedgerCommitment(ctx, omitted, original, limits), false);
});

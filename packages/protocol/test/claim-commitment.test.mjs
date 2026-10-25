import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CLAIM_COMMITMENT_DOMAIN,
  CLAIM_ENCODING_VERSION,
  deriveClaimCommitment,
  encodeClaimId,
} from "../dist/index.js";

// Expectations are saved literals from the independent Rust generator, never
// computed by the production encoder/hash during tests.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test-vectors/claim-commitment-v1.json", import.meta.url),
    "utf8",
  ),
);
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const input = (vector) => ({
  version: vector.input.version,
  market_id: vector.input.market_id,
  ticket_id: vector.input.ticket_id,
  claim_secret: Uint8Array.from(
    Buffer.from(vector.input.claim_secret_hex, "hex"),
  ),
});
const primary = fixture.vectors.find((vector) => vector.name === "V01");

test("V01/U05/U06: approved frames, preimage and native BLAKE2b-256 match independent literals", () => {
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.profile_id, "DARKPOOL_CLAIM_V1_ID_FRAME_1");
  assert.equal(CLAIM_ENCODING_VERSION, 1);
  assert.equal(CLAIM_COMMITMENT_DOMAIN, "DARKPOOL_CLAIM_V1");
  for (const vector of fixture.vectors) {
    const value = input(vector);
    const market = encodeClaimId(value.market_id);
    const ticket = encodeClaimId(value.ticket_id);
    const domain = new TextEncoder().encode(CLAIM_COMMITMENT_DOMAIN);
    assert.equal(hex(domain), vector.domain_hex);
    assert.equal(hex(market), vector.market_frame_hex);
    assert.equal(hex(ticket), vector.ticket_frame_hex);
    assert.equal(
      hex(Buffer.concat([domain, market, ticket, value.claim_secret])),
      vector.preimage_hex,
    );
    const digest = deriveClaimCommitment(value);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, vector.expected_digest_hex);
    assert.notEqual(digest, vector.truncated_blake2b512_hex);
    assert.notEqual(digest, vector.alternate_domain_digest_hex);
  }
});

test("V01/U05: repeatability and no input mutation", () => {
  const value = input(primary);
  const before = value.claim_secret.slice();
  for (let repeat = 0; repeat < 10; repeat++)
    assert.equal(deriveClaimCommitment(value), primary.expected_digest_hex);
  assert.deepEqual(value.claim_secret, before);
});

test("V02/U05: every claim-secret bit mutation changes the bound commitment", () => {
  for (let bit = 0; bit < 256; bit++) {
    const value = input(primary);
    value.claim_secret[bit >> 3] ^= 1 << (bit & 7);
    assert.notEqual(deriveClaimCommitment(value), primary.expected_digest_hex);
  }
});

test("V02/U05: both final market and ticket IDs remain bound", () => {
  const value = input(primary);
  assert.notEqual(
    deriveClaimCommitment({ ...value, market_id: "m2" }),
    primary.expected_digest_hex,
  );
  assert.notEqual(
    deriveClaimCommitment({ ...value, ticket_id: "t2" }),
    primary.expected_digest_hex,
  );
  assert.notEqual(
    deriveClaimCommitment({
      ...value,
      market_id: value.ticket_id,
      ticket_id: value.market_id,
    }),
    primary.expected_digest_hex,
  );
});

test("U05: length frames distinguish ambiguous concatenations and embedded zero bytes", () => {
  const first = fixture.vectors.find((vector) => vector.name === "BOUNDARY_A");
  const second = fixture.vectors.find((vector) => vector.name === "BOUNDARY_B");
  assert.equal(
    first.input.market_id + first.input.ticket_id,
    second.input.market_id + second.input.ticket_id,
  );
  assert.notEqual(
    deriveClaimCommitment(input(first)),
    deriveClaimCommitment(input(second)),
  );
  assert.notEqual(first.expected_digest_hex, second.expected_digest_hex);
  const value = input(primary);
  assert.notEqual(
    deriveClaimCommitment({ ...value, market_id: "a\0", ticket_id: "b" }),
    deriveClaimCommitment({ ...value, market_id: "a", ticket_id: "\0b" }),
  );
});

test("U06: object field order and uncommitted display labels do not change bytes", () => {
  const value = input(primary);
  const reordered = {
    claim_secret: value.claim_secret,
    ticket_id: value.ticket_id,
    market_id: value.market_id,
    version: value.version,
    display_label: "Synthetic display label, not protocol input",
  };
  assert.equal(deriveClaimCommitment(reordered), primary.expected_digest_hex);
  assert.equal(
    deriveClaimCommitment({ ...reordered, display_label: "別の表示" }),
    primary.expected_digest_hex,
  );
});

test("U05/U06: UTF-8 byte lengths, big-endian length and exact case/normalization", () => {
  assert.equal(hex(encodeClaimId("é")), "0100000002c3a9");
  assert.equal(hex(encodeClaimId("票😀")), "0100000007e7a5a8f09f9880");
  assert.equal(hex(encodeClaimId("a".repeat(256))).slice(0, 10), "0100000100");
  // Encoding empty bytes is not a decision that an empty production ID is valid.
  assert.equal(hex(encodeClaimId("")), "0100000000");
  const value = input(primary);
  assert.notEqual(
    deriveClaimCommitment({ ...value, market_id: "é" }),
    deriveClaimCommitment({ ...value, market_id: "e\u0301" }),
  );
  assert.notEqual(
    deriveClaimCommitment({ ...value, ticket_id: "T1" }),
    primary.expected_digest_hex,
  );
});

test("U05: wrong versions fail rather than hashing another profile", () => {
  for (const version of [0, 2, -1, 256, "1", undefined, null, NaN]) {
    assert.throws(() => deriveClaimCommitment({ ...input(primary), version }), {
      message: "Unsupported claim encoding version",
    });
  }
  for (const version of [0, 2, -1, 256, "1", null]) {
    assert.throws(() => encodeClaimId("m1", version), {
      message: "Unsupported claim encoding version",
    });
  }
});

test("V02: 31/33-byte and non-byte secrets rejected without private error content", () => {
  for (const claim_secret of [
    new Uint8Array(31),
    new Uint8Array(33),
    new Uint8Array(0),
    "synthetic secret",
    Array(32).fill(1),
    new Uint16Array(32),
    null,
  ]) {
    assert.throws(
      () => deriveClaimCommitment({ ...input(primary), claim_secret }),
      { message: "Claim secret must be exactly 32 bytes" },
    );
  }
});

test("U05/U06: ill-formed Unicode and non-string IDs rejected before UTF-8 replacement", () => {
  for (const id of [
    "\ud800",
    "\udfff",
    "a\ud800b",
    "\udc00\ud800",
    17,
    {},
    null,
    undefined,
  ]) {
    assert.throws(() => encodeClaimId(id));
    assert.throws(() =>
      deriveClaimCommitment({ ...input(primary), market_id: id }),
    );
    assert.throws(() =>
      deriveClaimCommitment({ ...input(primary), ticket_id: id }),
    );
  }
  assert.doesNotThrow(() => encodeClaimId("\ud83d\ude00"));
  assert.notEqual(hex(encodeClaimId("\ufffd")), hex(encodeClaimId("?")));
});

test("U05: unsigned u32 length overflow is rejected before frame allocation (fault fixture)", () => {
  // Avoid allocating >4 GiB. Test-only platform fault; no injected encoder in production.
  const original = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = () => ({ length: 0x1_0000_0000 });
  try {
    assert.throws(() => encodeClaimId("synthetic"), {
      message: "Claim identifier too long",
    });
  } finally {
    TextEncoder.prototype.encode = original;
  }
});

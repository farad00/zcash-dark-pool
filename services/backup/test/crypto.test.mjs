import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  syntheticKeyPair,
  sealCapsule,
  openCapsule,
  validateCapsule,
  digest,
  assertSynthetic,
} from "../crypto.mjs";

const capsule = () => ({
  version: 1,
  scope: "SYNTHETIC_TEST",
  kind: "LOGICAL_QUARANTINE",
  database: "darkpool_phase9_0123456789abcdef",
  identity_bindings: { note: "synthetic-only" },
  credentials: [
    {
      purpose: "owner",
      login: "darkpool_owner_0123456789abcdef",
      password: randomBytes(32).toString("hex"),
    },
  ],
  dump: Buffer.from("PGDMP synthetic fixture").toString("base64"),
  dump_sha256: digest(Buffer.from("PGDMP synthetic fixture")),
});
test("standard age ciphertext roundtrips in a separate native process without DPAPI", async () => {
  const key = await syntheticKeyPair(),
    plain = capsule(),
    backup = await sealCapsule(plain, key.recipient);
  assert.ok(
    backup.ciphertext
      .subarray(0, 22)
      .toString()
      .startsWith("age-encryption.org/v1"),
  );
  assert.ok(
    JSON.stringify(
      await openCapsule(backup.ciphertext, key.identity, backup.receipt),
    ) === JSON.stringify(plain),
  );
  assert.ok(
    !backup.ciphertext.includes(Buffer.from(plain.credentials[0].password)),
  );
});
test("independent synthetic keys cannot decrypt one another's archive", async () => {
  const a = await syntheticKeyPair(),
    b = await syntheticKeyPair(),
    backup = await sealCapsule(capsule(), a.recipient);
  await assert.rejects(
    openCapsule(backup.ciphertext, b.identity, backup.receipt),
    /BACKUP_REJECTED/,
  );
});
test("missing retained recovery key cannot open an archive", async () => {
  const key = await syntheticKeyPair(),
    backup = await sealCapsule(capsule(), key.recipient);
  await assert.rejects(
    openCapsule(backup.ciphertext, "", backup.receipt),
    /BACKUP_REJECTED/,
  );
});
test("ciphertext corruption is rejected before any restore", async () => {
  const key = await syntheticKeyPair(),
    backup = await sealCapsule(capsule(), key.recipient),
    changed = Buffer.from(backup.ciphertext);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(
    openCapsule(changed, key.identity, backup.receipt),
    /BACKUP_REJECTED/,
  );
  // Even a caller supplying a new digest cannot defeat age authentication.
  await assert.rejects(
    openCapsule(changed, key.identity, {
      ...backup.receipt,
      ciphertext_sha256: digest(changed),
    }),
    /BACKUP_REJECTED/,
  );
});
test("truncated ciphertext rejects even with its substituted digest", async () => {
  const key = await syntheticKeyPair(),
    backup = await sealCapsule(capsule(), key.recipient),
    short = backup.ciphertext.subarray(0, -1);
  await assert.rejects(
    openCapsule(short, key.identity, {
      ...backup.receipt,
      ciphertext_sha256: digest(short),
    }),
    /BACKUP_REJECTED/,
  );
});
test("independently retained receipt detects substitution by another valid age archive", async () => {
  const key = await syntheticKeyPair(),
    a = await sealCapsule(capsule(), key.recipient),
    b = await sealCapsule(capsule(), key.recipient);
  await assert.rejects(
    openCapsule(b.ciphertext, key.identity, a.receipt),
    /BACKUP_REJECTED/,
  );
});
test("capsule tampering, duplicate credentials and live selectors reject", () => {
  const value = capsule();
  assert.throws(
    () => validateCapsule({ ...value, dump_sha256: "0".repeat(64) }),
    /BACKUP_REJECTED/,
  );
  assert.throws(
    () =>
      validateCapsule({
        ...value,
        credentials: [value.credentials[0], value.credentials[0]],
      }),
    /BACKUP_REJECTED/,
  );
  assert.throws(
    () =>
      validateCapsule({
        ...value,
        database: "darkpool_phase9_evidence_payment_v2",
      }),
    /BACKUP_REJECTED/,
  );
  assert.throws(
    () => validateCapsule({ ...value, scope: "EXTERNAL" }),
    /BACKUP_REJECTED/,
  );
  assert.throws(
    () => validateCapsule({ ...value, unexpected: true }),
    /BACKUP_REJECTED/,
  );
});
test("backup crypto has no production or preserved-environment activation", () => {
  for (const kind of ["LIVE_EVIDENCE", "HISTORICAL", undefined])
    assert.throws(
      () =>
        assertSynthetic({
          DARKPOOL_PG_ENV: kind,
          DARKPOOL_TEST_ONLY: "TEST_ONLY",
          DARKPOOL_BACKUP_TEST_ONLY: "1",
        }),
      /BACKUP_REJECTED/,
    );
  assert.throws(
    () =>
      assertSynthetic({
        DARKPOOL_PG_ENV: "TEST",
        DARKPOOL_TEST_ONLY: "TEST_ONLY",
        DARKPOOL_BACKUP_TEST_ONLY: "1",
        DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2",
      }),
    /BACKUP_REJECTED/,
  );
});

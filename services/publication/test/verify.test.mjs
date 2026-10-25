import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  authority,
  envelope,
  executable,
  copy,
  syntheticRetrieval,
} from "./fixtures.mjs";
import { verifyPublication, hasNonce } from "../verify.mjs";
import { canonical, envelopeBytes } from "../profile.mjs";
import { provisionPublicationScript } from "../../../db/publication-provision.mjs";

let issuer, ledger, proof;
before(async () => {
  issuer = await authority();
  ledger = envelope();
  proof = await issuer.evidence(ledger);
});
after(async () => {
  await issuer?.close();
});
const verify = (evidence = proof, trust = issuer.trust, expected = ledger) =>
  verifyPublication(
    expected,
    evidence,
    trust,
    executable,
    syntheticRetrieval(proof),
  );
test("OpenSSL nonce text permits omitted leading zeroes but rejects absent/zero/malformed nonces", () => {
  assert.equal(hasNonce("Nonce: 0x0123456789ABCDEF\n"), true);
  assert.equal(hasNonce("Nonce: 0x123456789ABCDEF\n"), true);
  for (const text of [
    "Nonce: unspecified\n",
    "Nonce: unspecified\nNonce: 0x1234567890ABCDEF\n",
    "Nonce: 0x0000\n",
    "Nonce: 0xZZ\n",
  ])
    assert.equal(hasNonce(text), false);
});

test("synthetic signed witness and real local RFC3161/CRL verification; deterministic identity", async () => {
  const a = await verify(),
    b = await verify();
  assert.equal(a.evidence_class, "SYNTHETIC_TEST");
  assert.equal(a.receipt_id, b.receipt_id);
  assert.equal(a.merkle_root, ledger.merkle_root);
});
test("unconfigured external trust is explicitly unavailable", async () => {
  for (const config of [null, { status: "UNAVAILABLE" }])
    await assert.rejects(verify(proof, config), /PUBLICATION_UNAVAILABLE/);
});
test("missing or unavailable independent retrieval cannot claim verification", async () => {
  await assert.rejects(
    verifyPublication(ledger, proof, issuer.trust, executable),
    /PUBLICATION_UNAVAILABLE/,
  );
  await assert.rejects(
    verifyPublication(ledger, proof, issuer.trust, executable, async () => ({
      status: "UNAVAILABLE",
    })),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("independent archive/content or commit mismatch rejected", async () => {
  for (const change of [
    { archive_bytes: Buffer.from("changed").toString("base64") },
    { repository_bytes: Buffer.from("changed").toString("base64") },
    { commit: "ee".repeat(20) },
  ]) {
    await assert.rejects(
      verifyPublication(
        ledger,
        proof,
        issuer.trust,
        executable,
        async (binding) => ({
          ...(await syntheticRetrieval(proof)(binding)),
          ...change,
        }),
      ),
    );
  }
});
test("round-tripped UTC parsing rejects impossible calendar dates", () => {
  assert.throws(() =>
    envelopeBytes({ ...ledger, locked_at: "2026-02-31T00:00:00Z" }),
  );
});
test("missing witness/TSA evidence fails closed", async () => {
  for (const field of ["statement", "signature", "tsq", "tsr", "envelope"]) {
    const bad = copy(proof);
    delete bad[field];
    await assert.rejects(verify(bad), /PUBLICATION_REJECTED/);
  }
});
test("forged signature rejected", async () => {
  const bad = copy(proof);
  bad.signature = Buffer.alloc(64).toString("base64");
  await assert.rejects(verify(bad));
});
test("untrusted witness key rejected", async () => {
  const other = await authority();
  try {
    await assert.rejects(
      verify(proof, {
        ...issuer.trust,
        witness_spki: other.trust.witness_spki,
      }),
    );
  } finally {
    await other.close();
  }
});
test("tampered timestamp and request rejected", async () => {
  for (const field of ["tsq", "tsr"]) {
    const bad = copy(proof);
    bad[field] = Buffer.alloc(100).toString("base64");
    await assert.rejects(verify(bad));
  }
});
test("timestamp of another signed package fails message imprint / nonce verification", async () => {
  const other = await issuer.evidence(ledger, (s) => {
    s.commit = "34".repeat(20);
  });
  await assert.rejects(verify({ ...proof, tsq: other.tsq, tsr: other.tsr }));
  await assert.rejects(verify({ ...proof, tsq: other.tsq }));
});
test("untrusted TSA root rejected", async () => {
  const other = await authority();
  try {
    await assert.rejects(
      verify(proof, { ...issuer.trust, ca_bundle: other.trust.ca_bundle }),
    );
  } finally {
    await other.close();
  }
});
test("wrong TSA policy rejected", async () => {
  await assert.rejects(
    verify(proof, { ...issuer.trust, tsa_policy_oid: "1.2.3.4.9" }),
  );
});
test("root and count envelope mismatch rejected", async () => {
  for (const expected of [
    { ...ledger, merkle_root: "cd".repeat(32) },
    { ...ledger, accepted_ticket_count: "3" },
  ])
    await assert.rejects(verify(proof, issuer.trust, expected));
});
test("signed incorrect repository, commit blob, archive, network and retention rejected", async () => {
  for (const [field, value] of [
    ["repository", "https://github.com/other/ledger"],
    ["git_blob_sha1", "00".repeat(20)],
    ["archive_url", "https://evil.invalid/copy"],
    ["network", "mainnet"],
    ["retention", "NOT_RETAINED"],
    ["evidence_class", "EXTERNAL"],
  ]) {
    const bad = await issuer.evidence(ledger, (s) => {
      s[field] = value;
    });
    await assert.rejects(verify(bad));
  }
});
test("future and pre-lock observation rejected", async () => {
  for (const value of [
    new Date(Date.now() + 3600000).toISOString(),
    "2000-01-01T00:00:00Z",
  ])
    await assert.rejects(
      verify(
        await issuer.evidence(ledger, (s) => {
          s.observed_at = value;
        }),
      ),
    );
});
test("invalid UTF-8, extra private fields and noncanonical envelope bytes rejected", async () => {
  await assert.rejects(
    verify({ ...proof, envelope: Buffer.from([255]).toString("base64") }),
  );
  assert.throws(() => envelopeBytes({ ...ledger, side: "YES" }));
  assert.throws(() => canonical({ value: "\ud800" }));
  await assert.rejects(
    verify({ ...proof, claim_secret: "sensitive-synthetic-marker" }),
  );
  await assert.rejects(
    verify({
      ...proof,
      envelope: Buffer.from(JSON.stringify(ledger, null, 2)).toString("base64"),
    }),
  );
});
test("TEST provisioning refuses external trust and unsafe roles/targets", () => {
  assert.throws(() =>
    provisionPublicationScript(
      "owner;DROP",
      "darkpool_phase9_" + "ab".repeat(8),
      issuer.trust,
    ),
  );
  assert.throws(() =>
    provisionPublicationScript("verifier", "existing_live", issuer.trust),
  );
  assert.throws(
    () =>
      provisionPublicationScript(
        "verifier",
        "darkpool_phase9_" + "ab".repeat(8),
        { ...issuer.trust, evidence_class: "EXTERNAL" },
      ),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("revoked timestamp signer fails actual CRL verification", async () => {
  const other = await authority();
  try {
    const evidence = await other.evidence(ledger),
      revoked = await other.revoke();
    await assert.rejects(verify(evidence, revoked));
  } finally {
    await other.close();
  }
});

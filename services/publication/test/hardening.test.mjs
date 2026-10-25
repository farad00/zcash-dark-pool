import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import {
  authority,
  envelope,
  executable,
  copy,
  syntheticRetrieval,
} from "./fixtures.mjs";
import { verifyRfc3161, tsaProfile, clockCheckRecord } from "../rfc3161.mjs";
import { signedPolicyOid, numericOid } from "../tst-policy.mjs";
import { canonical, sha256, trustProfile } from "../profile.mjs";
import { verifyPublication } from "../verify.mjs";

globalThis.fetch = async () => {
  throw new Error("TEST_NETWORK_DISABLED");
};
let issuer, ledger, proof;
before(async () => {
  issuer = await authority({ policyOid: "1.2.3.4.1" });
  ledger = envelope();
  proof = await issuer.evidence(ledger);
});
after(async () => {
  await issuer?.close();
});
const clocks = (now = Date.now()) =>
  ["COMPUTER_A", "COMPUTER_B"].map((device) => ({
    device,
    source: "synthetic-time.invalid",
    checked_at: new Date(now).toISOString(),
    offset_milliseconds: 12,
    report_sha256: "ab".repeat(32),
  }));
function input(e = proof, t = issuer.trust) {
  return {
    query: Buffer.from(e.tsq, "base64"),
    reply: Buffer.from(e.tsr, "base64"),
    data: Buffer.from(
      canonical({ statement: e.statement, signature: e.signature }),
    ),
    ca_bundle: t.ca_bundle,
    policy: t.tsa_verification,
    policy_oid: t.tsa_policy_oid,
    executable,
    observed_at: e.statement.observed_at,
    locked_at: ledger.locked_at,
  };
}
test("numeric policy passes with OpenSSL tsa_policy1 display alias and retained nonce", async () => {
  const p = await verifyRfc3161({ ...input(), clock_checks: clocks() });
  assert.equal(p.policy_oid, "1.2.3.4.1");
  assert.equal(p.financial_authorization, "NOT_GRANTED");
  assert.equal(p.clock_assurance, "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME");
  assert.equal(
    p.signer_certificate_sha256,
    issuer.trust.tsa_verification.signer_certificate_sha256,
  );
});
test("historical public signed DER has exact numeric policy and literal digest", async () => {
  const bytes = await readFile(
    new URL("./public-freetsa/sample-tstinfo.der", import.meta.url),
  );
  assert.equal(
    sha256(bytes),
    "55150cfd73b25f24bb2a0aa3b99ddb7749afe1e2c889493e75283b1939fc7805",
  );
  assert.equal(signedPolicyOid(bytes), "1.2.3.4.1");
});
test("malformed/noncanonical DER and numeric policy representations reject", () => {
  for (const h of [
    "308002010106042a0304010000",
    "300c020101060480030401",
    "300a02010106042a030480",
    "300a02010206042a030401",
    "300a02010106042a03040100",
    "30810a02010106042a030401",
  ])
    assert.throws(() => signedPolicyOid(Buffer.from(h, "hex")));
  for (const s of [
    "tsa_policy1",
    "1.02.3",
    "3.1.2",
    "1.40.1",
    "1.2.3.",
    "1.2.3.4.1\n",
  ])
    assert.throws(() => numericOid(s));
});
test("wrong numeric policy and display alias configuration reject", async () => {
  for (const oid of ["1.2.3.4.2", "tsa_policy1", "1.02.3.4.1"])
    await assert.rejects(verifyRfc3161({ ...input(), policy_oid: oid }));
});
test("altered query nonce with otherwise identical request rejects", async () => {
  const a = input(),
    q = Buffer.from(a.query);
  // OpenSSL-generated TSQ ends in canonical certReq TRUE; find its INTEGER nonce.
  const suffix = Buffer.from([1, 1, 255]);
  assert(q.subarray(-3).equals(suffix));
  q[q.length - 4] ^= 1;
  await assert.rejects(verifyRfc3161({ ...a, query: q }));
});
test("a second valid request cannot substitute for the original nonce", async () => {
  const other = await issuer.evidence(ledger);
  await assert.rejects(
    verifyRfc3161({ ...input(), query: Buffer.from(other.tsq, "base64") }),
  );
});
test("wrong data digest and altered token reject", async () => {
  await assert.rejects(
    verifyRfc3161({ ...input(), data: Buffer.from("wrong synthetic data") }),
  );
  const a = input();
  a.reply[a.reply.length - 1] ^= 1;
  await assert.rejects(verifyRfc3161(a));
});
test("certificate pin and independent SPKI pin are both mandatory", async () => {
  for (const field of ["signer_certificate_sha256", "signer_spki_sha256"]) {
    const p = copy(issuer.trust.tsa_verification);
    p[field] = "00".repeat(32);
    await assert.rejects(verifyRfc3161({ ...input(), policy: p }));
  }
  assert.throws(() =>
    tsaProfile({
      ...issuer.trust.tsa_verification,
      signer_certificate: "AAAA",
    }),
  );
});
test("token-supplied root cannot replace independently pinned anchors", async () => {
  const p = copy(issuer.trust.tsa_verification);
  p.anchor_certificate_sha256 = ["00".repeat(32)];
  await assert.rejects(verifyRfc3161({ ...input(), policy: p }));
});
test("missing, stale and unavailable CRL material fail closed", async () => {
  const a = input(),
    p = copy(a.policy);
  await assert.rejects(
    verifyRfc3161({
      ...a,
      ca_bundle: a.ca_bundle.replace(
        /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/,
        "",
      ),
    }),
  );
  p.crl_fetch_records[0].retrieved_at = "2000-01-01T00:00:00Z";
  await assert.rejects(
    verifyRfc3161({ ...a, policy: p }),
    /PUBLICATION_UNAVAILABLE/,
  );
  await assert.rejects(
    verifyRfc3161({
      ...a,
      executable: "C:\\unavailable-synthetic-openssl.exe",
    }),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("invalid CRL signature rejects even when its configured digest matches", async () => {
  const a = input(),
    m = /-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/.exec(
      a.ca_bundle,
    );
  const der = Buffer.from(m[1].replace(/\s/g, ""), "base64");
  der[der.length - 1] ^= 1;
  const p = copy(a.policy);
  p.crl_fetch_records[0].sha256 = sha256(der);
  const pem =
    "-----BEGIN X509 CRL-----\n" +
    der
      .toString("base64")
      .match(/.{1,64}/g)
      .join("\n") +
    "\n-----END X509 CRL-----";
  await assert.rejects(
    verifyRfc3161({
      ...a,
      policy: p,
      ca_bundle: a.ca_bundle.replace(m[0], pem),
    }),
  );
});
test("expired signer and future revocation-fetch records reject", async () => {
  const a = input(),
    p = copy(a.policy);
  p.min_crl_remaining_seconds = 86400;
  // CRL lives seven days; one-week-later clock must fail (not alter system time).
  const later = Date.now() + 8 * 86400000;
  p.crl_fetch_records[0].retrieved_at = new Date(later).toISOString();
  await assert.rejects(verifyRfc3161({ ...a, policy: p, now: later }));
  p.crl_fetch_records[0].retrieved_at = new Date(
    Date.now() + 60000,
  ).toISOString();
  await assert.rejects(
    verifyRfc3161({ ...a, policy: p }),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("clock records cannot substitute arbitrary local timestamps for authenticated time", () => {
  const now = Date.now(),
    c = clocks(now)[0];
  assert.equal(
    clockCheckRecord(c, now).classification,
    "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME",
  );
  for (const change of [
    { checked_at: "2000-01-01T00:00:00Z" },
    { checked_at: new Date(now + 1).toISOString() },
    { offset_milliseconds: 30001 },
    { report_sha256: "bad" },
    { device: "OTHER" },
    { source: "user supplied\nvalue" },
  ])
    assert.throws(() => clockCheckRecord({ ...c, ...change }, now));
});

test("short-lived and expired CRLs reject while signer remains valid", async () => {
  const f = await authority({ policyOid: "1.2.3.4.1" });
  try {
    const e = await f.evidence(ledger),
      t = await f.refreshCrl(1);
    await assert.rejects(verifyRfc3161(input(e, t)), /PUBLICATION_UNAVAILABLE/);
    const later = Date.now() + 2 * 3600000,
      p = copy(t.tsa_verification);
    p.min_crl_remaining_seconds = 0;
    p.crl_fetch_records[0].retrieved_at = new Date(later).toISOString();
    await assert.rejects(
      verifyRfc3161({ ...input(e, t), policy: p, now: later }),
      /PUBLICATION_UNAVAILABLE/,
    );
  } finally {
    await f.close();
  }
});

test("proposed testnet common-control policy pins public material but cannot activate trust", async () => {
  const p = JSON.parse(
    await readFile(
      new URL("../freetsa-testnet.proposed.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(p.status, "PROPOSED_NOT_APPROVED");
  assert.equal(p.scope, "TESTNET_ONLY_COMMON_CONTROL");
  assert.equal(p.financial_authorization, "NOT_GRANTED");
  assert.equal(p.max_clock_skew_seconds, 120);
  assert.equal(p.max_witness_lag_seconds, 900);
  assert.equal(p.tsa_policy_oid, "1.2.3.4.1");
  const cert = new X509Certificate(
    Buffer.from(p.tsa_verification.signer_certificate, "base64"),
  );
  assert.equal(
    sha256(cert.raw),
    "32e841a95cc1164101ffde41298ef2fc75c1c4372ef095e88a6bbd47dfb191fc",
  );
  assert.equal(
    sha256(cert.publicKey.export({ type: "spki", format: "der" })),
    "fa02bd555e3e483d62b4e70be6218692068d2b0b0a7525db58dcbf2901cdb072",
  );
  assert.throws(() => trustProfile(p), /PUBLICATION_UNAVAILABLE/);
});

test("offline timestamp diagnostic retains nonauthorizing audit and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "darkpool-timestamp-cli-"));
  try {
    const p = {
      version: 1,
      status: "PROPOSED_NOT_APPROVED",
      scope: "TESTNET_ONLY_COMMON_CONTROL",
      financial_authorization: "NOT_GRANTED",
      tsa_policy_oid: issuer.trust.tsa_policy_oid,
      tsa_verification: issuer.trust.tsa_verification,
      ca_bundle: issuer.trust.ca_bundle,
      max_clock_skew_seconds: 120,
      max_witness_lag_seconds: 900,
    };
    const a = input(),
      q = {
        query: proof.tsq,
        reply: proof.tsr,
        data: a.data.toString("base64"),
        observed_at: a.observed_at,
        locked_at: a.locked_at,
        clock_checks: clocks(),
      };
    await Promise.all([
      writeFile(join(dir, "policy.json"), JSON.stringify(p)),
      writeFile(join(dir, "input.json"), JSON.stringify(q)),
    ]);
    const args = [
      "tools/commitment-witness/verify-timestamp.mjs",
      join(dir, "policy.json"),
      join(dir, "input.json"),
      join(dir, "audit.json"),
    ];
    const run = promisify(execFile);
    await run(process.execPath, args, { windowsHide: true, timeout: 15000 });
    const audit = JSON.parse(await readFile(join(dir, "audit.json"), "utf8"));
    assert.equal(audit.status, "RFC3161_ONLY_NOT_PUBLICATION_VERIFICATION");
    assert.equal(audit.financial_authorization, false);
    assert.equal(audit.third_party_independence, false);
    assert(!("receipt_id" in audit));
    const bytes = await readFile(join(dir, "audit.json"));
    await assert.rejects(
      run(process.execPath, args, { windowsHide: true, timeout: 15000 }),
    );
    assert.deepEqual(await readFile(join(dir, "audit.json")), bytes);
    await writeFile(
      join(dir, "input.json"),
      JSON.stringify({ ...q, executable: process.execPath }),
    );
    await assert.rejects(
      run(
        process.execPath,
        [...args.slice(0, -1), join(dir, "untrusted-executable-audit.json")],
        { windowsHide: true, timeout: 15000 },
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("clock skew and witness lag are configurable and enforced", async () => {
  const a = input(),
    now = Date.now();
  await assert.rejects(
    verifyRfc3161({
      ...a,
      observed_at: new Date(now + 121000).toISOString(),
      now,
      clock_skew_seconds: 120,
    }),
  );
  const observed = new Date(
    Date.parse(proof.statement.observed_at) - 905000,
  ).toISOString();
  await assert.rejects(
    verifyRfc3161({
      ...a,
      observed_at: observed,
      locked_at: new Date(Date.parse(observed) - 1000).toISOString(),
      witness_lag_seconds: 900,
    }),
  );
  await assert.rejects(verifyRfc3161({ ...a, clock_checks: [clocks()[0]] }));
});
test("old READY profiles cannot silently omit required hardening", () => {
  const t = copy(issuer.trust);
  delete t.tsa_verification;
  assert.throws(() => trustProfile(t));
});
test("full receipt verification records audit and audit failure prevents success", async () => {
  let audit;
  const checkedAt = Date.now();
  await verifyPublication(
    ledger,
    proof,
    issuer.trust,
    executable,
    syntheticRetrieval(proof),
    checkedAt,
    {
      clock_checks: clocks(checkedAt),
      recordClockAudit: async (v) => {
        audit = v;
      },
    },
  );
  assert.equal(audit.policy_oid, "1.2.3.4.1");
  assert.equal(audit.clock_checks.length, 2);
  const failureCheckedAt = Date.now();
  let auditAttempted = false;
  await assert.rejects(
    verifyPublication(
      ledger,
      proof,
      issuer.trust,
      executable,
      syntheticRetrieval(proof),
      failureCheckedAt,
      {
        clock_checks: clocks(failureCheckedAt),
        recordClockAudit: async () => {
          auditAttempted = true;
          throw Error("AUDIT_NOT_DURABLE");
        },
      },
    ),
  );
  assert.equal(auditAttempted, true);
});
test("external path requires both device checks and a durable audit sink", async () => {
  const t = { ...issuer.trust, evidence_class: "EXTERNAL" };
  const e = await issuer.evidence(ledger, (s) => {
    s.evidence_class = "EXTERNAL";
  });
  await assert.rejects(
    verifyPublication(ledger, e, t, executable, async () => {
      throw Error("MUST_NOT_RETRIEVE");
    }),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("revoked signer fails with current signed CRL and correct freshness metadata", async () => {
  const f = await authority({ policyOid: "1.2.3.4.1" });
  try {
    const e = await f.evidence(ledger),
      t = await f.revoke();
    await assert.rejects(verifyRfc3161(input(e, t)));
  } finally {
    await f.close();
  }
});
test("same-CA alternate signer and same-key certificate renewal require new pins", async () => {
  for (const reuseKey of [false, true]) {
    const f = await authority({ policyOid: "1.2.3.4.1" });
    try {
      const original = copy(f.trust),
        rotated = await f.rotate({ reuseKey }),
        e = await f.evidence(ledger);
      assert.notEqual(
        rotated.tsa_verification.signer_certificate_sha256,
        original.tsa_verification.signer_certificate_sha256,
      );
      assert.equal(
        rotated.tsa_verification.signer_spki_sha256 ===
          original.tsa_verification.signer_spki_sha256,
        reuseKey,
      );
      await assert.rejects(verifyRfc3161(input(e, original)));
      assert.equal(
        (await verifyRfc3161(input(e, rotated))).policy_oid,
        "1.2.3.4.1",
      );
    } finally {
      await f.close();
    }
  }
});
test("non-timestamping EKU certificate is ineligible even with matching pins", async () => {
  const f = await authority();
  try {
    const t = await f.rotate({ extension: "server" });
    assert.throws(() => tsaProfile(t.tsa_verification));
  } finally {
    await f.close();
  }
});

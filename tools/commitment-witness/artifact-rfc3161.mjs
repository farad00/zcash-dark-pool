// ARTIFACT EXISTENCE ONLY. No capture/publication timing parameter or authorization.
// Production services/publication/rfc3161.mjs is intentionally unchanged.
import { X509Certificate } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import {
  exact,
  canonical,
  sha256,
  decode64,
  utc,
} from "../../services/publication/profile.mjs";
import {
  tsaProfile,
  clockCheckRecord,
} from "../../services/publication/rfc3161.mjs";
import {
  openssl,
  opensslDetailed,
} from "../../services/publication/openssl.mjs";
import { signedPolicyOid } from "../../services/publication/tst-policy.mjs";
import { artifactQueryBinding } from "./artifact-query.mjs";

export const ARTIFACT_LABELS = Object.freeze({
  scope: "SYNTHETIC_ARTIFACT_TIMESTAMP_ONLY",
  assertion: "ARTIFACT_EXISTENCE_ONLY",
  publication: "NOT_TIMELY_PUBLICATION",
  authorization: "NOT_FINANCIALLY_AUTHORIZED",
  control: "COMMON_HUMAN_CONTROL",
  financial_authorization: "NOT_GRANTED",
  third_party_independence: "NO",
});
const fail = () => {
  throw Error("ARTIFACT_TIMESTAMP_REJECTED");
};
export function artifactTrust(input) {
  exact(input, [
    "version",
    "scope",
    "status",
    "financial_authorization",
    "endpoint",
    "tsa_policy_oid",
    "clock_skew_seconds",
    "ca_bundle",
    "tsa_verification",
  ]);
  const p = JSON.parse(canonical(input));
  if (
    p.version !== 1 ||
    p.scope !== ARTIFACT_LABELS.scope ||
    p.status !== "ARTIFACT_ONLY_APPROVED" ||
    p.financial_authorization !== "NOT_GRANTED" ||
    p.endpoint !== "https://freetsa.org/tsr" ||
    p.tsa_policy_oid !== "1.2.3.4.1" ||
    p.clock_skew_seconds !== 120
  )
    fail();
  tsaProfile(p.tsa_verification);
  return p;
}
function clockRecords(records, now) {
  if (
    !Number.isSafeInteger(now) ||
    !Array.isArray(records) ||
    records.length !== 2
  )
    fail();
  const got = records.map((r) => clockCheckRecord(r, now));
  if (new Set(got.map((r) => r.device)).size !== 2) fail();
  return got;
}
async function withAuthority(trust, executable, now, work) {
  const policy = tsaProfile(trust.tsa_verification),
    signer = new X509Certificate(decode64(policy.signer_certificate));
  if (now < Date.parse(signer.validFrom) || now > Date.parse(signer.validTo))
    fail();
  if (typeof trust.ca_bundle !== "string" || trust.ca_bundle.length > 131072)
    fail();
  const pattern =
    /-----BEGIN (CERTIFICATE|X509 CRL)-----[\s\S]*?-----END \1-----/g;
  const blocks = trust.ca_bundle.match(pattern) ?? [];
  if (trust.ca_bundle.replace(pattern, "").trim()) fail();
  const roots = blocks.filter((b) => b.startsWith("-----BEGIN CERTIFICATE"));
  const crls = blocks.filter((b) => b.startsWith("-----BEGIN X509 CRL"));
  if (
    roots.length !== policy.anchor_certificate_sha256.length ||
    crls.length !== policy.crl_fetch_records.length
  )
    fail();
  const pins = roots.map((b) => {
    const root = new X509Certificate(b);
    if (
      !root.ca ||
      !root.checkIssued(root) ||
      !root.verify(root.publicKey) ||
      now < Date.parse(root.validFrom) ||
      now > Date.parse(root.validTo)
    )
      fail();
    return sha256(root.raw);
  });
  if (
    new Set(pins).size !== pins.length ||
    pins.sort().join() !== [...policy.anchor_certificate_sha256].sort().join()
  )
    fail();
  const parent = resolve(tmpdir()),
    dir = await mkdtemp(join(parent, "darkpool-artifact-tsa-"));
  const file = (n) => join(dir, n);
  try {
    await writeFile(file("ca"), trust.ca_bundle, { flag: "wx", mode: 0o600 });
    await writeFile(file("signer"), signer.toString(), {
      flag: "wx",
      mode: 0o600,
    });
    for (const [i, crl] of crls.entries()) {
      const path = file("crl-" + i);
      await writeFile(path, crl, { flag: "wx", mode: 0o600 });
      const der = Buffer.from(
        crl.replace(/-----[^\r\n]+-----|\s/g, ""),
        "base64",
      );
      const retained = policy.crl_fetch_records.find(
        (r) => r.sha256 === sha256(der),
      );
      if (
        !retained ||
        utc(retained.retrieved_at) > now ||
        now - utc(retained.retrieved_at) >
          policy.max_crl_fetch_age_seconds * 1000
      )
        fail();
      const checked = await opensslDetailed(executable, [
        "crl",
        "-in",
        path,
        "-noout",
        "-verify",
        "-CAfile",
        file("ca"),
      ]);
      if (checked.stderr.trim() !== "verify OK") fail();
      const dates = await openssl(executable, [
        "crl",
        "-in",
        path,
        "-noout",
        "-lastupdate",
        "-nextupdate",
      ]);
      const start = Date.parse(/^lastUpdate=(.+)$/m.exec(dates)?.[1]),
        end = Date.parse(/^nextUpdate=(.+)$/m.exec(dates)?.[1]);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start > now ||
        end <= now + policy.min_crl_remaining_seconds * 1000
      )
        fail();
    }
    await openssl(executable, [
      "verify",
      "-purpose",
      "timestampsign",
      "-crl_check_all",
      "-CAfile",
      file("ca"),
      "-CApath",
      dir,
      "-CAstore",
      file("ca"),
      file("signer"),
    ]);
    return await work({ dir, file, signer, policy });
  } finally {
    if (
      dirname(resolve(dir)) !== parent ||
      !basename(dir).startsWith("darkpool-artifact-tsa-")
    )
      fail();
    await rm(dir, { recursive: true, force: true });
  }
}
export async function checkArtifactTrust(
  input,
  executable,
  records,
  now = Date.now(),
) {
  const trust = artifactTrust(input);
  clockRecords(records, now);
  return withAuthority(trust, executable, now, async () => ({
    status: "ARTIFACT_TRUST_VERIFIED",
    ...ARTIFACT_LABELS,
  }));
}
export async function verifyArtifactRfc3161({
  query,
  reply,
  data,
  trust: input,
  executable,
  clock_checks,
  now = Date.now(),
}) {
  const trust = artifactTrust(input),
    clocks = clockRecords(clock_checks, now);
  if (
    !Buffer.isBuffer(reply) ||
    !reply.length ||
    reply.length > 262144 ||
    !Buffer.isBuffer(data) ||
    data.length > 65536
  )
    fail();
  query = Buffer.from(query);
  reply = Buffer.from(reply);
  data = Buffer.from(data);
  const binding = artifactQueryBinding(query, data);
  return withAuthority(
    trust,
    executable,
    now,
    async ({ dir, file, signer, policy }) => {
      for (const [name, bytes] of [
        ["query", query],
        ["reply", reply],
        ["data", data],
      ])
        await writeFile(file(name), bytes, { flag: "wx", mode: 0o600 });
      await openssl(executable, [
        "ts",
        "-reply",
        "-in",
        file("reply"),
        "-token_out",
        "-out",
        file("token"),
      ]);
      await openssl(executable, [
        "cms",
        "-verify",
        "-inform",
        "DER",
        "-in",
        file("token"),
        "-nointern",
        "-certfile",
        file("signer"),
        "-CAfile",
        file("ca"),
        "-CApath",
        dir,
        "-CAstore",
        file("ca"),
        "-purpose",
        "timestampsign",
        "-crl_check_all",
        "-signer",
        file("actual-signer"),
        "-out",
        file("content"),
      ]);
      if (
        !new X509Certificate(await readFile(file("actual-signer"))).raw.equals(
          signer.raw,
        )
      )
        fail();
      if (signedPolicyOid(await readFile(file("content"))) !== "1.2.3.4.1")
        fail();
      const text = await openssl(executable, [
        "ts",
        "-reply",
        "-in",
        file("token"),
        "-token_in",
        "-text",
      ]);
      const nonce = /^Nonce: 0x([0-9a-fA-F]{1,64})$/m.exec(text)?.[1];
      if (
        !nonce ||
        BigInt("0x" + nonce) === 0n ||
        BigInt("0x" + nonce).toString(16) !== binding.nonce_hex ||
        /^Hash Algorithm: (.+)$/m.exec(text)?.[1] !== "sha256"
      )
        fail();
      const common = [
        "-in",
        file("reply"),
        "-CAfile",
        file("ca"),
        "-CApath",
        dir,
        "-CAstore",
        file("ca"),
        "-untrusted",
        file("signer"),
        "-crl_check_all",
      ];
      await openssl(executable, [
        "ts",
        "-verify",
        "-queryfile",
        file("query"),
        ...common,
      ]);
      await openssl(executable, [
        "ts",
        "-verify",
        "-data",
        file("data"),
        ...common,
      ]);
      const timestamp = Date.parse(/^Time stamp: (.+)$/m.exec(text)?.[1]);
      // Deliberately NO observed_at, locked_at or publication-lag input. Nothing
      // resets/relabels the expired observation. This is only an existence proof.
      if (
        !Number.isFinite(timestamp) ||
        timestamp > now + 120000 ||
        timestamp < Date.parse(signer.validFrom) ||
        timestamp > Date.parse(signer.validTo)
      )
        fail();
      return {
        ...ARTIFACT_LABELS,
        ...binding,
        reply_sha256: sha256(reply),
        timestamp_at: new Date(timestamp).toISOString(),
        policy_oid: "1.2.3.4.1",
        signer_certificate_sha256: policy.signer_certificate_sha256,
        signer_spki_sha256: policy.signer_spki_sha256,
        clock_checks: clocks,
        clock_assurance: "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME",
      };
    },
  );
}

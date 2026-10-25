import { X509Certificate } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  exact,
  reject,
  hex,
  sha256,
  decode64,
  utc,
} from "./profile.mjs";
import { openssl, opensslDetailed } from "./openssl.mjs";
import { numericOid, signedPolicyOid } from "./tst-policy.mjs";

const unavailable = () => {
  throw new Error("PUBLICATION_UNAVAILABLE");
};
const certPin = (cert) => sha256(cert.raw);
const spkiPin = (cert) =>
  sha256(cert.publicKey.export({ type: "spki", format: "der" }));
export function tsaProfile(input) {
  exact(input, [
    "version",
    "signer_certificate",
    "signer_certificate_sha256",
    "signer_spki_sha256",
    "anchor_certificate_sha256",
    "crl_fetch_records",
    "max_crl_fetch_age_seconds",
    "min_crl_remaining_seconds",
  ]);
  const p = JSON.parse(canonical(input));
  if (p.version !== 1) reject();
  const cert = new X509Certificate(decode64(p.signer_certificate, 16384));
  if (
    p.signer_certificate !== cert.raw.toString("base64") ||
    cert.ca ||
    cert.keyUsage?.length !== 1 ||
    cert.keyUsage[0] !== "1.3.6.1.5.5.7.3.8" ||
    hex(p.signer_certificate_sha256, 32) !== certPin(cert) ||
    hex(p.signer_spki_sha256, 32) !== spkiPin(cert)
  )
    reject();
  if (
    !Array.isArray(p.anchor_certificate_sha256) ||
    !p.anchor_certificate_sha256.length ||
    p.anchor_certificate_sha256.length > 8
  )
    reject();
  for (const h of p.anchor_certificate_sha256) hex(h, 32);
  if (
    new Set(p.anchor_certificate_sha256).size !==
    p.anchor_certificate_sha256.length
  )
    reject();
  if (
    !Array.isArray(p.crl_fetch_records) ||
    !p.crl_fetch_records.length ||
    p.crl_fetch_records.length > 8
  )
    reject();
  for (const f of p.crl_fetch_records) {
    exact(f, ["sha256", "retrieved_at", "source"]);
    hex(f.sha256, 32);
    utc(f.retrieved_at);
    if (
      typeof f.source !== "string" ||
      !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(f.source)
    )
      reject();
  }
  if (
    new Set(p.crl_fetch_records.map((x) => x.sha256)).size !==
    p.crl_fetch_records.length
  )
    reject();
  if (
    !Number.isSafeInteger(p.max_crl_fetch_age_seconds) ||
    p.max_crl_fetch_age_seconds < 1 ||
    p.max_crl_fetch_age_seconds > 86400 ||
    !Number.isSafeInteger(p.min_crl_remaining_seconds) ||
    p.min_crl_remaining_seconds < 0 ||
    p.min_crl_remaining_seconds > 86400
  )
    reject();
  return p;
}

// Clock observations come from a trusted internal operator/session, never from
// the public receipt. They are retained diagnostics, NOT authenticated UTC proof.
export function clockCheckRecord(input, now = Date.now()) {
  exact(input, [
    "device",
    "source",
    "checked_at",
    "offset_milliseconds",
    "report_sha256",
  ]);
  if (
    !Number.isSafeInteger(now) ||
    !["COMPUTER_A", "COMPUTER_B"].includes(input.device) ||
    typeof input.source !== "string" ||
    !/^[A-Za-z0-9_.:/-]{1,160}$/.test(input.source) ||
    !Number.isSafeInteger(input.offset_milliseconds) ||
    Math.abs(input.offset_milliseconds) > 30000 ||
    utc(input.checked_at) > now ||
    now - utc(input.checked_at) > 300000
  )
    unavailable();
  hex(input.report_sha256, 32);
  return Object.freeze({
    ...JSON.parse(canonical(input)),
    classification: "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME",
  });
}
function nonce(text) {
  const match = /^Nonce: 0x([0-9a-fA-F]{1,64})$/m.exec(text);
  if (!match || BigInt("0x" + match[1]) === 0n) reject();
  return BigInt("0x" + match[1]);
}
function certificates(bundle, p, now) {
  if (typeof bundle !== "string" || bundle.length > 131072) reject();
  const blocks =
    bundle.match(
      /-----BEGIN (CERTIFICATE|X509 CRL)-----[\s\S]*?-----END \1-----/g,
    ) ?? [];
  if (
    bundle
      .replace(
        /-----BEGIN (CERTIFICATE|X509 CRL)-----[\s\S]*?-----END \1-----/g,
        "",
      )
      .trim()
  )
    reject();
  const roots = blocks.filter((b) => b.startsWith("-----BEGIN CERTIFICATE"));
  const crls = blocks.filter((b) => b.startsWith("-----BEGIN X509 CRL"));
  if (
    roots.length !== p.anchor_certificate_sha256.length ||
    crls.length !== p.crl_fetch_records.length
  )
    unavailable();
  const pins = roots.map((b) => {
    const c = new X509Certificate(b);
    if (
      !c.ca ||
      !c.checkIssued(c) ||
      !c.verify(c.publicKey) ||
      now < Date.parse(c.validFrom) ||
      now > Date.parse(c.validTo)
    )
      reject();
    return certPin(c);
  });
  if (
    new Set(pins).size !== pins.length ||
    pins.sort().join() !== [...p.anchor_certificate_sha256].sort().join()
  )
    reject();
  return crls;
}

/** Cryptographic check only: no publication, HTTP, DB, key or financial authority.
 * Caller supplies independently approved roots/pins. No token certificate is an anchor. */
export async function verifyRfc3161({
  query,
  reply,
  data,
  ca_bundle,
  policy,
  policy_oid,
  executable,
  now = Date.now(),
  clock_skew_seconds = 120,
  witness_lag_seconds = 900,
  observed_at,
  locked_at,
  clock_checks = [],
}) {
  if (
    !Number.isSafeInteger(now) ||
    !Buffer.isBuffer(query) ||
    !Buffer.isBuffer(reply) ||
    !Buffer.isBuffer(data) ||
    !query.length ||
    query.length > 65536 ||
    !reply.length ||
    reply.length > 262144 ||
    data.length > 65536 ||
    !Number.isSafeInteger(clock_skew_seconds) ||
    clock_skew_seconds < 0 ||
    clock_skew_seconds > 3600 ||
    !Number.isSafeInteger(witness_lag_seconds) ||
    witness_lag_seconds < 0 ||
    witness_lag_seconds > 86400
  )
    reject();
  // Own input bytes before any asynchronous subprocess.
  query = Buffer.from(query);
  reply = Buffer.from(reply);
  data = Buffer.from(data);
  const p = tsaProfile(policy),
    oid = numericOid(policy_oid),
    observed = utc(observed_at),
    locked = utc(locked_at),
    skew = clock_skew_seconds * 1000;
  if (
    !Array.isArray(clock_checks) ||
    (clock_checks.length !== 0 && clock_checks.length !== 2)
  )
    reject();
  const clock_records = clock_checks.map((c) => clockCheckRecord(c, now));
  if (
    clock_records.length &&
    (clock_records.length !== 2 ||
      new Set(clock_records.map((c) => c.device)).size !== 2)
  )
    reject();
  const signer = new X509Certificate(decode64(p.signer_certificate));
  if (
    now < Date.parse(signer.validFrom) ||
    now > Date.parse(signer.validTo) ||
    observed < locked ||
    observed > now + skew
  )
    reject();
  const crls = certificates(ca_bundle, p, now);
  const dir = await mkdtemp(join(tmpdir(), "darkpool-rfc3161-"));
  try {
    const f = Object.fromEntries(
      [
        "data",
        "query",
        "reply",
        "ca",
        "signer",
        "token",
        "content",
        "actual-signer",
      ].map((n) => [n, join(dir, n)]),
    );
    await Promise.all([
      writeFile(f.data, data),
      writeFile(f.query, query),
      writeFile(f.reply, reply),
      writeFile(f.ca, ca_bundle),
      writeFile(f.signer, signer.toString()),
    ]);
    for (const [i, crl] of crls.entries()) {
      const crlFile = join(dir, "crl-" + i);
      await writeFile(crlFile, crl);
      const der = Buffer.from(
        crl.replace(/-----[^\r\n]+-----|\s/g, ""),
        "base64",
      );
      const record = p.crl_fetch_records.find((r) => r.sha256 === sha256(der));
      if (
        !record ||
        utc(record.retrieved_at) > now ||
        now - utc(record.retrieved_at) > p.max_crl_fetch_age_seconds * 1000
      )
        unavailable();
      const checked = await opensslDetailed(executable, [
        "crl",
        "-in",
        crlFile,
        "-noout",
        "-verify",
        "-CAfile",
        f.ca,
      ]);
      if (checked.stderr.trim() !== "verify OK") reject();
      const dates = await openssl(executable, [
        "crl",
        "-in",
        crlFile,
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
        end <= now + p.min_crl_remaining_seconds * 1000
      )
        unavailable();
    }
    await openssl(executable, [
      "ts",
      "-reply",
      "-in",
      f.reply,
      "-token_out",
      "-out",
      f.token,
    ]);
    // Ignore token-provided signer discovery. Only the separately pinned leaf
    // can verify CMS, and its chain must terminate at the configured root set.
    await openssl(executable, [
      "cms",
      "-verify",
      "-inform",
      "DER",
      "-in",
      f.token,
      "-nointern",
      "-certfile",
      f.signer,
      "-CAfile",
      f.ca,
      "-CApath",
      dir,
      "-CAstore",
      f.ca,
      "-purpose",
      "timestampsign",
      "-crl_check_all",
      "-signer",
      f["actual-signer"],
      "-out",
      f.content,
    ]);
    const actual = new X509Certificate(await readFile(f["actual-signer"]));
    if (!actual.raw.equals(signer.raw)) reject();
    const content = await readFile(f.content);
    if (signedPolicyOid(content) !== oid) reject();
    const q = await openssl(executable, [
      "ts",
      "-query",
      "-in",
      f.query,
      "-text",
    ]);
    const t = await openssl(executable, [
      "ts",
      "-reply",
      "-in",
      f.token,
      "-token_in",
      "-text",
    ]);
    if (
      /^Hash Algorithm: (.+)$/m.exec(q)?.[1] !== "sha256" ||
      /^Hash Algorithm: (.+)$/m.exec(t)?.[1] !== "sha256" ||
      nonce(q) !== nonce(t)
    )
      reject();
    const common = [
      "-in",
      f.reply,
      "-CAfile",
      f.ca,
      "-CApath",
      dir,
      "-CAstore",
      f.ca,
      "-untrusted",
      f.signer,
      "-crl_check_all",
    ];
    await openssl(executable, [
      "ts",
      "-verify",
      "-queryfile",
      f.query,
      ...common,
    ]);
    await openssl(executable, ["ts", "-verify", "-data", f.data, ...common]);
    const timestamp = Date.parse(/^Time stamp: (.+)$/m.exec(t)?.[1]);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < locked ||
      timestamp < observed - skew ||
      timestamp > now + skew ||
      timestamp - observed > witness_lag_seconds * 1000 ||
      timestamp < Date.parse(signer.validFrom) ||
      timestamp > Date.parse(signer.validTo)
    )
      reject();
    return Object.freeze({
      timestamp_at: new Date(timestamp).toISOString(),
      policy_oid: oid,
      signer_certificate_sha256: certPin(signer),
      signer_spki_sha256: spkiPin(signer),
      query_sha256: sha256(query),
      reply_sha256: sha256(reply),
      data_sha256: sha256(data),
      clock_checks: clock_records,
      clock_assurance: clock_records.length
        ? "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME"
        : "UNAVAILABLE",
      financial_authorization: "NOT_GRANTED",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

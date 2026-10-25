import { createPublicKey, verify } from "node:crypto";
import {
  PROFILE,
  DOMAIN,
  sha256,
  reject,
  canonical,
  exact,
  hex,
  utc,
  envelopeBytes,
  decode64,
  trustProfile,
} from "./profile.mjs";

export { openssl } from "./openssl.mjs";
import { verifyRfc3161 } from "./rfc3161.mjs";
export function hasNonce(text) {
  const printed = /^Nonce: ([^\r\n]*)$/m.exec(text)?.[1];
  const value = /^0x([0-9A-Fa-f]{1,64})$/.exec(printed || "")?.[1];
  return Boolean(value && !/^0+$/.test(value));
}
/** Offline cryptographic verifier. External availability is an independent
 * witness assertion, not inferred from Git dates, HTTP success or a local flag. */
export async function verifyPublication(
  envelope,
  input,
  configuredTrust,
  executable,
  retrieve,
  now = Date.now(),
  runtimeEvidence = {},
) {
  try {
    const trust = trustProfile(configuredTrust);
    const recordClockAudit = runtimeEvidence.recordClockAudit;
    if (typeof retrieve !== "function")
      throw new Error("PUBLICATION_UNAVAILABLE");
    // Own every byte before awaiting a subprocess. A caller cannot change the
    // evidence or configured key between verification and persistence.
    exact(input, ["envelope", "statement", "signature", "tsq", "tsr"]);
    const evidence = JSON.parse(canonical(input));
    envelope = JSON.parse(canonical(envelope));
    const bytes = envelopeBytes(envelope),
      digest = sha256(bytes);
    if (!decode64(evidence.envelope, 65536).equals(bytes)) reject();
    const statement = evidence.statement;
    exact(statement, [
      "profile",
      "network",
      "market_id",
      "repository",
      "path",
      "commit",
      "git_blob_sha1",
      "content_sha256",
      "archive_url",
      "observed_at",
      "retention",
      "evidence_class",
    ]);
    if (
      statement.profile !== PROFILE ||
      statement.network !== "testnet" ||
      statement.market_id !== envelope.market_id ||
      statement.repository !== trust.repository ||
      statement.path !== trust.path ||
      statement.content_sha256 !== digest ||
      statement.evidence_class !== trust.evidence_class ||
      statement.retention !== "RETAINED_PUBLIC_AND_OFFLINE"
    )
      reject();
    hex(statement.commit, 20);
    hex(statement.git_blob_sha1, 20);
    const { createHash } = await import("node:crypto");
    const blob = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (
      statement.git_blob_sha1 !== blob ||
      typeof statement.archive_url !== "string" ||
      statement.archive_url.length > 2048 ||
      !statement.archive_url.startsWith(trust.archive_origin + "/") ||
      /[\u0000-\u0020\\]/.test(statement.archive_url)
    )
      reject();
    const archive = new URL(statement.archive_url);
    if (
      archive.origin !== trust.archive_origin ||
      archive.username ||
      archive.password ||
      archive.hash ||
      archive.search
    )
      reject();
    const observed = utc(statement.observed_at),
      locked = utc(envelope.locked_at);
    const skew = trust.max_clock_skew_seconds * 1000;
    if (
      !Number.isSafeInteger(now) ||
      observed < locked ||
      observed > now + skew
    )
      reject();
    const key = createPublicKey({
      key: decode64(trust.witness_spki),
      format: "der",
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.concat([DOMAIN, Buffer.from(canonical(statement), "utf8")]),
        key,
        decode64(evidence.signature, 64),
      )
    )
      reject();
    const signed = Buffer.from(
      canonical({ statement, signature: evidence.signature }),
      "utf8",
    );
    if (
      trust.evidence_class === "EXTERNAL" &&
      (!Array.isArray(runtimeEvidence.clock_checks) ||
        runtimeEvidence.clock_checks.length !== 2 ||
        typeof recordClockAudit !== "function")
    )
      throw new Error("PUBLICATION_UNAVAILABLE");
    const timestampProof = await verifyRfc3161({
      query: decode64(evidence.tsq, 65536),
      reply: decode64(evidence.tsr),
      data: signed,
      ca_bundle: trust.ca_bundle,
      policy: trust.tsa_verification,
      policy_oid: trust.tsa_policy_oid,
      executable,
      now,
      clock_skew_seconds: trust.max_clock_skew_seconds,
      witness_lag_seconds: trust.max_witness_lag_seconds,
      observed_at: statement.observed_at,
      locked_at: envelope.locked_at,
      clock_checks: runtimeEvidence.clock_checks ?? [],
    });
    const timestamp = Date.parse(timestampProof.timestamp_at);
    // Trusted anonymous-HTTPS adapter, independently configured from the receipt.
    // No implicit network, credentials or default successful retrieval exists.
    let timer;
    const abort = new AbortController();
    const copies = await Promise.race([
      Promise.resolve().then(() =>
        retrieve(
          Object.freeze({
            repository: statement.repository,
            commit: statement.commit,
            path: statement.path,
            archive_url: statement.archive_url,
          }),
          { signal: abort.signal },
        ),
      ),
      new Promise((_, fail) => {
        timer = setTimeout(() => {
          abort.abort();
          fail(new Error("PUBLICATION_UNAVAILABLE"));
        }, 5000);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      abort.abort();
    });
    if (!copies || copies.status === "UNAVAILABLE")
      throw new Error("PUBLICATION_UNAVAILABLE");
    exact(copies, [
      "repository",
      "commit",
      "path",
      "archive_url",
      "repository_bytes",
      "archive_bytes",
    ]);
    if (
      copies.repository !== statement.repository ||
      copies.commit !== statement.commit ||
      copies.path !== statement.path ||
      copies.archive_url !== statement.archive_url ||
      !decode64(copies.repository_bytes, 65536).equals(bytes) ||
      !decode64(copies.archive_bytes, 65536).equals(bytes)
    )
      reject();
    if (recordClockAudit) await recordClockAudit(timestampProof);
    const retained = { profile: PROFILE, evidence, trust };
    return Object.freeze({
      receipt_id: sha256(Buffer.from(canonical(retained))),
      market_id: envelope.market_id,
      merkle_root: envelope.merkle_root,
      content_sha256: digest,
      envelope_hex: bytes.toString("hex"),
      policy_ref: trust.policy_ref,
      trust_sha256: sha256(Buffer.from(canonical(trust))),
      evidence_class: trust.evidence_class,
      receipt_hex: Buffer.from(canonical(retained)).toString("hex"),
      timestamp_at: new Date(timestamp).toISOString(),
      receipt: retained,
    });
  } catch (error) {
    if (error.message === "PUBLICATION_UNAVAILABLE") throw error;
    reject();
  }
}

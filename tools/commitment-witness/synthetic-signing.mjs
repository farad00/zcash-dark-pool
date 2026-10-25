// One approved diagnostic record only. Never a publication receipt or READY trust.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  canonical,
  exact,
  sha256,
  decode64,
  envelopeBytes,
} from "../../services/publication/profile.mjs";
import { publicRequest } from "../../services/publication/http.mjs";
import { captureOnlyValid, settings, fail } from "./core.mjs";
import {
  requireSyntheticCaptureConfiguration,
  syntheticRecord,
  SYNTHETIC_SCOPE,
} from "./synthetic.mjs";

// Operator-confirmed original B capture configuration, NOT the bundled template.
// Raw file hash and normalized capture binding are different checks; neither is
// an OpenSSL binary/version hash. Never rewrite capture/config to satisfy them.
export const SIGNING_CONFIGURATION_FILE_SHA256 =
  "df3047845f92ecbee3c3ce031229cf34363a01bc64e604c7f863fa465111cf72";
export const SIGNING_CONFIGURATION_SHA256 =
  "ce055bbd67ba4fa20bfba2a34e3f2de55cdafb70551283b6ce3e4341fed91a73";
export const SIGNING_COMMIT = "90e83e50bcc9bdf54f1f2963d988be18a94262e4";
export const SYNTHETIC_ACK_PROFILE = "DARKPOOL_SYNTHETIC_WITNESS_ACK_V1";
const domain = Buffer.from("DARKPOOL_SYNTHETIC_WITNESS_ACK_V1\0", "ascii");

export function requireSyntheticSigningFile(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    sha256(bytes) !== SIGNING_CONFIGURATION_FILE_SHA256
  )
    fail();
}

export function syntheticSigningSettings(configuration, record) {
  const c = settings(configuration, false);
  requireSyntheticCaptureConfiguration(c);
  if (
    record !== syntheticRecord() ||
    sha256(Buffer.from(canonical(c))) !== SIGNING_CONFIGURATION_SHA256
  )
    fail();
  return c;
}
export function syntheticSigningCaptureValid(
  configuration,
  key,
  capture,
  record,
) {
  const c = syntheticSigningSettings(configuration, record);
  captureOnlyValid(c, key, capture);
  if (
    capture.request.commit !== SIGNING_COMMIT ||
    sha256(Buffer.from(capture.request.envelope.market_id)) !== record
  )
    fail();
  return c;
}
function statementFor(c, capture) {
  return {
    profile: SYNTHETIC_ACK_PROFILE,
    scope: SYNTHETIC_SCOPE,
    network: "testnet",
    market_id: capture.request.envelope.market_id,
    repository: c.destination.repository,
    repository_id: c.destination.repository_id,
    branch: c.destination.branch,
    path: c.destination.path,
    commit: capture.request.commit,
    git_blob_sha1: capture.git_blob_sha1,
    content_sha256: capture.request.content_sha256,
    archive_url: capture.archive_url,
    observed_at: capture.observed_at,
    witness_id: capture.witness_id,
    configuration_sha256: capture.trust_sha256,
    retention: "RETAINED_PUBLIC_AND_OFFLINE",
    evidence_class: "SYNTHETIC_TEST_ONLY",
    third_party_independence: "NO",
    financial_authorization: "NOT_GRANTED",
  };
}
export async function requireSyntheticArchive(
  configuration,
  key,
  capture,
  record,
  fetcher,
) {
  syntheticSigningCaptureValid(configuration, key, capture, record);
  const got = await publicRequest(fetcher, capture.archive_url);
  if (
    got.status !== 200 ||
    !got.bytes.equals(envelopeBytes(capture.request.envelope))
  )
    fail();
}
export async function acknowledgeSynthetic(
  configuration,
  key,
  capture,
  record,
  unprotect,
  { fetch: fetcher = globalThis.fetch, beforeSign } = {},
) {
  const c = syntheticSigningCaptureValid(configuration, key, capture, record);
  if (typeof beforeSign !== "function") fail();
  await requireSyntheticArchive(c, key, capture, record, fetcher);
  // Audit and recheck freshness after the public GET, before private-key access.
  await beforeSign();
  const statement = statementFor(c, capture);
  let password;
  try {
    password = await unprotect(decode64(key.protected_password, 4096));
    if (!Buffer.isBuffer(password) || password.length !== 32) fail();
    const privateKey = createPrivateKey({
      key: key.encrypted_pkcs8,
      format: "pem",
      passphrase: password,
    });
    if (
      createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .toString("base64") !== key.public_spki
    )
      fail();
    // DPAPI is another subprocess: do not sign if the clock aged out during it.
    await beforeSign();
    return {
      statement,
      signature: sign(
        null,
        Buffer.concat([domain, Buffer.from(canonical(statement))]),
        privateKey,
      ).toString("base64"),
    };
  } finally {
    if (Buffer.isBuffer(password)) password.fill(0);
  }
}
export function syntheticAcknowledgementValid(
  configuration,
  key,
  capture,
  record,
  ack,
) {
  const c = syntheticSigningCaptureValid(configuration, key, capture, record);
  exact(ack, ["statement", "signature"]);
  const expected = statementFor(c, capture);
  if (
    canonical(ack.statement) !== canonical(expected) ||
    !verify(
      null,
      Buffer.concat([domain, Buffer.from(canonical(expected))]),
      createPublicKey({
        key: decode64(key.public_spki),
        format: "der",
        type: "spki",
      }),
      decode64(ack.signature, 64),
    )
  )
    fail();
}

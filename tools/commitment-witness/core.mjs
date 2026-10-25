// Standalone public-data witness. No database, wallet, publisher credential or Git access.
import {
  generateKeyPairSync,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  PROFILE,
  DOMAIN,
  canonical,
  exact,
  hex,
  sha256,
  envelopeBytes,
  trustProfile,
  decode64,
  utc,
} from "../../services/publication/profile.mjs";
import {
  githubConfiguration,
  retrieveGitHubEnvelope,
  gitBlobSha1,
} from "../../services/publication/github.mjs";
import { githubJson, publicRequest } from "../../services/publication/http.mjs";
import { verifyGitHubPublication } from "../../services/publication/github-receipt.mjs";
import {
  requireSyntheticCaptureConfiguration,
  requireSyntheticEnvelope,
} from "./synthetic.mjs";
export const MODE = "COMMON_CONTROL_TECHNICAL_SEPARATION";
export const fail = () => {
  throw new Error("WITNESS_REJECTED");
};
export function settings(input, ready = true) {
  exact(input, [
    "version",
    "mode",
    "destination",
    "archive_origin",
    "archive_base_path",
    "openssl",
    "trust",
  ]);
  const c = JSON.parse(canonical(input));
  if (c.version !== 1 || c.mode !== MODE || typeof c.openssl !== "string")
    fail();
  c.destination = githubConfiguration(c.destination);
  if (ready) {
    c.trust = trustProfile(c.trust);
    if (
      !/^https:\/\/[A-Za-z0-9.-]+$/.test(c.archive_origin) ||
      !/^[a-z0-9_-]{1,80}$/.test(c.archive_base_path) ||
      c.trust.repository !== c.destination.repository ||
      c.trust.path !== c.destination.path ||
      c.trust.archive_origin !== c.archive_origin ||
      !c.trust.policy_ref.startsWith("common_control_") ||
      (c.trust.evidence_class === "SYNTHETIC_TEST" &&
        !process.env.NODE_TEST_CONTEXT)
    )
      fail();
  }
  return c;
}
// Capture is observation, not receipt authorization. All other callers retain settings().
export function captureSettings(configuration, request) {
  if (configuration?.trust?.status !== "UNAVAILABLE")
    return settings(configuration);
  const c = settings(configuration, false);
  requireSyntheticCaptureConfiguration(c);
  const r = requestCopy(request);
  requireSyntheticEnvelope(r.envelope);
  return c;
}
export async function newKey(protect) {
  const pair = generateKeyPairSync("ed25519"),
    password = randomBytes(32);
  try {
    const public_spki = pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const encrypted_pkcs8 = pair.privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: password,
    });
    const protected_password = Buffer.from(await protect(password)).toString(
      "base64",
    );
    return {
      version: 1,
      mode: MODE,
      public_spki,
      encrypted_pkcs8,
      protected_password,
    };
  } finally {
    password.fill(0);
  }
}
export function identity(key) {
  exact(key, [
    "version",
    "mode",
    "public_spki",
    "encrypted_pkcs8",
    "protected_password",
  ]);
  if (
    key.version !== 1 ||
    key.mode !== MODE ||
    typeof key.encrypted_pkcs8 !== "string" ||
    !key.encrypted_pkcs8.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----")
  )
    fail();
  const der = decode64(key.public_spki, 1024),
    pub = createPublicKey({ key: der, format: "der", type: "spki" });
  if (pub.asymmetricKeyType !== "ed25519") fail();
  decode64(key.protected_password, 4096);
  return sha256(der);
}
function requestCopy(request) {
  exact(request, ["commit", "content_sha256", "envelope"]);
  hex(request.commit, 20);
  hex(request.content_sha256, 32);
  if (sha256(envelopeBytes(request.envelope)) !== request.content_sha256)
    fail();
  return JSON.parse(canonical(request));
}
export function archiveUrl(c, witnessId, request) {
  return `${c.archive_origin}/${c.archive_base_path}/common-control/${witnessId}/${c.destination.repository_id}/${c.destination.branch}/${sha256(Buffer.from(request.envelope.market_id))}/${request.content_sha256}/envelope.json`;
}
export async function observe(
  configuration,
  key,
  request,
  { fetch: fetcher = globalThis.fetch, now } = {},
) {
  const c = captureSettings(configuration, request),
    r = requestCopy(request),
    witness_id = identity(key);
  if (c.trust.witness_spki !== key.public_spki) fail();
  const base =
    "https://api.github.com/repos/" + c.destination.repository.slice(19);
  const branch = await githubJson(
    fetcher,
    base + "/branches/" + c.destination.branch,
  );
  if (
    branch.status !== 200 ||
    branch.value?.name !== c.destination.branch ||
    branch.value.commit?.sha !== r.commit
  )
    fail();
  const got = await retrieveGitHubEnvelope(
    c.destination,
    {
      repository: c.destination.repository,
      path: c.destination.path,
      commit: r.commit,
    },
    { fetch: fetcher },
  );
  const after = await githubJson(
    fetcher,
    base + "/branches/" + c.destination.branch,
  );
  now = now === undefined ? Date.now() : now;
  if (
    after.status !== 200 ||
    after.value?.name !== c.destination.branch ||
    after.value.commit?.sha !== r.commit ||
    !Number.isSafeInteger(now) ||
    got.content_sha256 !== r.content_sha256 ||
    got.envelope_base64 !== envelopeBytes(r.envelope).toString("base64") ||
    now < utc(r.envelope.locked_at)
  )
    fail();
  return {
    version: 1,
    mode: MODE,
    request: r,
    witness_id,
    trust_sha256: sha256(Buffer.from(canonical(c))),
    observed_at: new Date(now).toISOString(),
    archive_url: archiveUrl(c, witness_id, r),
    git_blob_sha1: got.git_blob_sha1,
  };
}
export function captureValid(configuration, key, capture) {
  return validateCapture(settings(configuration), key, capture);
}
export function captureOnlyValid(configuration, key, capture) {
  return validateCapture(
    captureSettings(configuration, capture.request),
    key,
    capture,
  );
}
function validateCapture(c, key, capture) {
  const r = requestCopy(capture.request);
  exact(capture, [
    "version",
    "mode",
    "request",
    "witness_id",
    "trust_sha256",
    "observed_at",
    "archive_url",
    "git_blob_sha1",
  ]);
  if (
    capture.version !== 1 ||
    capture.mode !== MODE ||
    capture.witness_id !== identity(key) ||
    key.public_spki !== c.trust.witness_spki ||
    capture.trust_sha256 !== sha256(Buffer.from(canonical(c))) ||
    capture.archive_url !== archiveUrl(c, capture.witness_id, r) ||
    utc(capture.observed_at) < utc(r.envelope.locked_at)
  )
    fail();
  if (capture.git_blob_sha1 !== gitBlobSha1(envelopeBytes(r.envelope))) fail();
  return c;
}
export async function acknowledge(
  configuration,
  key,
  capture,
  unprotect,
  { fetch: fetcher = globalThis.fetch } = {},
) {
  const c = captureValid(configuration, key, capture),
    bytes = envelopeBytes(capture.request.envelope);
  // Never assert retained public availability until the hosted copy actually matches.
  const archive = await publicRequest(fetcher, capture.archive_url);
  if (archive.status !== 200 || !archive.bytes.equals(bytes)) fail();
  const statement = {
    profile: PROFILE,
    network: "testnet",
    market_id: capture.request.envelope.market_id,
    repository: c.destination.repository,
    path: c.destination.path,
    commit: capture.request.commit,
    git_blob_sha1: capture.git_blob_sha1,
    content_sha256: capture.request.content_sha256,
    archive_url: capture.archive_url,
    observed_at: capture.observed_at,
    retention: "RETAINED_PUBLIC_AND_OFFLINE",
    evidence_class: c.trust.evidence_class,
  };
  let password;
  try {
    password = Buffer.from(
      await unprotect(decode64(key.protected_password, 4096)),
    );
    if (password.length !== 32) fail();
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
    const signature = sign(
      null,
      Buffer.concat([DOMAIN, Buffer.from(canonical(statement))]),
      privateKey,
    ).toString("base64");
    return { statement, signature };
  } finally {
    password?.fill(0);
  }
}
export function acknowledgementValid(configuration, key, capture, ack) {
  const c = captureValid(configuration, key, capture);
  exact(ack, ["statement", "signature"]);
  const expected = {
    profile: PROFILE,
    network: "testnet",
    market_id: capture.request.envelope.market_id,
    repository: c.destination.repository,
    path: c.destination.path,
    commit: capture.request.commit,
    git_blob_sha1: capture.git_blob_sha1,
    content_sha256: capture.request.content_sha256,
    archive_url: capture.archive_url,
    observed_at: capture.observed_at,
    retention: "RETAINED_PUBLIC_AND_OFFLINE",
    evidence_class: c.trust.evidence_class,
  };
  if (
    canonical(ack.statement) !== canonical(expected) ||
    !verify(
      null,
      Buffer.concat([DOMAIN, Buffer.from(canonical(expected))]),
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
export async function submitTimestamp(
  query,
  { fetch: fetcher = globalThis.fetch } = {},
) {
  if (!Buffer.isBuffer(query) || !query.length || query.length > 65536) fail();
  const response = await fetcher("https://freetsa.org/tsr", {
    method: "POST",
    headers: {
      "Content-Type": "application/timestamp-query",
      Accept: "application/timestamp-reply",
      "Accept-Encoding": "identity",
    },
    body: query,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.url && response.url !== "https://freetsa.org/tsr") ||
    response.headers.get("content-type")?.split(";")[0].toLowerCase() !==
      "application/timestamp-reply" ||
    ![null, "identity"].includes(response.headers.get("content-encoding"))
  )
    fail();
  const chunks = [];
  let n = 0;
  for await (const chunk of response.body) {
    n += chunk.length;
    if (n > 262144) fail();
    chunks.push(chunk);
  }
  if (!n) fail();
  return Buffer.concat(chunks);
}
export async function checkBundle(
  configuration,
  capture,
  bundle,
  { fetch: fetcher = globalThis.fetch, clock_checks, recordClockAudit } = {},
) {
  const c = settings(configuration);
  const envelope = capture.request.envelope;
  const id = sha256(decode64(c.trust.witness_spki, 1024));
  if (
    bundle.statement?.archive_url !==
    archiveUrl(c, id, {
      envelope,
      content_sha256: sha256(envelopeBytes(envelope)),
    })
  )
    fail();
  return verifyGitHubPublication(envelope, bundle, {
    configuration: c.destination,
    trust: c.trust,
    executable: c.openssl,
    fetch: fetcher,
    clock_checks,
    recordClockAudit,
  });
}

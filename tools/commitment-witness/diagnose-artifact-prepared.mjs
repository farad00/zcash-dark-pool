// Offline, read-only diagnostic. No stdin, request generation, locks or submission.
import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const PINS = Object.freeze({
  manifest: "0c9aa51c8a7cd5adaa318f2ae27adaf9d7bdd0abaf294a89b670dacf7123cbb6",
  trust: "35d701381bc1c11445ef18af45df419b786a858bc0b31ab5f4bd28eb5a482b46",
  query: "0c3fe21ff95be95e97fc99e29437975cd222fcfbe5d179671fab1ef2b910f1bc",
  nonce: "bb9eb82f53b35470",
  ack: "cdcd869f517a516761607abe6000d72a54b406ca9915741a94bad84a70526c0a",
});
const CONFIG =
  "C:/ZcashWitness/80781d289a434100a100f5b24005c4e6/synthetic-witness.approved.json";
const TRUST =
  "C:/ZcashWitness/artifact-trust-review/58bf4a52ed094b0c9cf347865882c6c2/artifact-trust.freetsa.2026-10-24.json";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const deny = () => {
  throw Error("READ_ONLY_DIAGNOSTIC_FAILED");
};
const run = promisify(execFile);
export const STAGES = Object.freeze([
  "RUNTIME",
  "PACKAGE_INTEGRITY",
  "STORAGE_PERMISSIONS",
  "OPERATION_STATE",
  "ORIGINAL_EVIDENCE",
  "ARTIFACT_TRUST",
  "PREPARED_REQUEST",
  "GENERATION_MARKER",
  "PRESERVATION",
  "READ_ONLY_PREPARED_REQUEST",
  "DIAGNOSTIC_TIMEOUT",
  "DIAGNOSTIC_PROCESS",
]);
function stageCall(callback, value) {
  if (!STAGES.includes(value)) deny();
  callback(value);
}
async function absent(path, noLinks) {
  await noLinks(path);
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  deny();
}
async function snapshot(paths, noLinks) {
  const result = [];
  for (const path of paths) {
    await noLinks(path);
    const s = await lstat(path);
    if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > 1048576) deny();
    result.push([hash(await readFile(path)), s.size, s.mtimeMs]);
  }
  return JSON.stringify(result);
}

// Tests inject a read-only engine double; operational CLI always loads the pinned
// package and fixed original config/sidecar. No operational override or test mode.
export async function inspectPrepared({
  engine,
  canonical,
  labels,
  noLinks,
  now = Date.now(),
  stage = () => {},
}) {
  const set = (s) => stageCall(stage, s);
  set("OPERATION_STATE");
  const forbidden = [
    join(engine.root, "operation.lock"),
    join(engine.root, "artifact-timestamp.lock"),
    ...[
      "submission-attempt.json",
      "response.tsr",
      "artifact-evidence.json",
    ].map((name) => join(engine.directory, name)),
  ];
  for (const p of forbidden) await absent(p, noLinks);
  const markerPath = join(engine.directory, "request-generation-attempt.json");
  const immutable = [
    engine.configFile,
    engine.trustFile,
    ...[
      "request.tsq",
      "acknowledgement.bin",
      "preparation.json",
      "request-generation-attempt.json",
    ].map((n) => join(engine.directory, n)),
  ];
  const before = await snapshot(immutable, noLinks);
  set("ORIGINAL_EVIDENCE");
  const original = await engine.original(); // Retained signature/public identity; no decrypt/sign.
  set("ARTIFACT_TRUST");
  const trust = await engine.trust(); // Exact sidecar hash + frozen schema/pins.
  if (
    trust.status !== "ARTIFACT_ONLY_APPROVED" ||
    trust.financial_authorization !== "NOT_GRANTED"
  )
    deny();
  for (const r of trust.tsa_verification.crl_fetch_records) {
    const age = now - Date.parse(r.retrieved_at);
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > trust.tsa_verification.max_crl_fetch_age_seconds * 1000
    )
      deny();
  }
  set("PREPARED_REQUEST");
  const { binding } = await engine.prepared(original); // Frozen DER/nonce/imprint and plan checks.
  if (
    binding.query_sha256 !== PINS.query ||
    binding.nonce_hex !== PINS.nonce ||
    binding.acknowledgement_sha256 !== PINS.ack ||
    binding.policy_oid !== "1.2.3.4.1"
  )
    deny();
  if (
    hash(await readFile(join(engine.directory, "request.tsq"))) !== PINS.query
  )
    deny();
  set("GENERATION_MARKER");
  const markerBytes = await readFile(markerPath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(markerBytes);
  const marker = JSON.parse(text);
  if (
    text !== canonical(marker) ||
    canonical(marker) !==
      canonical({
        profile: "DARKPOOL_SYNTHETIC_ARTIFACT_TSA_V1",
        labels,
        acknowledgement_sha256: PINS.ack,
      })
  )
    deny();
  set("PRESERVATION");
  await engine.unchanged(original);
  if ((await snapshot(immutable, noLinks)) !== before) deny();
  for (const p of forbidden) await absent(p, noLinks);
  set("READ_ONLY_PREPARED_REQUEST");
  return { stage: "READ_ONLY_PREPARED_REQUEST", status: "PASS" };
}

async function cli(set) {
  set("RUNTIME");
  const v = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
    process.versions.node,
  );
  if (
    process.platform !== "win32" ||
    process.argv.length !== 3 ||
    !v ||
    Number(v[1]) !== 24 ||
    Number(v[2]) < 21 ||
    !process.env.LOCALAPPDATA ||
    !process.env.SystemRoot
  )
    deny();
  for (const k of [
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_PATH",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_TEST_CONTEXT",
    "DARKPOOL_SYNTHETIC_CAPTURE_TEST",
  ])
    if (process.env[k]) deny();
  globalThis.fetch = async () => {
    deny();
  }; // No diagnostic network operations.
  const packageRoot = resolve(process.argv[2]);
  set("PACKAGE_INTEGRITY");
  const manifest = await readFile(join(packageRoot, "SHA256SUMS.json"));
  if (hash(manifest) !== PINS.manifest) deny();
  const entries = Object.entries(
    JSON.parse(manifest.toString("utf8").replace(/^\uFEFF/, "")),
  );
  if (entries.length !== 34) deny();
  for (const [name, pin] of entries) {
    if (hash(await readFile(join(packageRoot, name))) !== pin.toLowerCase())
      deny();
  }
  const load = (p) => import(pathToFileURL(join(packageRoot, p)).href);
  const { ArtifactTimestamp } = await load(
    "tools/commitment-witness/artifact-timestamp.mjs",
  );
  const { canonical } = await load("services/publication/profile.mjs");
  const { noLinks } = await load("tools/commitment-witness/operational.mjs");
  const { ARTIFACT_LABELS: labels } = await load(
    "tools/commitment-witness/artifact-rfc3161.mjs",
  );
  set("STORAGE_PERMISSIONS");
  const ps = join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const options = {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 16384,
    env: {
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    },
  };
  const known = await run(
    ps,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
    ],
    options,
  );
  if (known.stderr || known.stdout.trim() !== process.env.LOCALAPPDATA) deny();
  const checked = await run(
    ps,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(packageRoot, "tools/commitment-witness/storage.ps1"),
      "-Action",
      "check",
    ],
    options,
  );
  if (checked.stderr || checked.stdout.trim() !== "WITNESS_STORAGE_OK") deny();
  const engine = new ArtifactTimestamp(
    join(process.env.LOCALAPPDATA, "ZcashDarkPoolCommitmentWitness"),
    CONFIG,
    { trustFile: TRUST, trustHash: PINS.trust, fetch: globalThis.fetch },
  );
  return inspectPrepared({ engine, canonical, labels, noLinks, stage: set });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let current = "RUNTIME",
    finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const code = result.status === "PASS" ? 0 : 1;
    process.stdout.write(JSON.stringify(result) + "\n", () =>
      process.exit(code),
    );
  };
  const timer = setTimeout(
    () => finish({ stage: "DIAGNOSTIC_TIMEOUT", status: "FAIL" }),
    30000,
  );
  cli((s) => {
    if (!STAGES.includes(s)) deny();
    current = s;
  }).then(finish, () => finish({ stage: current, status: "FAIL" }));
}

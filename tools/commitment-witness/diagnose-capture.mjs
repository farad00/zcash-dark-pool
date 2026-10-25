// Offline observation of public inputs and storage METADATA only. No capture or writes.
import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureSettings } from "./core.mjs";
import { loadClock, noLinks, publicJson } from "./operational.mjs";
import { sha256, utc } from "../../services/publication/profile.mjs";

// Match the repository engine range. Stable Node 24 only; no prereleases/coercion.
export const SUPPORTED_NODE_POLICY = ">=24.21.0 <25.0.0 (stable releases only)";
export function supportedNodeVersion(version) {
  if (typeof version !== "string" || version.length > 64) return false;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
    version,
  );
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    [major, minor, patch].every(Number.isSafeInteger) &&
    major === 24 &&
    minor >= 21
  );
}

export const DIAGNOSTIC_STAGES = Object.freeze([
  "BOOTSTRAP",
  "RUNTIME",
  "PUBLIC_INPUT_PATHS",
  "CONFIGURATION_JSON",
  "HANDOFF_JSON",
  "SYNTHETIC_BINDINGS",
  "PUBLIC_WITNESS_IDENTITY",
  "STORAGE_VALIDATION",
  "OPERATION_LOCK",
  "KEY_FILE_METADATA",
  "ARCHIVE_LAYOUT",
  "CLOCK_INTEGRITY",
  "CLOCK_FRESHNESS",
  "AUDIT_PATH",
  "RECORD_ABSENT",
  "READ_ONLY_CHECKS",
  "DIAGNOSTIC_PROCESS",
]);
const deny = () => {
  throw Error("DIAGNOSTIC_CHECK_FAILED");
};
const under = (p, root) => {
  const a = resolve(p).toLowerCase(),
    b = resolve(root).toLowerCase();
  return (
    a === b || a.startsWith(b + (process.platform === "win32" ? "\\" : "/"))
  );
};
async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  }
}
async function publicPath(path, root, local) {
  if (typeof path !== "string" || !path || path === "-") deny();
  await noLinks(resolve(path));
  const target = await realpath(path);
  for (const p of [resolve(path), target]) {
    if (
      under(p, root) ||
      under(p, join(local, "ZcashDarkPoolPublication")) ||
      basename(p).toLowerCase() === "witness-key.json"
    )
      deny();
  }
  const stat = await lstat(target);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 1048576
  )
    deny();
  return target;
}
async function json(path, limit) {
  const bytes = await readFile(path);
  if (bytes.length > limit) deny();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const run = promisify(execFile);
async function storageCheck(local, systemRoot) {
  const result = await run(
    join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./storage.ps1", import.meta.url)),
      "-Action",
      "check",
    ],
    {
      env: { SystemRoot: systemRoot, LOCALAPPDATA: local },
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 16384,
    },
  );
  if (result.stderr !== "" || result.stdout.trim() !== "WITNESS_STORAGE_OK")
    deny();
}
export async function diagnoseCapture({
  configFile,
  requestFile,
  clockDirectory,
  local = process.env.LOCALAPPDATA,
  systemRoot = process.env.SystemRoot,
  now = Date.now(),
  checkStorage = storageCheck,
} = {}) {
  let stage = "RUNTIME";
  try {
    if (
      process.platform !== "win32" ||
      !local ||
      !systemRoot ||
      !supportedNodeVersion(process.versions.node) ||
      !Number.isSafeInteger(now)
    )
      deny();
    const root = resolve(local, "ZcashDarkPoolCommitmentWitness");
    stage = "PUBLIC_INPUT_PATHS";
    const configPath = await publicPath(configFile, root, local);
    const requestPath = await publicPath(requestFile, root, local);
    stage = "CONFIGURATION_JSON";
    const c = await json(configPath, 131072);
    stage = "HANDOFF_JSON";
    const request = await json(requestPath, 16384);
    stage = "SYNTHETIC_BINDINGS";
    if (c.trust?.status !== "UNAVAILABLE") deny();
    captureSettings(c, request);
    stage = "PUBLIC_WITNESS_IDENTITY";
    const der = Buffer.from(c.trust.witness_spki, "base64");
    if (
      createPublicKey({ key: der, format: "der", type: "spki" })
        .asymmetricKeyType !== "ed25519" ||
      sha256(der) !==
        "4c2823572181e400eff4bfb70548a06f9d578e00d2d2175f1306564d5587558a"
    )
      deny();
    stage = "STORAGE_VALIDATION";
    await checkStorage(local, systemRoot);
    stage = "OPERATION_LOCK";
    await noLinks(root);
    if (!(await absent(join(root, "operation.lock")))) deny();
    stage = "KEY_FILE_METADATA";
    // Deliberately no read/open/JSON parse/hash of this file, encrypted or otherwise.
    const key = join(root, "keys/witness-key.json");
    await noLinks(key);
    const keyStat = await lstat(key);
    if (!keyStat.isFile() || keyStat.size < 1 || keyStat.size > 1048576) deny();
    stage = "ARCHIVE_LAYOUT";
    for (const name of ["keys", "archive", "exports"]) {
      const p = join(root, name);
      await noLinks(p);
      if (!(await lstat(p)).isDirectory()) deny();
    }
    stage = "CLOCK_INTEGRITY";
    if (
      typeof clockDirectory !== "string" ||
      !clockDirectory ||
      clockDirectory === "-"
    )
      deny();
    const clock = await publicJson(
      join(clockDirectory, "clock-check.json"),
      4096,
    );
    // Historical integrity check is distinct from permission to use the clock NOW.
    await loadClock(clockDirectory, "COMPUTER_B", utc(clock.checked_at));
    stage = "CLOCK_FRESHNESS";
    await loadClock(clockDirectory, "COMPUTER_B", now);
    stage = "AUDIT_PATH";
    const audit = join(root, "audit");
    await noLinks(audit);
    if (!(await absent(audit)) && !(await lstat(audit)).isDirectory()) deny();
    stage = "RECORD_ABSENT";
    if (
      !(await absent(
        join(root, "archive", sha256(Buffer.from(request.envelope.market_id))),
      ))
    )
      deny();
    return { stage: "READ_ONLY_CHECKS", status: "PASS" };
  } catch {
    return { stage, status: "FAIL" };
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let result = { stage: "BOOTSTRAP", status: "FAIL" };
  if (process.argv.length === 5)
    result = await diagnoseCapture({
      configFile: process.argv[2],
      requestFile: process.argv[3],
      clockDirectory: process.argv[4],
    });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.status === "PASS" ? 0 : 1;
}

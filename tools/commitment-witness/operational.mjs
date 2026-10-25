// Public diagnostic material only. No key, database or receipt-persistence access.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, lstat, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import {
  canonical,
  sha256,
  exact,
} from "../../services/publication/profile.mjs";
import { clockCheckRecord } from "../../services/publication/rfc3161.mjs";

export const CLOCK_SOURCE = "time.cloudflare.com";
export const CLOCK_ASSURANCE = "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME";
const fail = () => {
  throw new Error("WITNESS_OPERATIONAL_EVIDENCE_UNAVAILABLE");
};
export async function noLinks(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      if ((await lstat(p)).isSymbolicLink()) fail();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (dirname(p) === p) break;
  }
}
export async function durableWrite(path, bytes) {
  await noLinks(path);
  const h = await open(path, "wx", 0o600);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
}
export async function publicJson(path, limit = 1048576) {
  await noLinks(path);
  const s = await lstat(path);
  if (!s.isFile() || s.size < 1 || s.size > limit) fail();
  const b = await readFile(path);
  if (b.length > limit) fail();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
}
export function clockSamples(report) {
  if (typeof report !== "string" || Buffer.byteLength(report) > 16384) fail();
  const samples = [
    ...report.matchAll(/(?:^|\s)([+-])([0-9]+)[.,]([0-9]{1,9})s(?=\s|$)/gm),
  ].map(
    (m) =>
      (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number("0." + m[3])) * 1000,
  );
  if (
    samples.length < 2 ||
    samples.length > 3 ||
    samples.some((n) => !Number.isFinite(n) || Math.abs(n) > 30000)
  )
    fail();
  // Round away from zero: the reported worst offset must not understate a limit.
  const worst = samples.reduce((a, b) => (Math.abs(a) > Math.abs(b) ? a : b));
  return { samples, offset: Math.sign(worst) * Math.ceil(Math.abs(worst)) };
}
const nativeClock = async () => {
  if (process.platform !== "win32") fail();
  return promisify(execFile)(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "w32tm.exe"),
    [
      "/stripchart",
      "/computer:" + CLOCK_SOURCE,
      "/dataonly",
      "/samples:3",
      "/period:1",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 16384 },
  );
};
export async function captureClock(
  device,
  directory,
  { measure = nativeClock, now = Date.now } = {},
) {
  if (!["COMPUTER_A", "COMPUTER_B"].includes(device)) fail();
  await noLinks(directory);
  await mkdir(directory); // Never overwrite a prior observation, even after failure.
  const started_at = new Date(now()).toISOString();
  let result;
  try {
    result = await measure();
  } catch {
    await durableWrite(
      join(directory, "failure.json"),
      canonical({ status: "CLOCK_CHECK_FAILED", started_at }),
    );
    fail();
  }
  if (typeof result.stdout !== "string" || (result.stderr ?? "") !== "") fail();
  const raw = Buffer.from(result.stdout, "utf8");
  await durableWrite(join(directory, "clock-raw.txt"), raw);
  const { samples, offset } = clockSamples(result.stdout);
  const record = {
    device,
    source: CLOCK_SOURCE,
    checked_at: new Date(now()).toISOString(),
    offset_milliseconds: offset,
    report_sha256: sha256(raw),
  };
  clockCheckRecord(record, now());
  await durableWrite(join(directory, "clock-check.json"), canonical(record));
  // Fractional sample values stay in the original report; canonical JSON uses integers.
  await durableWrite(
    join(directory, "context.json"),
    canonical({
      scope: "PUBLIC_CLOCK_DIAGNOSTIC_ONLY",
      assurance: CLOCK_ASSURANCE,
      started_at,
      sample_count: samples.length,
      financial_authorization: "NOT_GRANTED",
    }),
  );
  return record;
}
export async function loadClock(directory, device, now = Date.now()) {
  const record = await publicJson(join(directory, "clock-check.json"), 4096);
  clockCheckRecord(record, now);
  if (record.device !== device || record.source !== CLOCK_SOURCE) fail();
  const p = join(directory, "clock-raw.txt");
  await noLinks(p);
  const s = await lstat(p);
  if (!s.isFile() || s.size > 16384 || s.size < 1) fail();
  const raw = await readFile(p);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (
    sha256(raw) !== record.report_sha256 ||
    clockSamples(text).offset !== record.offset_milliseconds
  )
    fail();
  return record;
}
export async function clockPair(aDirectory, bDirectory, now = Date.now()) {
  if (resolve(aDirectory) === resolve(bDirectory)) fail();
  return Promise.all([
    loadClock(aDirectory, "COMPUTER_A", now),
    loadClock(bDirectory, "COMPUTER_B", now),
  ]);
}
export async function durableAudit(directory, event) {
  await noLinks(directory);
  try {
    await mkdir(directory);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  if (!(await lstat(directory)).isDirectory()) fail();
  const bytes = Buffer.from(canonical(event));
  const path = join(directory, sha256(bytes) + ".json");
  try {
    await durableWrite(path, bytes);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!(await readFile(path)).equals(bytes)) fail();
  }
  return sha256(bytes);
}
export function operationalEvidence(aDirectory, bDirectory, auditDirectory) {
  return {
    async before(action, record, configuration_sha256) {
      const clock = await loadClock(bDirectory, "COMPUTER_B");
      await durableAudit(auditDirectory, {
        version: 1,
        action,
        record,
        configuration_sha256,
        checked_at: new Date().toISOString(),
        clock,
        assurance: CLOCK_ASSURANCE,
        financial_authorization: "NOT_GRANTED",
      });
    },
    async verification() {
      return {
        clock_checks: await clockPair(aDirectory, bDirectory),
        recordClockAudit: async (proof) => {
          // Frozen verifier emits only hashes, pins, timing and clock diagnostics.
          exact(proof, [
            "timestamp_at",
            "policy_oid",
            "signer_certificate_sha256",
            "signer_spki_sha256",
            "query_sha256",
            "reply_sha256",
            "data_sha256",
            "clock_checks",
            "clock_assurance",
            "financial_authorization",
          ]);
          if (proof.financial_authorization !== "NOT_GRANTED") fail();
          await durableAudit(auditDirectory, {
            version: 1,
            action: "CRYPTOGRAPHIC_VERIFICATION",
            proof,
            verified_at: new Date().toISOString(),
            financial_authorization: "NOT_GRANTED",
          });
        },
      };
    },
  };
}

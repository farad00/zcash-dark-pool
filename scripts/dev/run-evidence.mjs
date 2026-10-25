// Evidence capture only: process supervision remains in run-bounded.mjs.
// The caller must supply a fresh directory under an already protected parent.
// Raw child output stays there; console/status metadata never contains it.
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, boundedExit } from "./run-bounded.mjs";
import {
  assertEvidenceTarget,
  assertLiveInvocation,
  assertChildTarget,
} from "../../db/target-registry.mjs";

export async function runEvidence(
  executable,
  args,
  {
    stage,
    directory,
    timeoutMs,
    env,
    input,
    maxBytes = 1048576,
    validate,
  } = {},
) {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(stage || "") ||
    typeof directory !== "string" ||
    !directory ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1048576 ||
    (validate !== undefined && typeof validate !== "function")
  )
    throw Error("Invalid evidence configuration");
  // Exclusive creation prevents accidental replay/overwriting retained evidence.
  const deployment =
    process.env.DARKPOOL_PG_ENV === "LIVE_EVIDENCE"
      ? process.env
      : (env ?? process.env);
  assertChildTarget(deployment, env);
  await assertEvidenceTarget(directory, deployment);
  assertLiveInvocation(executable, args, deployment);
  await mkdir(directory);
  const files = [];
  try {
    for (const name of ["stdout.txt", "stderr.txt", "result.json"])
      files.push(await open(join(directory, name), "wx", 0o600));
    const native = await runBounded(executable, args, {
      timeoutMs,
      env,
      input,
      maxBytes,
    });
    // native is frozen by the authoritative runner. Do not infer exit from text.
    const nativeStatus = boundedExit(native);
    let validation = validate === undefined ? "NOT_REQUIRED" : "NOT_RUN";
    if (nativeStatus === 0 && validate !== undefined) {
      try {
        // Validators are synchronous and must explicitly accept the evidence.
        validation = validate(native) === true ? "PASS" : "FAIL";
      } catch {
        validation = "FAIL"; // Never serialize validator exceptions or payloads.
      }
    }
    const record = Object.freeze({
      stage,
      parentPid: process.pid,
      pid: native.pid,
      start: native.start,
      end: native.end,
      code: native.code,
      signal: native.signal,
      exitObserved: native.exitObserved,
      timedOut: native.timedOut,
      overflow: native.overflow,
      spawnFailed: native.spawnFailed,
      drainExpired: native.drainExpired,
      allowInheritedOutputAfterExit: native.allowInheritedOutputAfterExit,
      stdoutBytes: Buffer.byteLength(native.stdout),
      stderrBytes: Buffer.byteLength(native.stderr),
      validation,
      exit: nativeStatus || (validation === "FAIL" ? 1 : 0),
    });
    await files[0].writeFile(native.stdout);
    await files[1].writeFile(native.stderr);
    await files[2].writeFile(JSON.stringify(record, null, 2) + "\n");
    return record;
  } finally {
    await Promise.all(files.map((file) => file.close()));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [stage, ms, directory, ...command] = process.argv.slice(2);
    const jsonObject = command[0] === "--json-object";
    if (jsonObject) command.shift();
    const [executable, ...args] = command;
    if (!executable) throw Error("Missing evidence command");
    const result = await runEvidence(executable, args, {
      stage,
      directory,
      timeoutMs: Number(ms),
      validate: jsonObject
        ? ({ stdout }) => {
            const value = JSON.parse(stdout);
            return (
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            );
          }
        : undefined,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exit;
  } catch {
    console.log("EVIDENCE_CAPTURE_FAILED");
    process.exitCode = 1;
  }
}

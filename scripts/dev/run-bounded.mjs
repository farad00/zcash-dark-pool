// Initializer process boundary. Never kills a process tree: a new server may
// legitimately survive a failed pg_ctl invocation and must remain inspectable.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runBounded(
  executable,
  args,
  {
    timeoutMs,
    env = process.env,
    input,
    onStart = () => {},
    onStdout = () => {},
    onStderr = () => {},
    maxBytes = 1048576,
    allowInheritedOutputAfterExit = false,
  } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 180000)
    throw new Error("Invalid initializer timeout");
  if (typeof allowInheritedOutputAfterExit !== "boolean")
    throw new Error("Invalid initializer output policy");
  return new Promise((resolveResult) => {
    const start = new Date().toISOString();
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      overflow = false,
      spawnFailed = false,
      drainExpired = false,
      done = false,
      drainTimer,
      exitRecord;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin?.destroy();
      child.unref();
      // Capture the native exit once; pipe close/cleanup cannot replace it.
      const native = exitRecord ?? { code, signal };
      resolveResult(
        Object.freeze({
          pid: child.pid ?? null,
          start,
          end: new Date().toISOString(),
          code: native.code,
          signal: native.signal,
          exitObserved: exitRecord !== undefined,
          allowInheritedOutputAfterExit,
          timedOut,
          overflow,
          spawnFailed,
          drainExpired,
          stdout,
          stderr,
        }),
      );
    };
    const stop = () => {
      child.kill();
      // A descendant retaining a pipe must not extend the stage indefinitely.
      drainTimer ??= setTimeout(() => {
        drainExpired = true;
        finish(
          exitRecord?.code ?? child.exitCode,
          exitRecord?.signal ?? child.signalCode,
        );
      }, 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.on("spawn", () => onStart(child.pid));
    child.stdout.on("data", (bytes) => {
      if (Buffer.byteLength(stdout) + bytes.length > maxBytes) {
        overflow = true;
        stop();
      } else {
        stdout += bytes;
        onStdout(bytes);
      }
    });
    child.stderr.on("data", (bytes) => {
      if (Buffer.byteLength(stderr) + bytes.length > maxBytes) {
        overflow = true;
        stop();
      } else {
        stderr += bytes;
        onStderr(bytes);
      }
    });
    child.on("error", () => {
      spawnFailed = true;
      finish(null, null);
    });
    child.once("exit", (code, signal) => {
      if (done) return;
      exitRecord = Object.freeze({ code, signal });
      // The command has completed. Drain has its own finite deadline; an inherited
      // daemon pipe cannot turn an on-time native completion into a timeout.
      clearTimeout(timer);
      drainTimer ??= setTimeout(() => {
        drainExpired = true;
        finish(code, signal);
      }, 1000);
    });
    child.on("close", finish);
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}
export function boundedExit(result) {
  if (
    !result ||
    typeof result !== "object" ||
    ![
      "timedOut",
      "spawnFailed",
      "overflow",
      "drainExpired",
      "exitObserved",
      "allowInheritedOutputAfterExit",
    ].every((key) => typeof result[key] === "boolean") ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    !(
      result.code === null ||
      (Number.isSafeInteger(result.code) && result.code >= 0)
    ) ||
    !(result.signal === null || typeof result.signal === "string")
  )
    return 1;
  if (result.timedOut) return 124;
  if (
    result.spawnFailed ||
    result.overflow ||
    !result.exitObserved ||
    result.signal !== null
  )
    return 1;
  if (result.drainExpired && !result.allowInheritedOutputAfterExit) return 1;
  return result.code === 0 ? 0 : result.code || 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [stage, ms, ...command] = process.argv.slice(2);
  const allowInheritedOutputAfterExit =
    command[0] === "--allow-inherited-output-after-exit";
  if (allowInheritedOutputAfterExit) command.shift();
  const [executable, ...args] = command;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage || "") || !executable)
    throw Error("Invalid initializer stage");
  console.log(`STAGE ${stage} START ${new Date().toISOString()}`);
  const result = await runBounded(executable, args, {
    timeoutMs: Number(ms),
    allowInheritedOutputAfterExit,
    onStart: (pid) => console.log(`STAGE ${stage} PID ${pid}`),
    onStdout: (bytes) => process.stdout.write(bytes),
    onStderr: (bytes) => process.stderr.write(bytes),
  });
  console.log(
    `STAGE ${stage} END ${result.end} EXIT ${boundedExit(result)} TIMEOUT ${result.timedOut} NATIVE_EXIT ${result.code} SIGNAL ${result.signal} EXIT_OBSERVED ${result.exitObserved} DRAIN_EXPIRED ${result.drainExpired} INHERITED_OUTPUT ${result.allowInheritedOutputAfterExit} OVERFLOW ${result.overflow} SPAWN_FAILED ${result.spawnFailed}`,
  );
  process.exitCode = boundedExit(result);
}

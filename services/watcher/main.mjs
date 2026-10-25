import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWatcherDb } from "./db.mjs";
import {
  proposedTarget,
  nativeEnvironment,
} from "../genuine-deposit/target.mjs";
import {
  assertWalletTarget,
  assertEvidenceTarget,
} from "../../db/target-registry.mjs";
import {
  safeDiagnostic,
  safeProgress,
  protectedDiagnosticFile,
} from "./diagnostics.mjs";

export const MAX_FRAME = 4194304;
// Fixed hackathon/testnet bound for the long maintained sync request.
const SYNC_DEADLINE_MS = 1_800_000;
export const identity = (o) => `${o.txid}:${o.pool}:${o.output_index}`;
export function encodeFrame(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > MAX_FRAME)
    throw new Error("WATCHER_UNAVAILABLE");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
export function walletEnvironment(env) {
  try {
    assertWalletTarget(env);
    if (env.DARKPOOL_PG_ENV === "TESTNET_OBSERVATION") {
      const expected = nativeEnvironment(proposedTarget(), "scan");
      for (const [key, value] of Object.entries(expected))
        if (env[key] !== value) throw Error();
      if (
        env.DARKPOOL_LIVE_INSTANCE !== undefined ||
        env.DARKPOOL_TEST_ONLY !== undefined
      )
        throw Error();
    }
  } catch {
    throw new Error("WATCHER_UNAVAILABLE");
  }
  if (
    env.ZCASH_NETWORK !== "testnet" ||
    !env.WALLET_DB_PATH ||
    !/^https:\/\//.test(env.CHAIN_ENDPOINT ?? "")
  )
    throw new Error("WATCHER_UNAVAILABLE");
  const endpoint = new URL(env.CHAIN_ENDPOINT);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("WATCHER_UNAVAILABLE");
  const clean = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "ZCASH_NETWORK",
    "WALLET_DB_PATH",
    "CHAIN_ENDPOINT",
    "DARKPOOL_WATCHER_RESCAN_REVIEW",
    "DARKPOOL_PG_ENV",
    "DARKPOOL_LIVE_INSTANCE",
    "DARKPOOL_TEST_ONLY",
    "LOCALAPPDATA",
    "DARKPOOL_OBSERVATION_INSTANCE",
    "FINANCIAL_AUTHORIZATION",
  ])
    if (env[key] !== undefined) clean[key] = env[key];
  return clean;
}
export function createWalletProcess(env = process.env, diagnosticFile) {
  const clean = walletEnvironment(env);
  if (diagnosticFile) clean.DARKPOOL_WATCHER_DIAGNOSTIC_IPC = "1";
  const child = spawn(
    env.WATCHER_EXECUTABLE ||
      resolve(
        `target/debug/darkpool-zcash${process.platform === "win32" ? ".exe" : ""}`,
      ),
    ["serve-watcher"],
    {
      env: clean,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return framedWalletProcess(child, diagnosticFile);
}
// Transport seam allows actual OS child lifecycle tests without a live wallet.
// Production deadlines are 10s/30min; tests can advance the injected timer.
export function framedWalletProcess(
  child,
  diagnosticFile,
  timers = globalThis,
) {
  let pending,
    buffer = Buffer.alloc(0),
    closed = false,
    failure,
    validFrame = false,
    validFailure = false,
    nodeTimeout = false,
    nodeKilled = false,
    shutdownRequested = false,
    diagnosticWrite = Promise.resolve();
  let progressPending,
    lastProgress,
    receivedAt,
    progressWrite = Promise.resolve(),
    progressWriting = false;
  const queueProgress = (value) => {
    progressPending = safeProgress(value);
    if (progressWriting) return;
    progressWriting = true;
    progressWrite = (async () => {
      try {
        while (progressPending) {
          const record = progressPending;
          progressPending = undefined;
          await diagnosticFile.progress(record);
        }
      } catch {
        progressPending = undefined;
      } finally {
        // Optional updates preserve the existing failure contract.
        progressWriting = false;
      }
    })();
  };
  let finishClose;
  const ended = new Promise((done) => {
    finishClose = done;
  });
  const kill = () => {
    nodeKilled = child.kill() || nodeKilled;
  };
  const fail = (classification) => {
    if (!failure || classification === "IPC_FRAME")
      failure = { class: classification, stage: "IPC" };
    kill();
  };
  child.stderr.on("data", () => {}); // Never forward or store library diagnostics.
  child.stdin.on("error", () => fail("IPC_ERROR"));
  child.on("error", () => {
    failure ??= { class: "CHILD_EXIT", stage: "IPC" };
  });
  child.on("close", (code, signal) => {
    closed = true;
    if (lastProgress) {
      const age = Math.max(0, Math.floor(performance.now() - receivedAt));
      queueProgress({
        ...lastProgress,
        elapsed_ms: Math.min(4294967295, lastProgress.elapsed_ms + age),
        last_progress_age_ms: Math.min(
          4294967295,
          lastProgress.last_progress_age_ms + age,
        ),
      });
    }
    if (pending || failure || !shutdownRequested) {
      failure ??= {
        class: buffer.length
          ? "IPC_FRAME"
          : signal
            ? "CHILD_SIGNAL"
            : "CHILD_EXIT",
        stage: "IPC",
      };
      const evidence = safeDiagnostic({
        ...failure,
        exit_code: code,
        signal,
        node_timeout: nodeTimeout,
        node_killed: nodeKilled,
        valid_response_frame: validFrame,
        valid_failure_frame: validFailure,
      });
      diagnosticWrite = diagnosticFile
        ? Promise.resolve().then(() => diagnosticFile.write(evidence))
        : Promise.resolve();
      // Handle immediately, then surface write failures through close() as a fixed error.
      diagnosticWrite.catch(() => {});
    }
    if (pending) {
      timers.clearTimeout(pending.timer);
      pending.reject(new Error("WATCHER_UNAVAILABLE"));
      pending = undefined;
    }
    finishClose();
  });
  child.stdout.on("data", (chunk) => {
    if (failure) {
      if (validFailure) fail("IPC_FRAME");
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE();
      if (!length || length > MAX_FRAME) {
        fail("IPC_FRAME");
        return;
      }
      if (buffer.length < length + 4) return;
      if (!pending) {
        fail("IPC_FRAME");
        return;
      }
      try {
        const value = JSON.parse(buffer.subarray(4, length + 4));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        if (Object.hasOwn(value, "error") && value.error !== true)
          throw new Error();
        buffer =
          buffer.length === length + 4
            ? Buffer.alloc(0)
            : buffer.subarray(length + 4);
        if (Object.hasOwn(value, "progress")) {
          if (
            Object.keys(value).length !== 1 ||
            pending.operation !== "sync" ||
            !diagnosticFile?.progress ||
            !value.progress ||
            typeof value.progress !== "object" ||
            Array.isArray(value.progress)
          )
            throw new Error();
          lastProgress = safeProgress(value.progress);
          receivedAt = performance.now();
          queueProgress(lastProgress);
          continue;
        }
        if (buffer.length) throw new Error();
        validFrame = true;
        if (value.error === true) {
          validFailure = true;
          failure = safeDiagnostic(value.diagnostic);
          // Keep the original request timer until natural child close. Do not kill
          // a valid Rust failure frame before its Windows exit status is captured.
          return;
        }
        const p = pending;
        pending = undefined;
        timers.clearTimeout(p.timer);
        p.resolve(value);
      } catch {
        fail("IPC_FRAME");
        return;
      }
    }
  });
  return {
    request: (operation, context, rescanHeight) =>
      new Promise((resolveResult, reject) => {
        if (closed || pending) {
          reject(new Error("WATCHER_UNAVAILABLE"));
          return;
        }
        validFrame = false;
        validFailure = false;
        const timer = timers.setTimeout(
          () => {
            nodeTimeout = true;
            failure = {
              ...failure,
              class: "NODE_TIMEOUT",
              stage: failure?.stage ?? "IPC",
            };
            kill();
          },
          operation === "observe" ? 10000 : SYNC_DEADLINE_MS,
        );
        pending = { resolve: resolveResult, reject, timer, operation };
        try {
          child.stdin.write(
            encodeFrame({ operation, context, rescan_height: rescanHeight }),
          );
        } catch {
          fail("IPC_ERROR");
        }
      }),
    close: async () => {
      shutdownRequested = true;
      if (!closed) kill();
      await ended;
      try {
        await diagnosticWrite;
        await progressWrite;
      } catch {
        throw new Error("WATCHER_UNAVAILABLE");
      }
    },
  };
}
const requestBase = (c, mode) => ({
  version: 1,
  request_id: randomBytes(32).toString("hex"),
  mode,
  network: "testnet",
  market_id: c.market_id,
  vault_context_ref: c.vault_context_ref,
  account_ref: c.account_ref,
  endpoint_ref: c.endpoint_ref,
});

export function canonicalContradiction(context, snapshot) {
  const current = new Map(snapshot.outputs.map((o) => [identity(o), o]));
  return context.receipts.some((r) => {
    if (!r.accepted) return false;
    const o = current.get(identity(r));
    return (
      !o ||
      !o.canonical ||
      !o.present ||
      o.block_hash !== r.block_hash ||
      o.block_height !== r.block_height ||
      o.block_time !== r.block_time ||
      o.tx_index !== r.tx_index ||
      [
        "amount_zat",
        "receiver_ref",
        "ticket_id",
        "diversifier_ref",
        "journal_commitment",
      ].some((key) => o[key] !== r[key]) ||
      snapshot.chain.tip_height < r.block_height + 2 ||
      !o.receiver_verified ||
      o.key_scope !== 0 ||
      o.is_change
    );
  });
}
async function writeStop(path, reason) {
  const data = JSON.stringify({ version: 1, reason });
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error("WATCHER_UNAVAILABLE");
  }
}
export function createCoordinator({
  db,
  wallet,
  stopFile,
  reviewRescanHeight,
}) {
  if (!stopFile) throw new Error("WATCHER_UNAVAILABLE");
  if (
    reviewRescanHeight !== undefined &&
    (!Number.isInteger(reviewRescanHeight) ||
      reviewRescanHeight < 11 ||
      reviewRescanHeight > 4294967295)
  )
    throw new Error("WATCHER_UNAVAILABLE");
  return {
    async cycle() {
      let context = await db.context();
      let stop;
      try {
        stop = JSON.parse(await readFile(stopFile, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error("WATCHER_UNAVAILABLE");
      }
      if (stop) {
        if (
          stop.version !== 1 ||
          ![
            "CANONICAL_CONTRADICTION",
            "MAPPING_CONFLICT",
            "RESTORE_REVIEW",
            "ANCHOR_CONFLICT",
          ].includes(stop.reason)
        )
          throw new Error("WATCHER_UNAVAILABLE");
        const held = await db.reconcile(context.revision, {
          ...requestBase(context, "safety_stop"),
          reason: stop.reason,
        });
        if (held.result !== "HELD") throw new Error("WATCHER_UNAVAILABLE");
        await unlink(stopFile);
        context = await db.context();
      }
      // This acknowledgement must precede every potentially destructive sync.
      const before = await wallet.request("observe", context);
      if (!Array.isArray(before.outputs))
        throw new Error("WATCHER_UNAVAILABLE");
      const retained = new Set(
        [...context.receipts, ...(context.unmapped ?? [])].map(identity),
      );
      const unretained = before.outputs.filter(
        (o) => !retained.has(identity(o)),
      );
      if (unretained.length) {
        await db.reconcile(context.revision, {
          ...requestBase(context, "observe_only"),
          outputs: unretained,
        });
        context = await db.context();
      }
      const snapshot = await wallet.request(
        "sync",
        context,
        reviewRescanHeight,
      );
      reviewRescanHeight = undefined; // Explicit maintenance operation runs once.
      if (snapshot.stop_reason) {
        await writeStop(stopFile, snapshot.stop_reason);
        const result = await db.reconcile(context.revision, {
          ...requestBase(context, "safety_stop"),
          reason: snapshot.stop_reason,
        });
        await unlink(stopFile);
        return result;
      }
      if (/^[0-9]{1,10}$/.test(snapshot.chain?.verified_at_epoch ?? ""))
        snapshot.chain.verified_at = new Date(
          Number(snapshot.chain.verified_at_epoch) * 1000,
        ).toISOString();
      const verified = Date.parse(snapshot.chain?.verified_at);
      if (
        !Array.isArray(snapshot.outputs) ||
        !snapshot.chain?.complete ||
        !snapshot.chain.verified ||
        !Number.isFinite(verified) ||
        Date.now() - verified > 30000 ||
        verified - Date.now() > 5000
      )
        throw new Error("WATCHER_UNAVAILABLE");
      const contradiction = canonicalContradiction(context, snapshot);
      if (contradiction) await writeStop(stopFile, "CANONICAL_CONTRADICTION");
      // Keep the same request object for an ambiguous-commit retry.
      const request = { ...requestBase(context, "snapshot"), ...snapshot };
      let result;
      try {
        result = await db.reconcile(context.revision, request);
      } catch {
        result = await db.reconcile(context.revision, request);
      }
      if (contradiction && result.result === "HELD") await unlink(stopFile);
      return result;
    },
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let wallet, diagnosticFile;
  try {
    if (process.env.WATCHER_STOP_PATH)
      await assertEvidenceTarget(process.env.WATCHER_STOP_PATH, process.env);
    const db = createWatcherDb();
    await db.context(); // Check restricted DB capability before touching a wallet.
    diagnosticFile = await protectedDiagnosticFile();
    wallet = createWalletProcess(process.env, diagnosticFile);
    const rescanFlag = process.argv.find((arg) =>
      arg.startsWith("--review-rescan-height="),
    );
    if (
      rescanFlag &&
      (process.env.DARKPOOL_WATCHER_RESCAN_REVIEW !== "1" ||
        !process.argv.includes("--once") ||
        !/^[0-9]{1,10}$/.test(rescanFlag.split("=")[1]))
    )
      throw new Error("WATCHER_UNAVAILABLE");
    const coordinator = createCoordinator({
      db,
      wallet,
      stopFile: process.env.WATCHER_STOP_PATH,
      reviewRescanHeight: rescanFlag
        ? Number(rescanFlag.split("=")[1])
        : undefined,
    });
    const once = process.argv.includes("--once");
    do {
      const result = await coordinator.cycle();
      process.stdout.write(
        result.result === "HELD"
          ? "Watcher safety stop active\n"
          : "Watcher reconciliation completed\n",
      );
      if (!once) await new Promise((done) => setTimeout(done, 10000));
    } while (!once);
  } catch {
    process.stderr.write("Private testnet watcher unavailable\n");
    process.exitCode = 1;
  } finally {
    try {
      await wallet?.close();
      await diagnosticFile?.close();
    } catch {
      process.stderr.write("Private testnet watcher unavailable\n");
      process.exitCode = 1;
    }
  }
}

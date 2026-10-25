import { execFile } from "node:child_process";
import { open, realpath, lstat, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  configuredTarget,
  assertEvidenceTarget,
} from "../../db/target-registry.mjs";

const classes = new Set([
  "TLS_CONNECT",
  "RPC_CONNECT",
  "RPC_TIMEOUT",
  "RPC_STATUS",
  "RPC_STREAM",
  "RPC_DECODE",
  "RPC_MESSAGE_LIMIT",
  "TREE_STATE",
  "CHAIN_VALIDATION",
  "CACHE_LIMIT",
  "HISTORY_LIMIT",
  "CACHE_ERROR",
  "SCAN_ERROR",
  "SQLITE_BUSY",
  "SQLITE_ERROR",
  "CHECKPOINT_ERROR",
  "INCOMPLETE_SYNC",
  "IPC_FRAME",
  "IPC_ERROR",
  "CHILD_EXIT",
  "CHILD_SIGNAL",
  "NODE_TIMEOUT",
  "UNKNOWN",
]);
const stages = new Set([
  "START",
  "TLS_CONNECT",
  "RPC_CONNECT",
  "TREE_STATE",
  "BLOCK_RANGE",
  "CHAIN_TIP",
  "BLOCK",
  "SUBTREE_ROOTS",
  "CHAIN_INFO",
  "RPC",
  "SCAN",
  "CACHE_INSERT",
  "CACHE_DELETE",
  "CHECKPOINT",
  "COMPLETE_CHECK",
  "CLOSE_HISTORY",
  "OBSERVE",
  "IPC",
]);
const guards = new Set([
  "BLOCK_HEIGHT",
  "BLOCK_HASH_SHAPE",
  "BLOCK_PREV_HASH_SHAPE",
  "TIP_ADVERTISED_HASH",
  "OUTPUT_BLOCK_HASH",
  "OUTPUT_TX_INDEX",
  "OUTPUT_TX_ID",
  "FINAL_TIP_HEIGHT_CHANGED",
  "FINAL_TIP_HASH_CHANGED",
  "RECEIPT_CONTEXT",
  "CLOCK",
  "OTHER",
]);
const phases = new Set([
  "INITIAL",
  "CHECKPOINT",
  "OUTPUT_INCLUSION",
  "FINAL_TIP",
  "OTHER",
]);
const signals = new Set([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBREAK",
  "SIGHUP",
]);
const integer = (value, max) =>
  Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const progressStages = new Set([
  "OTHER",
  "SYNC_ENTER",
  "ROOT_IMPORT",
  "TIP",
  "UNIT_ENTER",
  "DOWNLOAD",
  "TREE_STATE",
  "SCAN_WORK",
  "COMMIT_PENDING",
  "UNIT_COMPLETE",
  "SYNC_COMPLETE",
]);
const coverage = new Set(["NONE", "EMPTY", "SHORT", "COMPLETE", "UNKNOWN"]);
const kinds = new Set(["OTHER", "VERIFY", "SCAN"]);
const progressCounters = [
  "requested_count",
  "received_count",
  "completed_unit_count",
  "committed_block_count",
  "sequence",
  "elapsed_ms",
  "last_progress_age_ms",
  "verify_empty_count",
  "verify_short_count",
  "verify_complete_count",
  "scan_empty_count",
  "scan_short_count",
  "scan_complete_count",
];
export function safeProgress(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const record = {
    version: 1,
    profile: "MAINTAINED_SYNC",
    stage: progressStages.has(value.stage) ? value.stage : "OTHER",
    last_completed_stage: progressStages.has(value.last_completed_stage)
      ? value.last_completed_stage
      : "OTHER",
    coverage: coverage.has(value.coverage) ? value.coverage : "UNKNOWN",
    unit_kind: kinds.has(value.unit_kind) ? value.unit_kind : "OTHER",
    stream_terminated: value.stream_terminated === true,
    maintained_returned: value.maintained_returned === true,
  };
  for (const key of progressCounters)
    record[key] =
      Number.isSafeInteger(value[key]) && value[key] >= 0
        ? Math.min(value[key], 4294967295)
        : 0;
  return record;
}
export function safeDiagnostic(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const start = integer(value.cached_range?.start, 4294967295);
  const end = integer(value.cached_range?.end, 4294967295);
  return {
    version: 1,
    class: classes.has(value.class) ? value.class : "UNKNOWN",
    stage: stages.has(value.stage) ? value.stage : "IPC",
    guard: guards.has(value.guard) ? value.guard : "OTHER",
    phase: phases.has(value.phase) ? value.phase : "OTHER",
    grpc_code: integer(value.grpc_code, 16),
    sqlite_code: integer(value.sqlite_code, 2147483647),
    cached_range:
      start !== null && end !== null && end >= start ? { start, end } : null,
    cache_blocks: integer(value.cache_blocks, 4294967295),
    cache_bytes: integer(value.cache_bytes, Number.MAX_SAFE_INTEGER),
    // Windows NTSTATUS values may be surfaced by Node as signed 32-bit codes.
    exit_code:
      Number.isInteger(value.exit_code) &&
      value.exit_code >= -2147483648 &&
      value.exit_code <= 4294967295
        ? value.exit_code
        : null,
    signal: signals.has(value.signal) ? value.signal : null,
    node_timeout: value.node_timeout === true,
    node_killed: value.node_killed === true,
    valid_response_frame: value.valid_response_frame === true,
    valid_failure_frame: value.valid_failure_frame === true,
  };
}

// Explicit single-use evidence file only. Refuse overwrite, symlinks and a broad
// Windows DACL. The child gets only an opt-in IPC flag, never this private path.
export async function protectedDiagnosticFile(env = process.env) {
  if (!env.WATCHER_DIAGNOSTIC_PATH) return undefined;
  if (process.platform !== "win32" || !env.LOCALAPPDATA || !env.SystemRoot)
    throw new Error("WATCHER_UNAVAILABLE");
  await assertEvidenceTarget(env.WATCHER_DIAGNOSTIC_PATH, env);
  const root =
    env.DARKPOOL_PG_ENV === "LIVE_EVIDENCE"
      ? configuredTarget(env).evidence
      : resolve(env.LOCALAPPDATA, "ZcashDarkPoolDev", "phase9");
  const target = resolve(env.WATCHER_DIAGNOSTIC_PATH);
  const within = relative(root, target);
  if (!within || within.startsWith("..") || isAbsolute(within))
    throw new Error("WATCHER_UNAVAILABLE");
  const parent = dirname(target);
  if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase())
    throw new Error("WATCHER_UNAVAILABLE");
  for (let dir = parent; ; dir = dirname(dir)) {
    if ((await lstat(dir)).isSymbolicLink())
      throw new Error("WATCHER_UNAVAILABLE");
    if (dir.toLowerCase() === root.toLowerCase()) break;
    if (dirname(dir) === dir) throw new Error("WATCHER_UNAVAILABLE");
  }
  const check = String.raw`
    $ErrorActionPreference='Stop'
    $acl=Get-Acl -LiteralPath $env:DARKPOOL_DIAGNOSTIC_PARENT
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (!$acl.AreAccessRulesProtected) { exit 1 }
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 1 }
    if ($acl.Access.Count -lt 1) { exit 1 }
    $ownerFullControl=$false
    foreach($rule in $acl.Access) {
      $id=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $id -notin @($sid,'S-1-5-18','S-1-5-32-544')) { exit 1 }
      if ($id -eq $sid -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $ownerFullControl=$true }
    }
    if (!$ownerFullControl) { exit 1 }
  `;
  await promisify(execFile)(
    resolve(
      env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(check, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      env: { SystemRoot: env.SystemRoot, DARKPOOL_DIAGNOSTIC_PARENT: parent },
      timeout: 10000,
      maxBuffer: 1024,
    },
  );
  const file = await open(target, "wx", 0o600);
  const progressTarget = target + ".progress";
  // One temporary name per session: failed cleanup cannot accumulate files.
  const temporary =
    progressTarget + "." + randomBytes(16).toString("hex") + ".tmp";
  try {
    const initial = await open(progressTarget, "wx", 0o600);
    try {
      await initial.writeFile(JSON.stringify(safeProgress()) + "\n");
      await initial.sync();
    } finally {
      await initial.close();
    }
  } catch {
    await file.close();
    await unlink(target);
    throw new Error("WATCHER_UNAVAILABLE");
  }
  let written = false;
  return {
    async progress(value) {
      // Parent is protected by the already-validated Windows DACL. Refuse path
      // replacement and corrupt/oversized prior material before each update.
      if (
        (await realpath(parent)).toLowerCase() !== parent.toLowerCase() ||
        (await lstat(parent)).isSymbolicLink()
      )
        throw new Error("WATCHER_UNAVAILABLE");
      const stat = await lstat(progressTarget);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 2048 ||
        stat.nlink !== 1
      )
        throw new Error("WATCHER_UNAVAILABLE");
      const prior = await open(progressTarget, "r");
      try {
        const opened = await prior.stat();
        if (
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.size > 2048
        )
          throw new Error("WATCHER_UNAVAILABLE");
        const bytes = Buffer.alloc(2049);
        const { bytesRead } = await prior.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 2048) throw new Error("WATCHER_UNAVAILABLE");
        const old = JSON.parse(bytes.subarray(0, bytesRead));
        if (JSON.stringify(old) !== JSON.stringify(safeProgress(old)))
          throw new Error("WATCHER_UNAVAILABLE");
      } finally {
        await prior.close();
      }
      let created = false;
      try {
        const next = await open(temporary, "wx", 0o600);
        created = true;
        try {
          await next.writeFile(JSON.stringify(safeProgress(value)) + "\n");
          await next.sync();
        } finally {
          await next.close();
        }
        await rename(temporary, progressTarget);
        created = false;
      } finally {
        if (created) await unlink(temporary).catch(() => {});
      }
    },
    async write(value) {
      if (written) return;
      written = true;
      await file.writeFile(JSON.stringify(safeDiagnostic(value)) + "\n");
      await file.sync();
    },
    close: () => file.close(),
  };
}

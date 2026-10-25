// Computer B protocol rehearsal: synthetic encrypted physical capsules ONLY.
// Never starts PostgreSQL, imports wallet material, or authorizes a restored target.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, readFile, readdir, open, mkdir, rm } from "node:fs/promises";
import { privateProcess } from "../../backup/crypto.mjs";
import {
  decryptPhysical,
  safeRelative,
  inventory,
  storage,
} from "../../backup/physical.mjs";
import { rejectRedirects } from "../../../db/target-registry.mjs";
import { assertDisposable } from "./policy.mjs";
import { verifyRecoveryTransfer } from "./bootstrap-recovery.mjs";
import { sha256 } from "./bootstrap-plan.mjs";
const sessions = new WeakMap();
const fail = () => {
  throw Error("COMPUTER_B_RECOVERY_REJECTED");
};
const json = (v) => Buffer.from(JSON.stringify(v));
const identity = async (path) => {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) fail();
  return `${st.dev}:${st.ino}`;
};
const writeNew = async (path, bytes) => {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
};
async function state(cap) {
  assertDisposable();
  const s = sessions.get(cap);
  if (!s || s.disposed) fail();
  await rejectRedirects(s.root);
  if (
    (await identity(s.root)) !== s.identity ||
    (await readFile(join(s.root, "scope.json"))).toString() !== s.scope
  )
    fail();
  await storage("check", s.root);
  return s;
}
export function offlineCustodyPlan() {
  return Object.freeze({
    computer_b: "CIPHERTEXT_AND_PUBLIC_MANIFEST_ONLY_NO_PRIVATE_KEY",
    offline_key:
      "SEPARATE_REMOVABLE_OFFLINE_MEDIUM_OR_SEALED_PAPER_NOT_ON_A_OR_B",
    key_access:
      "EXPLICIT_RECOVERY_CEREMONY_PRIVATE_INPUT_NO_ARGV_ENV_LOG_OR_TRANSFER_BUNDLE",
    independent_manifest:
      "RETAIN_HASH_SEQUENCE_AND_RECIPIENT_IN_SEPARATE_TRUSTED_CUSTODY",
    rollback_protection:
      "COMPARE_OPERATOR_HELD_LATEST_MANIFEST_NOT_ARCHIVE_SELF_ASSERTION",
    drill:
      "TEMPORARY_ISOLATED_QUARANTINE_SOURCE_FENCED_RESEAL_AND_REMOVE_TEMP_KEY_COPY",
    custody_verified: false,
    actual_computer_b_retention: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  });
}
export async function createComputerBRehearsal() {
  assertDisposable();
  const nonce = randomBytes(16).toString("hex"),
    root = join(tmpdir(), "darkpool-backup-fixture-" + nonce);
  await privateProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(
        new URL(
          "../../../scripts/dev/backup-fixture-storage.ps1",
          import.meta.url,
        ),
      ),
      "-Action",
      "create",
      "-Directory",
      root,
    ],
    Buffer.alloc(0),
    4096,
    { DARKPOOL_BACKUP_TEST_ONLY: "1" },
  );
  const scope = JSON.stringify({
    scope: "SYNTHETIC_COMPUTER_B_ONLY",
    root,
    nonce,
  });
  await writeNew(join(root, "scope.json"), scope);
  const cap = Object.freeze({ root, scope: "SYNTHETIC_COMPUTER_B_ONLY" });
  sessions.set(cap, {
    root,
    scope,
    identity: await identity(root),
    disposed: false,
  });
  return cap;
}
async function checkFiles(s, expected) {
  if ((await readdir(s.root)).sort().join() !== [...expected].sort().join())
    fail();
  for (const name of expected) {
    const path = join(s.root, name);
    await rejectRedirects(path);
    const st = await lstat(path);
    if (!st.isFile() || st.nlink !== 1 || st.size > 32 * 1024 * 1024) fail();
  }
}
export async function receiveComputerBFixture(
  cap,
  manifest,
  ciphertext,
  independentlyRetainedManifestSha256,
  { fault = null } = {},
) {
  const s = await state(cap);
  if (
    s.received ||
    ![null, "after_attempt", "after_ciphertext"].includes(fault)
  )
    fail();
  verifyRecoveryTransfer(manifest, ciphertext);
  if (sha256(json(manifest)) !== independentlyRetainedManifestSha256) fail();
  await checkFiles(s, ["scope.json"]);
  // Exclusive durable marker before delivery; interruption quarantines, never resumes.
  await writeNew(
    join(s.root, "receive-attempt.json"),
    json({
      scope: "SYNTHETIC_COMPUTER_B_ONLY",
      manifest_sha256: independentlyRetainedManifestSha256,
      financial_authorization: "NOT_GRANTED",
    }),
  );
  if (fault === "after_attempt") fail();
  await writeNew(join(s.root, "cluster.age"), ciphertext);
  if (fault === "after_ciphertext") fail();
  await writeNew(join(s.root, "manifest.json"), json(manifest));
  s.manifestHash = independentlyRetainedManifestSha256;
  s.manifest = structuredClone(manifest);
  s.received = true;
  return {
    status: "SYNTHETIC_CIPHERTEXT_RECEIVED",
    off_device_retention: "NOT_PROVEN",
  };
}
export async function reviewComputerBFixture(
  cap,
  syntheticKey,
  { sourceFenced, fault = null } = {},
) {
  const s = await state(cap);
  if (
    !s.received ||
    sourceFenced !== true ||
    ![null, "after_attempt", "during_restore"].includes(fault)
  )
    fail();
  await checkFiles(s, [
    "scope.json",
    "receive-attempt.json",
    "cluster.age",
    "manifest.json",
  ]);
  const bytes = await readFile(join(s.root, "manifest.json"));
  if (sha256(bytes) !== s.manifestHash) fail();
  const ciphertext = await readFile(join(s.root, "cluster.age"));
  verifyRecoveryTransfer(s.manifest, ciphertext);
  // Authentication before materialization; the independently held key enters only memory.
  const value = await decryptPhysical(ciphertext, syntheticKey, s.manifest);
  if (
    value.expected?.descriptor_sha256 !== s.manifest.descriptor_sha256 ||
    value.expected?.journal_sha256 !== s.manifest.journal_sha256
  )
    fail();
  const journal = value.tree.files.find(
    (f) => f.path === "observation-bootstrap-journal.json",
  );
  if (!journal || journal.sha256 !== s.manifest.journal_sha256) fail();
  await writeNew(
    join(s.root, "restore-attempt.json"),
    json({
      scope: "SYNTHETIC_COMPUTER_B_ONLY",
      status: "QUARANTINED_NO_LAUNCH",
      financial_authorization: "NOT_GRANTED",
    }),
  );
  if (fault === "after_attempt") fail();
  const destination = join(s.root, "restore-quarantine");
  await mkdir(destination);
  for (const path of value.tree.directories) {
    safeRelative(path);
    await mkdir(join(destination, ...path.split("/")), { recursive: true });
  }
  let written = 0;
  for (const file of value.tree.files) {
    safeRelative(file.path);
    await writeNew(
      join(destination, ...file.path.split("/")),
      Buffer.from(file.bytes, "base64"),
    );
    if (fault === "during_restore" && ++written === 1) fail();
  }
  // Re-read every byte; no database executable, credential login or wallet API runs.
  for (const file of value.tree.files) {
    const path = join(destination, ...file.path.split("/"));
    await rejectRedirects(path);
    if (
      (await lstat(path)).nlink !== 1 ||
      sha256(await readFile(path)) !== file.sha256
    )
      fail();
  }
  await storage("check", s.root);
  await writeNew(
    join(s.root, "restore-readiness.json"),
    json({
      status: "SYNTHETIC_DECRYPTION_AND_MATERIALIZATION_VERIFIED",
      inventory_sha256: inventory(value.tree),
      system_identifier: value.system_identifier,
      authorization: "QUARANTINED_NO_LAUNCH",
      financial_authorization: "NOT_GRANTED",
      actual_computer_b_retention: "NOT_PROVEN",
      offline_custody: "NOT_PROVEN",
    }),
  );
  return {
    status: "SYNTHETIC_DECRYPTION_AND_MATERIALIZATION_VERIFIED",
    authorization: "QUARANTINED_NO_LAUNCH",
    financial_authorization: "NOT_GRANTED",
    actual_computer_b_retention: "NOT_PROVEN",
  };
}
export async function disposeComputerBRehearsal(cap) {
  const s = await state(cap);
  if (
    dirname(resolve(s.root)) !== resolve(tmpdir()) ||
    !/^darkpool-backup-fixture-[a-f0-9]{32}$/.test(basename(s.root))
  )
    fail();
  // Only this process-owned new root; never select by prefix alone or touch B's proposed root.
  async function inspect(path) {
    await rejectRedirects(path);
    const st = await lstat(path);
    if (st.isDirectory())
      for (const name of await readdir(path)) await inspect(join(path, name));
    else if (!st.isFile() || st.nlink !== 1) fail();
  }
  await inspect(s.root);
  await rm(s.root, { recursive: true, force: false });
  s.disposed = true;
  return { cleaned: true };
}

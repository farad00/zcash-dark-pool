// Executable physical rehearsal only. No persistent backend, accounts or wallets.
import {
  PhysicalFixture,
  storage,
  decryptPhysical,
} from "../../backup/physical.mjs";
import { privateProcess } from "../../backup/crypto.mjs";
import { assertDisposable } from "./policy.mjs";
import { proposal, proposalDigest } from "../plan.mjs";
import {
  roleCreationSql,
  databaseCreationSql,
  schemaSql,
  postgresConfiguration,
  hbaConfiguration,
  rejectBootstrap,
  sha256,
} from "./bootstrap-plan.mjs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, readFile, readdir, open } from "node:fs/promises";
import { rejectRedirects } from "../../../db/target-registry.mjs";
const sessions = new WeakMap();
const phases = [
  "INITIALIZED",
  "SCHEMA_COMMITTED",
  "HBA_RESTRICTED",
  "VERIFIED",
  "STOPPED_SEALED",
];
const blockedPorts = [5432, 55432, 55433, 55434, 55435, 55436];
const directoryId = async (path) => {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) rejectBootstrap();
  return `${s.dev}:${s.ino}`;
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
const jsonBytes = (value) => Buffer.from(JSON.stringify(value));
async function state(cap) {
  assertDisposable();
  const s = sessions.get(cap);
  if (!s || s.disposed) rejectBootstrap();
  await s.f.owned();
  await rejectRedirects(s.journal);
  if (
    (await directoryId(s.journal)) !== s.identity ||
    (await readFile(join(s.journal, "scope.json"), "utf8")) !== s.scope
  )
    rejectBootstrap();
  return s;
}
export async function createBootstrapRehearsal() {
  assertDisposable();
  const f = new PhysicalFixture();
  // Reserve a fresh, ACL-protected TEST anchor before initialization. Never accept
  // a caller-selected root/port, registered profile or persisted capability.
  const root = join(
    tmpdir(),
    "darkpool-backup-fixture-" + randomBytes(16).toString("hex"),
  );
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
  // This anchor is cleaned only after the same directory identity is verified.
  const identity = await directoryId(root);
  const scope = JSON.stringify({
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    root,
    nonce: f.nonce,
    descriptor_sha256: proposalDigest(proposal()),
  });
  await writeNew(join(root, "scope.json"), scope);
  const cap = Object.freeze({
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    nonce: f.nonce,
    root,
  });
  const native = f.native.bind(f),
    start = f.start.bind(f);
  f.native = async (name, args, ...rest) => {
    if (blockedPorts.includes(f.port)) rejectBootstrap();
    return native(
      name,
      name === "initdb" ? [...args, "--no-clean"] : args,
      ...rest,
    );
  };
  f.start = async (which) => {
    if (blockedPorts.includes(f.port)) rejectBootstrap();
    return start(which);
  };
  const session = {
    f,
    journal: root,
    identity,
    scope,
    disposed: false,
    layout: null,
    hashes: new Map(),
    maintenanceDisabled: false,
  };
  sessions.set(cap, session);
  const originalStop = f.stop.bind(f);
  f.stop = async (which) => {
    if (!session.maintenanceDisabled) return originalStop(which);
    // The original harness uses the bootstrap DB login before stop. Once that
    // login is disabled, use the restricted context plus the same physical
    // identity checks, then stop only the exact owned PGDATA. Never re-enable it.
    await f.owned();
    if (f.running !== which) rejectBootstrap();
    await verifyBootstrap(cap, { which });
    await f.control(which);
    await f.native("pg_ctl", [
      "-D",
      f[which],
      "-m",
      "fast",
      "-t",
      "20",
      "-w",
      "stop",
    ]);
    if (
      (await f.status(which)) ||
      (await f.control(which)).state !== "shut down"
    )
      rejectBootstrap();
    f.running = null;
  };
  return cap;
}
async function preInitializationState(cap) {
  assertDisposable();
  const s = sessions.get(cap);
  if (!s || s.disposed) rejectBootstrap();
  await rejectRedirects(s.journal);
  if (
    (await directoryId(s.journal)) !== s.identity ||
    (await readFile(join(s.journal, "scope.json"), "utf8")) !== s.scope
  )
    rejectBootstrap();
  return s;
}
async function event(s, phase, extra = {}) {
  const entries = await bootstrapJournalInternal(s);
  if (phases[entries.length - 1] !== phase) rejectBootstrap();
  const previous = entries[entries.length - 1];
  const bytes = jsonBytes({
    phase,
    previous_sha256: previous.sha256,
    nonce: s.f.nonce,
    ...extra,
    financial_authorization: "NOT_GRANTED",
  });
  const name = `${String(entries.length).padStart(2, "0")}-${phase}.json`;
  await writeNew(join(s.journal, name), bytes);
  s.hashes.set(name, sha256(bytes));
}
async function bootstrapJournalInternal(s) {
  const files = (await readdir(s.journal))
    .filter((n) => n !== "scope.json")
    .sort();
  const result = [];
  let previous = null;
  for (let i = 0; i < files.length; i++) {
    const expected =
      i === 0
        ? "00-attempt.json"
        : `${String(i).padStart(2, "0")}-${phases[i - 1]}.json`;
    if (files[i] !== expected) rejectBootstrap();
    const path = join(s.journal, files[i]);
    await rejectRedirects(path);
    const st = await lstat(path);
    if (!st.isFile() || st.nlink !== 1 || st.size > 16384) rejectBootstrap();
    const bytes = await readFile(path),
      v = JSON.parse(bytes);
    if (
      v.nonce !== s.f.nonce ||
      v.financial_authorization !== "NOT_GRANTED" ||
      (i > 0 && (v.phase !== phases[i - 1] || v.previous_sha256 !== previous))
    )
      rejectBootstrap();
    if (s.hashes.get(files[i]) !== sha256(bytes)) rejectBootstrap();
    if (
      i === 0 &&
      (v.phase !== "EXCLUSIVE_ATTEMPT" ||
        v.scope !== "DISPOSABLE_BOOTSTRAP_ONLY" ||
        v.directory_identity !== s.identity ||
        v.descriptor_sha256 !== proposalDigest(proposal()))
    )
      rejectBootstrap();
    previous = sha256(bytes);
    result.push({ name: files[i], sha256: previous, value: v });
  }
  return result;
}
export async function inspectBootstrap(cap) {
  const s = await preInitializationState(cap),
    entries = await bootstrapJournalInternal(s);
  return Object.freeze({
    status:
      entries.at(-1)?.value.phase === "STOPPED_SEALED"
        ? "STOPPED_SEALED"
        : entries.length
          ? "QUARANTINED_NO_RETRY"
          : "NOT_ATTEMPTED",
    entries: entries.map(({ name, sha256 }) => ({ name, sha256 })),
    system_identifier: s.layout?.system_identifier ?? null,
    financial_authorization: "NOT_GRANTED",
  });
}
export async function runBootstrapRehearsal(cap, options = {}) {
  if (!options || Object.keys(options).some((k) => k !== "fault"))
    rejectBootstrap();
  const { fault = null } = options;
  const s = await preInitializationState(cap),
    f = s.f;
  if (
    ![
      null,
      "after_attempt",
      "after_initialization",
      "schema_transaction",
      "after_schema",
      "before_completion",
    ].includes(fault)
  )
    rejectBootstrap();
  // CreateNew is the concurrency boundary. Existing/partial state is never adopted.
  const attemptBytes = jsonBytes({
    phase: "EXCLUSIVE_ATTEMPT",
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    nonce: f.nonce,
    directory_identity: s.identity,
    descriptor_sha256: proposalDigest(proposal()),
    financial_authorization: "NOT_GRANTED",
  });
  await writeNew(join(s.journal, "00-attempt.json"), attemptBytes);
  s.hashes.set("00-attempt.json", sha256(attemptBytes));
  if (fault === "after_attempt") throw Error("BOOTSTRAP_INTERRUPTED");
  await f.create();
  s.layout = {
    scope: "DISPOSABLE_TEST_ONLY",
    nonce: f.nonce,
    port: f.port,
    database: f.database,
    system_identifier: f.systemId,
    roles: {
      maintenance: f.roles.admin,
      owner: f.roles.owner,
      context: f.roles.read,
    },
  };
  await event(s, "INITIALIZED", {
    system_identifier: f.systemId,
    port: f.port,
    database: f.database,
  });
  if (fault === "after_initialization") throw Error("BOOTSTRAP_INTERRUPTED");
  await f.sql(
    "source",
    roleCreationSql(s.layout, f.password("read")),
    "admin",
    "postgres",
  );
  await f.sql("source", databaseCreationSql(s.layout), "admin", "postgres");
  try {
    await f.sql(
      "source",
      schemaSql(s.layout, { rollbackProbe: fault === "schema_transaction" }),
    );
  } catch {
    // Prove SQL rollback before reporting; don't infer it from deleting a fixture.
    const count = await f.sql(
      "source",
      "SELECT count(*) FROM pg_namespace WHERE nspname='darkpool_watcher';",
    );
    const e = Error("BOOTSTRAP_SCHEMA_REJECTED");
    e.rollback_verified = count === "0";
    throw e;
  }
  await event(s, "SCHEMA_COMMITTED");
  if (fault === "after_schema") throw Error("BOOTSTRAP_INTERRUPTED");
  await f.stop("source");
  // Configuration replacement is permitted ONLY inside this new owned fixture.
  // Persistent execution has no backend and cannot use these TEST file writes.
  const { writeFile } = await import("node:fs/promises");
  f.config = postgresConfiguration(s.layout, f.source);
  s.hba = hbaConfiguration(s.layout);
  await writeFile(join(f.source, "postgresql.conf"), f.config);
  await writeFile(join(f.source, "pg_hba.conf"), s.hba);
  await f.start("source");
  await event(s, "HBA_RESTRICTED");
  await verifyBootstrap(cap, { final: false });
  await event(s, "VERIFIED");
  await f.sql("source", `ALTER ROLE "${f.roles.admin}" NOLOGIN;`);
  s.maintenanceDisabled = true;
  await verifyBootstrap(cap);
  await f.stop("source");
  if (fault === "before_completion") throw Error("BOOTSTRAP_INTERRUPTED");
  await event(s, "STOPPED_SEALED", {
    system_identifier: f.systemId,
    port: f.port,
    database: f.database,
  });
  return inspectBootstrap(cap);
}
export async function verifyBootstrap(
  cap,
  { final = true, which = "source" } = {},
) {
  const s = await state(cap),
    f = s.f;
  if (
    !s.layout ||
    typeof final !== "boolean" ||
    !["source", "restored"].includes(which)
  )
    rejectBootstrap();
  if ((await readFile(join(f[which], "pg_hba.conf"), "utf8")) !== s.hba)
    rejectBootstrap();
  const value = JSON.parse(
    await f.sql(which, "SELECT darkpool_watcher.context();", "read"),
  );
  if (
    JSON.stringify(value) !==
    JSON.stringify({
      instance: "testnet_observation_v1",
      mode: "UNFUNDED_STATUS_ONLY",
      state: "DRAFT",
      acceptance: "NOT_EVALUATED",
      financial_authorization: "NOT_GRANTED",
      spending_enabled: false,
    })
  ) {
    // jsonb key order is not significant.
    const expected = {
      instance: "testnet_observation_v1",
      mode: "UNFUNDED_STATUS_ONLY",
      state: "DRAFT",
      acceptance: "NOT_EVALUATED",
      financial_authorization: "NOT_GRANTED",
      spending_enabled: false,
    };
    if (
      Object.keys(value).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([k, v]) => value[k] !== v)
    )
      rejectBootstrap();
  }
  const r = s.layout.roles;
  const checks = JSON.parse(
    await f.sql(
      which,
      `SELECT jsonb_build_object(
    'owner_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='${r.owner}'),
    'maintenance_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='${r.maintenance}'),
    'context_privileged',(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit FROM pg_roles WHERE rolname='${r.context}'),
    'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='${r.context}')),
    'database_write',has_database_privilege(current_user,current_database(),'CREATE,TEMP'),
    'table_access',has_table_privilege(current_user,'darkpool_watcher.bootstrap_boundary','SELECT,INSERT,UPDATE,DELETE'),
    'product_tables',(SELECT count(*) FROM pg_class WHERE relname IN ('tickets','markets','receipts','claims','payout_intents')));`,
      "read",
    ),
  );
  if (
    checks.maintenance_login !== !final ||
    Object.entries(checks).some(
      ([k, v]) => k !== "maintenance_login" && v !== false && v !== 0,
    )
  )
    rejectBootstrap();
  return {
    status: "NONFINANCIAL_BOOTSTRAP_VERIFIED",
    financial_authorization: "NOT_GRANTED",
    maintenance_login: checks.maintenance_login,
  };
}
export async function bootstrapDenialProbe(cap, name) {
  const s = await state(cap),
    f = s.f;
  const probes = {
    table: "SELECT * FROM darkpool_watcher.bootstrap_boundary;",
    create: "CREATE TABLE public.forbidden(id int);",
    mutate: "UPDATE darkpool_watcher.bootstrap_boundary SET binding='{}';",
    owner: `SET ROLE "${f.roles.owner}";`,
    acceptance: "SELECT darkpool_watcher.reconcile();",
    payout: "SELECT darkpool_claims.reserve();",
    other_database: "SELECT 1;",
  };
  if (!Object.hasOwn(probes, name)) rejectBootstrap();
  return f.sql(
    "source",
    probes[name],
    "read",
    name === "other_database" ? "postgres" : f.database,
  );
}
export async function backupBootstrap(cap) {
  const s = await state(cap),
    f = s.f;
  if (
    s.receipt ||
    (await inspectBootstrap(cap)).status !== "STOPPED_SEALED" ||
    f.running ||
    (await f.status("source"))
  )
    rejectBootstrap();
  const journal = await bootstrapJournalInternal(s);
  await writeNew(
    join(f.source, "observation-bootstrap-journal.json"),
    jsonBytes(journal),
  );
  f.expected = {
    descriptor_sha256: proposalDigest(proposal()),
    journal_sha256: sha256(jsonBytes(journal)),
  };
  const sealed = await f.backup();
  s.receipt = Object.freeze({
    ...sealed.receipt,
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    descriptor_sha256: proposalDigest(proposal()),
    journal_sha256: f.expected.journal_sha256,
    off_device_retention: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  });
  return s.receipt;
}
export async function verifyBootstrapCiphertext(
  cap,
  { wrongKey = false, altered = false } = {},
) {
  const s = await state(cap),
    f = s.f;
  if (
    !s.receipt ||
    typeof wrongKey !== "boolean" ||
    typeof altered !== "boolean"
  )
    rejectBootstrap();
  const bytes = await readFile(join(f.roots[1], "cluster.age"));
  if (altered) bytes[bytes.length - 1] ^= 1;
  const key = wrongKey
    ? "AGE-SECRET-KEY-1INVALID"
    : await readFile(join(f.roots[2], "recovery.identity"), "utf8");
  const v = await decryptPhysical(bytes, key, s.receipt);
  if (
    v.system_identifier !== f.systemId ||
    v.expected.journal_sha256 !== s.receipt.journal_sha256
  )
    rejectBootstrap();
  return {
    status: "AUTHENTICATED_COLD_BACKUP",
    financial_authorization: "NOT_GRANTED",
  };
}
export async function restoreBootstrap(cap) {
  const s = await state(cap),
    f = s.f;
  if (!s.receipt || s.restored || f.running) rejectBootstrap();
  await verifyBootstrapCiphertext(cap);
  await f.restore();
  const retained = await readFile(
    join(f.restored, "observation-bootstrap-journal.json"),
  );
  if (sha256(retained) !== s.receipt.journal_sha256) rejectBootstrap();
  await f.start("restored");
  await verifyBootstrap(cap, { which: "restored" });
  s.restored = true;
  return {
    status: "RESTORED_QUARANTINED_NO_LAUNCH",
    system_identifier: f.systemId,
    off_device_retention: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  };
}
// Private synthetic material for the isolated Computer B adapter tests only.
// Never a production export, CLI response or retained test report.
export async function exportBootstrapRecoveryFixture(cap) {
  const s = await state(cap),
    f = s.f;
  if (!s.receipt || f.running || (await f.status("source"))) rejectBootstrap();
  return {
    receipt: s.receipt,
    ciphertext: await readFile(join(f.roots[1], "cluster.age")),
    syntheticKey: await readFile(join(f.roots[2], "recovery.identity"), "utf8"),
  };
}
export async function disposeBootstrapRehearsal(cap) {
  const s = await preInitializationState(cap);
  const cleaned = await s.f.cleanup();
  if (!cleaned.cleaned) return cleaned;
  await storage("check", s.journal);
  // One shell/filesystem mechanism; exact identity and TEMP containment before removal.
  if (
    (await directoryId(s.journal)) !== s.identity ||
    dirname(resolve(s.journal)) !== resolve(tmpdir()) ||
    !/^darkpool-backup-fixture-[a-f0-9]{32}$/.test(basename(s.journal))
  )
    rejectBootstrap();
  const { rm } = await import("node:fs/promises");
  await rm(s.journal, { recursive: true, force: false });
  s.disposed = true;
  return { cleaned: true };
}

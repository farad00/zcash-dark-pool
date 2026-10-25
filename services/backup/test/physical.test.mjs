import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, rename, lstat, access } from "node:fs/promises";
import { join } from "node:path";
import {
  PhysicalFixture,
  storage,
  safeRelative,
  decryptPhysical,
  validateArchive,
  inventory,
  scanTree,
} from "../physical.mjs";
import { syntheticKeyPair, digest } from "../crypto.mjs";
import { recomputeLedgerCommitment } from "../../../packages/protocol/phase10/ledger-commitment.ts";

const f = new PhysicalFixture();
const limits = {
  stake_bounds: { min: 1n, max: 1000000n },
  max_tickets: 8n,
  max_text_bytes: 8192,
  max_amount_bytes: 128,
  max_ledger_bytes: 1024 * 1024,
};
let sealed, bound, restored, backupBytes;
const decode = (v) =>
  v.records.map((r) => ({
    ...r,
    accepted_amount_zat: BigInt(r.accepted_amount_zat),
    record_blinding: new Uint8Array(Buffer.from(r.record_blinding, "hex")),
  }));
before(async () => {
  await f.create();
  const context = {
    profile: "DARKPOOL_LEDGER_V1_BIN1_B2B256",
    version: 1,
    network: "testnet",
    market_id: "physical-synthetic-" + f.nonce,
    locked_at: "2026-10-20T00:00:00.000000Z",
  };
  const records = Array.from({ length: 3 }, (_, i) => ({
    version: 1,
    network: "testnet",
    market_id: context.market_id,
    ticket_id: randomBytes(32).toString("hex"),
    side: i % 2 ? "NO" : "YES",
    accepted_amount_zat: String(7 + 2 * i),
    accepted_payment_ref: "synthetic-physical-output-" + i,
    receiver_ref: "synthetic-physical-receiver-" + i,
    record_blinding: randomBytes(32).toString("hex"),
  }));
  const commitment = {
    context,
    records,
    public: recomputeLedgerCommitment(context, decode({ records }), limits),
  };
  bound = await f.seed(commitment);
});
after(async () => {
  const cleanup = await f.cleanup();
  // Public operational evidence contains identities/paths only, never private rows,
  // blindings, passwords, role verifiers, encryption keys or participant amounts.
  process.stdout.write(
    "PHYSICAL_RECOVERY_EVIDENCE " +
      JSON.stringify({
        nonce: f.nonce,
        port: f.port,
        database: f.database,
        system_identifier: f.systemId,
        database_oid: bound?.database_oid,
        source: f.source,
        restored: f.restored,
        source_directory_identity: f.sourceDirectoryIdentity,
        restored_directory_identity: restored?.directory_identity,
        archive_inventory_sha256: f.receipt?.inventory_sha256,
        ...cleanup,
      }) +
      "\n",
  );
  assert.equal(
    cleanup.cleaned,
    true,
    "Identity-uncertain resources retained; see operational evidence",
  );
  for (const r of f.created) await assert.rejects(access(r.root));
});

test("fresh disposable source has distinct paths, ephemeral port, strong auth and nonfinancial scope", async () => {
  assert.ok(
    f.port >= 49152 &&
      f.port <= 65535 &&
      ![55432, 55433, 55434, 55435].includes(f.port),
  );
  assert.notEqual(f.source, f.restored);
  assert.match(f.systemId, /^\d{16,20}$/);
  assert.equal((await f.control("source")).state, "in production");
  assert.equal(
    await f.sql(
      "source",
      "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%';",
    ),
    "0",
  );
  assert.equal(
    await f.sql("source", "SELECT current_user;", "owner"),
    f.roles.owner,
  );
  await assert.rejects(
    f.sql("source", "SELECT value FROM recovery_probe.private_state;", "read"),
  );
  assert.ok(
    await f.sql(
      "source",
      "SELECT commitment IS NOT NULL FROM recovery_probe.safe_summary;",
      "read",
    ),
  );
});
test("copying a running cluster fails closed", async () => {
  await assert.rejects(f.backup(), /PHYSICAL_REHEARSAL_REJECTED/);
  assert.equal(await f.status("source"), true);
  await assert.rejects(access(join(f.roots[1], "cluster.age")));
});
test("changed port/path scope refuses before any target operation", async () => {
  const port = f.port,
    source = f.source;
  try {
    f.port = 55433;
    await assert.rejects(f.status("source"), /PHYSICAL_REHEARSAL_REJECTED/);
  } finally {
    f.port = port;
  }
  try {
    f.source = join(f.root, "not-the-source");
    await assert.rejects(f.status("source"), /PHYSICAL_REHEARSAL_REJECTED/);
  } finally {
    f.source = source;
  }
  assert.equal(await f.status("source"), true);
});
test("clean shutdown establishes complete cold-backup consistency and data page checksums", async () => {
  await f.stop("source");
  assert.equal(await f.status("source"), false);
  assert.equal((await f.control("source")).state, "shut down");
  await assert.rejects(access(join(f.source, "postmaster.pid")));
  await f.native("pg_checksums", ["--check", "-D", f.source]);
});
test("unsafe ACLs fail before backup; repairing only the disposable permission probe restores checks", async () => {
  await mkdir(join(f.root, "unsafe-probe"));
  await storage("unsafe", f.root);
  try {
    await assert.rejects(
      storage("check", f.root),
      (e) => e.message === "BACKUP_REJECTED" && e.exitCode === 1,
    );
    await assert.rejects(f.backup());
  } finally {
    await storage("repair", f.root);
  }
  await storage("check", f.root);
});
test("complete cold cluster encrypts with age, retaining exact inventory and portable credentials", async () => {
  sealed = await f.backup();
  backupBytes = await readFile(join(f.roots[1], "cluster.age"));
  assert.equal(digest(backupBytes), sealed.receipt.ciphertext_sha256);
  assert.ok(
    backupBytes.subarray(0, 22).toString().startsWith("age-encryption.org/v1"),
  );
  for (const c of f.currentCredentials)
    assert.equal(backupBytes.includes(Buffer.from(c.password)), false);
  assert.equal(inventory(await scanTree(f.source)), f.receipt.inventory_sha256);
});
test("altered ciphertext fails both trusted digest and native authentication checks", async () => {
  const key = await readFile(join(f.roots[2], "recovery.identity"), "utf8"),
    changed = Buffer.from(backupBytes);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(decryptPhysical(changed, key, f.receipt));
  await assert.rejects(
    decryptPhysical(changed, key, {
      ...f.receipt,
      ciphertext_sha256: digest(changed),
    }),
  );
  await assert.rejects(access(f.restored));
});
test("wrong or missing independent recovery key cannot restore", async () => {
  await assert.rejects(
    decryptPhysical(
      backupBytes,
      (await syntheticKeyPair()).identity,
      f.receipt,
    ),
  );
  await assert.rejects(decryptPhysical(backupBytes, "", f.receipt));
});
test("missing archive files and path escape attempts reject before extraction", async () => {
  const value = await decryptPhysical(
    backupBytes,
    await readFile(join(f.roots[2], "recovery.identity"), "utf8"),
    f.receipt,
  );
  value.tree.files = value.tree.files.filter(
    (v) => v.path !== "global/pg_control",
  );
  assert.throws(
    () => validateArchive(value, f.receipt),
    /PHYSICAL_REHEARSAL_REJECTED/,
  );
  for (const p of [
    "../escape",
    "/absolute",
    "C:/elsewhere",
    "pg_wal/../../other",
    "a\\b",
    "a:b",
    "CON",
    "a/",
    "a/../b",
  ]) {
    assert.throws(() => safeRelative(p));
  }
  await assert.rejects(access(f.restored));
});
test("physical restore into a new directory preserves every archived byte and clean control state", async () => {
  f.currentCredentials = null; // Recovery must use the encrypted retained passwords.
  const value = await f.restore();
  assert.equal(
    inventory(await scanTree(f.restored)),
    f.receipt.inventory_sha256,
  );
  assert.equal((await f.control("restored")).state, "shut down");
  assert.equal(await f.status("source"), false);
  await f.native("pg_checksums", ["--check", "-D", f.restored]);
  const stat = await lstat(f.restored);
  restored = {
    directory_identity: { dev: String(stat.dev), ino: String(stat.ino) },
  };
  assert.notEqual(
    restored.directory_identity.ino,
    f.sourceDirectoryIdentity.ino,
  );
  assert.equal(
    digest(Buffer.from(JSON.stringify(value.expected))),
    digest(Buffer.from(JSON.stringify(f.expected))),
  );
});
test("missing control file prevents restored startup and leaves source offline", async () => {
  const control = join(f.restored, "global", "pg_control"),
    saved = join(f.root, "control.fixture");
  await rename(control, saved);
  try {
    await assert.rejects(f.start("restored"), (e) => e.code === "ENOENT");
    assert.equal(await f.status("source"), false);
  } finally {
    await rename(saved, control);
  }
});
test("identity-identical source and restore cannot be online together through the controller", async () => {
  await f.start("source");
  try {
    await assert.rejects(f.start("restored"), /PHYSICAL_REHEARSAL_REJECTED/);
    assert.equal(await f.status("source"), true);
    assert.equal(await f.status("restored"), false);
  } finally {
    await f.stop("source");
  }
  assert.equal(await f.status("source"), false);
  await f.start("restored");
  await assert.rejects(f.start("source"), /PHYSICAL_REHEARSAL_REJECTED/);
  assert.equal(await f.status("source"), false);
});
test("physical database/role OIDs, SCRAM verifiers, schema, SQL ACLs and rows remain exact", async () => {
  const actual = await f.summary("restored");
  assert.equal(
    digest(Buffer.from(JSON.stringify(actual))),
    digest(Buffer.from(JSON.stringify(f.expected))),
  );
  assert.equal(actual.database_oid, bound.database_oid);
  assert.equal(actual.system_identifier, bound.system_identifier);
  assert.equal(
    await f.sql("restored", "SELECT current_user;", "owner"),
    f.roles.owner,
  );
  await assert.rejects(
    f.sql(
      "restored",
      "SELECT value FROM recovery_probe.private_state;",
      "read",
    ),
  );
  assert.equal(
    await f.sql(
      "restored",
      "SELECT commitment IS NOT NULL FROM recovery_probe.safe_summary;",
      "read",
    ),
    "t",
  );
});
test("retained blindings recompute the identical frozen Phase 10 commitment", async () => {
  const value = JSON.parse(
    await f.sql(
      "restored",
      "SELECT value FROM recovery_probe.private_state;",
      "owner",
    ),
  );
  assert.deepEqual(
    recomputeLedgerCommitment(
      value.commitment.context,
      decode(value.commitment),
      limits,
    ),
    value.commitment.public,
  );
  assert.equal(value.system_identifier, f.systemId);
  assert.equal(value.database_oid, bound.database_oid);
  // Physical bytes/IDs do not confer application authorization after a path move.
  assert.equal(value.source_directory, f.source);
  assert.notEqual(value.source_directory, f.restored);
  assert.notEqual(
    value.source_directory_identity.ino,
    restored.directory_identity.ino,
  );
});
test("recovered passwords rewrap into private DPAPI files and both clusters finish stopped", async () => {
  // Only original random fixture credentials, never retained environment XML.
  const script = new URL(
    "../../../scripts/dev/backup-fixture-storage.ps1",
    import.meta.url,
  );
  const { privateProcess } = await import("../crypto.mjs");
  const { fileURLToPath } = await import("node:url");
  await privateProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(script),
      "-Action",
      "rewrap",
      "-Directory",
      f.roots[2],
    ],
    Buffer.from(JSON.stringify(f.currentCredentials)),
    4096,
    {
      DARKPOOL_BACKUP_TEST_ONLY: "1",
      ...Object.fromEntries(
        ["USERPROFILE", "APPDATA", "LOCALAPPDATA"].map((k) => [
          k,
          process.env[k],
        ]),
      ),
    },
  );
  for (const c of f.currentCredentials) {
    const xml = await readFile(join(f.roots[2], c.purpose + ".xml"));
    assert.equal(xml.includes(Buffer.from(c.password)), false);
  }
  for (const root of f.roots) await storage("check", root);
  await f.stop("restored");
  assert.equal(await f.status("source"), false);
  assert.equal(await f.status("restored"), false);
});

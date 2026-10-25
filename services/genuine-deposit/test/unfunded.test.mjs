import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerText } from "../../../db/environment-identity.mjs";
import { proposedTarget } from "../target.mjs";
import {
  validateApproval,
  assertUnfundedLaunch,
  scope,
  layout,
  sha256,
  durableNew,
} from "../unfunded.mjs";
import {
  intakeFiles,
  migrationDigest,
  roleSql,
  hba,
  marketSql,
  installSql,
} from "../intake.mjs";
import {
  composeUnfundedIssuer,
  assertReadyMarket,
} from "../unfunded-runtime.mjs";
import { openGenuineDeposit } from "../runtime.mjs";
import { checkTree } from "../unfunded-tools.mjs";
import { privateProcess } from "../../backup/crypto.mjs";
import { fileURLToPath } from "node:url";
const now = Date.parse("2026-10-25T12:00:00Z");
export function approval() {
  return {
    version: 1,
    scope,
    target: proposedTarget(),
    approval_id: "ab".repeat(16),
    expires_at: "2026-10-25T13:00:00Z",
    operator_sid: "S-1-5-21-11-12-13-1000",
    web_sid: "S-1-5-21-11-12-13-1001",
    viewer_sid: "S-1-5-21-11-12-13-1002",
    native_sha256: "ab".repeat(32),
    migrations_sha256: "cd".repeat(32),
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    acceptance_enabled: false,
  };
}
function cap() {
  const a = approval(),
    profile = {
      version: 1,
      kind: "TESTNET_OBSERVATION",
      host: "127.0.0.1",
      instance: a.target.instance,
      port: 55436,
      system_identifier: "7999999999999999999",
      cluster_id: "11111111-1111-4111-8111-111111111111",
      directory_identity: { dev: "1", ino: "2" },
      database: a.target.database,
      data_directory: layout().data,
      financial_authorization: "NOT_GRANTED",
    };
  const receipt = {
    scope,
    status: "INTAKE_INSTALLED_NO_MARKET",
    marker: markerText(profile),
    approval_sha256: sha256(JSON.stringify(a)),
    migrations_sha256: a.migrations_sha256,
  };
  return {
    approval: a,
    profile,
    receipt,
    completion: {
      scope,
      status: "PHYSICAL_BOOTSTRAP_COMPLETED",
      receipt_sha256: sha256(JSON.stringify(receipt)),
    },
    actorSid: a.web_sid,
    purpose: "issuer",
  };
}
test("manual approval is exact, expiring, distinct-SID and unfunded-only", () => {
  assert.equal(
    validateApproval(approval(), proposedTarget(), now).scope,
    scope,
  );
  for (const edit of [
    { expires_at: "2026-10-25T11:59:00Z" },
    { expires_at: "2026-10-26T12:00:00Z" },
    { web_sid: approval().operator_sid },
    { financial_authorization: "GRANTED" },
    { acceptance_enabled: true },
    { production_trust: "READY" },
    { bypass: true },
  ])
    assert.throws(() =>
      validateApproval({ ...approval(), ...edit }, proposedTarget(), now),
    );
});
test("wrong-target approval refuses every protected port, database and root", () => {
  for (const port of [5432, 55432, 55433, 55434, 55435])
    assert.throws(() =>
      validateApproval(
        { ...approval(), target: { ...proposedTarget(), port } },
        proposedTarget(),
        now,
      ),
    );
  for (const edit of [
    { database: "postgres" },
    { root: "C:\\Users\\Admin\\OneDrive" },
    { network: "mainnet" },
  ])
    assert.throws(() =>
      validateApproval(
        { ...approval(), target: { ...proposedTarget(), ...edit } },
        proposedTarget(),
        now,
      ),
    );
});
test("launch binds actual role SID, fresh physical identity, exact receipt and expiry", () => {
  assert.equal(assertUnfundedLaunch(cap(), now), true);
  const c = cap();
  assert.equal(
    assertUnfundedLaunch(
      { ...c, purpose: "allocator", actorSid: c.approval.viewer_sid },
      now,
    ),
    true,
  );
  for (const edit of [
    { actorSid: c.approval.operator_sid },
    { purpose: "scan" },
    { purpose: "signer" },
    { purpose: "settlement" },
    { profile: { ...c.profile, port: 55435 } },
    { profile: { ...c.profile, kind: "TEST" } },
    { profile: { ...c.profile, system_identifier: "7698884242696928048" } },
    { receipt: { ...c.receipt, marker: "different" } },
    { receipt: { ...c.receipt, approval_sha256: "00".repeat(32) } },
    { completion: undefined },
    { completion: { ...c.completion, receipt_sha256: "00".repeat(32) } },
  ])
    assert.throws(() => assertUnfundedLaunch({ ...c, ...edit }, now));
  assert.throws(() => assertUnfundedLaunch(c, now + 3600000));
});
test("full scanner/deposit gate remains unavailable even with an unfunded approval", async () => {
  await assert.rejects(
    openGenuineDeposit({ approval: approval() }),
    /NATIVE_LAUNCH_NOT_APPROVED/,
  );
});
test("intake uses exactly unchanged migration sequence 0001–0007; checksum/order failures reject", async () => {
  const files = await intakeFiles();
  assert.equal(files.length, 7);
  const digest = migrationDigest(files);
  assert.notEqual(
    migrationDigest(
      files.map((f, i) => (i ? f : { ...f, sql: f.sql + "--different" })),
    ),
    digest,
  );
  for (const f of [files.slice(1), [...files, files[0]], [...files].reverse()])
    assert.throws(() => migrationDigest(f));
  const a = { ...approval(), migrations_sha256: digest };
  const sql = await installSql({ database: proposedTarget().database }, a);
  assert.match(sql, /one_unfunded_attempt/);
  assert.match(sql, /no_receipts/);
  assert.match(sql, /no_acceptance/);
  assert(!sql.includes("0008_phase11"));
  assert.match(sql, /darkpool_participant_status/);
  await assert.rejects(
    installSql({ database: proposedTarget().database }, approval()),
  );
});
test("HBA rejects default/network/other DB sessions; no watcher login or grants", () => {
  const s = hba();
  assert(s.includes("127.0.0.1/32 scram-sha-256"));
  assert(s.endsWith("host all all ::0/0 reject\n"));
  assert(!s.includes("trust"));
  assert(!s.includes("darkpool_obs_v1_watch"));
  const passwords = Object.fromEntries(
    ["maintenance", "admin", "issue", "status", "read"].map((k, i) => [
      k,
      String(i + 1).repeat(64),
    ]),
  );
  assert.match(roleSql(passwords), /darkpool_obs_v1_watch" NOLOGIN/);
  assert.throws(() => roleSql({ ...passwords, read: passwords.issue }));
});
test("market builder uses frozen create/OPEN entrypoint and rejects malformed anchor; never fake acceptance", () => {
  const c = { id: "private-unfunded", closes_at: "2026-10-25T14:00:00Z" },
    w = {
      account_ref: "11".repeat(16) + "1111",
      anchor_height: 100,
      anchor_hash: "ab".repeat(32),
    };
  assert.match(marketSql(c, w), /darkpool_admin.command\('open'/);
  assert(!marketSql(c, w).includes("UPDATE darkpool_private.markets"));
  for (const e of [
    { anchor_height: 1 },
    { anchor_hash: "no" },
    { seed: "forbidden" },
  ])
    assert.throws(() => marketSql(c, { ...w, ...e }));
});
test("create-only durable markers preserve interruption evidence and reject concurrent replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unfunded-marker-"));
  try {
    const path = join(dir, "attempt.json");
    const r = await Promise.allSettled([
      durableNew(path, "original"),
      durableNew(path, "other"),
    ]);
    assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
    const before = await readFile(path);
    await assert.rejects(durableNew(path, "retry"));
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("private tool tree rejects altered, missing and extra files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unfunded-tools-"));
  try {
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "inventory.json"), "{}");
    await writeFile(
      join(dir, "bin", "psql.exe"),
      "synthetic bytes, never executed",
    );
    const b = await readFile(join(dir, "bin", "psql.exe"));
    const zone = Buffer.from("synthetic timezone fixture");
    await writeFile(join(dir, "bin", "GMT+0"), zone);
    const m = {
      directories: ["bin"],
      files: [
        { path: "bin/psql.exe", size: b.length, sha256: sha256(b) },
        { path: "bin/GMT+0", size: zone.length, sha256: sha256(zone) },
      ],
    };
    await checkTree(dir, m);
    await writeFile(join(dir, "extra"), "unexpected");
    await assert.rejects(checkTree(dir, m));
    await rm(join(dir, "extra"));
    await writeFile(join(dir, "bin", "psql.exe"), "altered");
    await assert.rejects(checkTree(dir, m));
    await rm(join(dir, "bin", "psql.exe"));
    await assert.rejects(checkTree(dir, m));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("issuer-only runtime has no scanner/claim/payout capability and closes fail-closed", async () => {
  let checks = 0;
  const r = composeUnfundedIssuer({
    issueQuery: async () => {
      throw Error("no fixture query");
    },
    allocate: async () => {},
    statusQuery: async () => {},
    readMarket: async () => [],
    verify: async () => {
      checks++;
    },
    environment: "DISPOSABLE_TEST",
  });
  assert.equal(r.cycle, undefined);
  assert.equal(r.wallet, undefined);
  assert.equal(r.acceptance_enabled, false);
  assert.equal(r.financial_authorization, "NOT_GRANTED");
  await r.close();
  await assert.rejects(r.issue({}));
  assert.equal(checks, 0);
});
test("startup refuses missing/wrong/expired market instead of advertising a ready issuer", () => {
  const market = {
    market_id: "unfunded",
    status: "OPEN",
    closes_at: "2026-10-25T13:00:00Z",
  };
  assert.doesNotThrow(() => assertReadyMarket([market], market, now));
  for (const rows of [
    [],
    [market, market],
    [{ ...market, market_id: "other" }],
    [{ ...market, status: "DRAFT" }],
    [{ ...market, closes_at: "2026-10-25T11:00:00Z" }],
  ])
    assert.throws(() => assertReadyMarket(rows, market, now));
});
test("Windows PowerShell 5.1 actual storage checker rejects broad ACLs, writable runtime grants and reparse ancestors", async () => {
  assert(process.env.NODE_TEST_CONTEXT);
  const bytes = await privateProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./unfunded-storage-fixture.ps1", import.meta.url)),
    ],
    Buffer.alloc(0),
    4096,
    { DARKPOOL_UNFUNDED_STORAGE_TEST_ONLY: "1" },
  );
  const r = JSON.parse(bytes.toString());
  assert.equal(r.status, "PASS");
  assert.equal(r.accounts_created, 0);
  assert.equal(r.wallet_access, false);
  assert.equal(r.checks.length, 5);
});

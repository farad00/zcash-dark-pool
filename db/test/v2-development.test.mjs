import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import {
  readFile,
  writeFile,
  lstat,
  rm,
  readdir,
  access,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  developmentPlan,
  disposablePlan,
  validatePlan,
  loadProfile,
  fixtureQuery,
  verifyFixtureStop,
  verifyDevelopment,
} from "../v2-development.mjs";
import { loadEnvironmentGuard } from "../environment.mjs";
import { v2Plan } from "../v2-target.mjs";
import { liveWalletPath } from "../target-registry.mjs";
import { issuanceQuery } from "../issuance-runtime.mjs";
import { watcherQuery } from "../../services/watcher/db.mjs";
import { withPayoutSession } from "../../services/payout/session.mjs";
import { privateProcess } from "../../services/backup/crypto.mjs";
import { storage } from "../../services/backup/physical.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";

const root = join(
  tmpdir(),
  "darkpool-backup-fixture-" + randomBytes(16).toString("hex"),
);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const script = (name) => join(repo, "scripts/dev", name);
const osEnv = () =>
  Object.fromEntries(
    [
      "PATH",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
      "LOCALAPPDATA",
      "USERPROFILE",
      "APPDATA",
    ]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
let plan,
  profile,
  credentials,
  rootIdentity,
  created = false;
const sql = (text, reader = false) =>
  fixtureQuery(
    plan,
    reader ? credentials.read : credentials.maintenance,
    text,
    reader,
  );
before(async () => {
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const selected = server.address().port;
      server.close(() => resolvePort(selected));
    });
  });
  plan = disposablePlan(root, port);
  await assert.rejects(access(root));
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script("v2-development.ps1"),
      "-Create",
      "-DevelopmentOnlyAcknowledged",
      "-DisposableRehearsal",
      "-RehearsalRoot",
      root,
      "-RehearsalPort",
      String(port),
    ],
    {
      timeoutMs: 180000,
      allowInheritedOutputAfterExit: true,
      env: { ...osEnv(), DARKPOOL_DEV_REHEARSAL: "1" },
    },
  );
  try {
    rootIdentity = await lstat(root);
    created = true;
  } catch {
    /* No owned resource created. */
  }
  if (boundedExit(result) !== 0)
    throw new Error(
      "DEVELOPMENT_FIXTURE_INITIALIZATION_FAILED:" +
        (/V2_DEVELOPMENT_REJECTED_STAGE_[A-Z_]+:[A-Za-z]+:[0-9]+/.exec(
          result.stdout,
        )?.[0] ?? "UNKNOWN"),
    );
  profile = await loadProfile(plan);
  credentials = JSON.parse(
    (
      await privateProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script("v2-development-test-credentials.ps1"),
          "-Directory",
          root,
        ],
        Buffer.alloc(0),
        4096,
        { ...osEnv(), DARKPOOL_DEV_REHEARSAL: "1" },
      )
    ).toString(),
  );
});
after(async () => {
  if (!created) return;
  let cleaned = false;
  try {
    assert.equal(
      dirname(resolve(root)).toLowerCase(),
      resolve(tmpdir()).toLowerCase(),
    );
    assert.equal((await lstat(root)).ino, rootIdentity.ino);
    if (!profile) profile = await loadProfile(plan);
    if (!credentials)
      credentials = JSON.parse(
        (
          await privateProcess(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              script("v2-development-test-credentials.ps1"),
              "-Directory",
              root,
            ],
            Buffer.alloc(0),
            4096,
            { ...osEnv(), DARKPOOL_DEV_REHEARSAL: "1" },
          )
        ).toString(),
      );
    await verifyFixtureStop(plan, credentials.maintenance);
    await privateProcess(
      join(repo, ".tools/pgsql/bin/pg_ctl.exe"),
      ["-D", plan.data, "-m", "fast", "-t", "20", "-w", "stop"],
      Buffer.alloc(0),
      4096,
    );
    await assert.rejects(access(join(plan.data, "postmaster.pid")));
    await loadProfile(plan);
    await storage("check", root);
    await rm(root, { recursive: true, force: false });
    await assert.rejects(access(root));
    cleaned = true;
  } finally {
    process.stdout.write(
      "DEVELOPMENT_REHEARSAL_EVIDENCE " +
        JSON.stringify({
          root,
          port: plan.port,
          database: plan.database,
          system_identifier: profile?.system_identifier,
          kind: profile?.kind,
          financial_authorized: false,
          cleaned,
        }) +
        "\n",
    );
    assert.equal(
      cleaned,
      true,
      "Identity-uncertain disposable resources retained for review",
    );
  }
});

test("fixed development plan uses 55435 with separate identity, paths, roles and no financial grants", () => {
  const p = developmentPlan();
  assert.equal(p.port, 55435);
  assert.equal(p.kind, "DEVELOPMENT_ONLY");
  assert.equal(p.financial_authorized, false);
  assert.equal(p.product_schema_installed, false);
  assert.notEqual(p.root, p.live_root);
  assert.match(p.root, /postgres-development/);
  assert.deepEqual(p.capabilities, ["READ_DEVELOPMENT_STATUS"]);
});
test("protected ports, paths and changed plans reject before any target access", () => {
  for (const port of [5432, 55432, 55433, 55434, 55435, undefined])
    assert.throws(() => disposablePlan(root, port));
  for (const candidate of [
    developmentPlan().live_root,
    join(root, "child"),
    join(tmpdir(), "unregistered"),
  ])
    assert.throws(() => disposablePlan(candidate, plan.port));
  assert.throws(() => validatePlan({ ...developmentPlan(), root: plan.root }));
  assert.throws(() => validatePlan({ ...plan, port: 55435 }));
  assert.throws(() => validatePlan({ ...plan, financial_authorized: true }));
});
test("status preserves unavailable off-device backup and NOT FINANCIALLY AUTHORIZED", async () => {
  const status = await verifyDevelopment(
    plan,
    credentials.maintenance,
    credentials.read,
  );
  assert.equal(status.backup_status, "OFF_DEVICE_UNAVAILABLE");
  assert.equal(status.financial_authorized, false);
  assert.equal(status.classification, "NOT FINANCIALLY AUTHORIZED");
  assert.equal(profile.backup_status, "OFF_DEVICE_UNAVAILABLE");
  assert.equal(profile.kind, "DEVELOPMENT_ONLY");
  assert.notEqual(credentials.read, credentials.maintenance);
});
test("fresh roles have one privileged bootstrap, one restricted reader and a passwordless NOLOGIN owner", async () => {
  assert.equal(
    await sql(
      `SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolpassword IS NULL FROM pg_authid WHERE rolname='${plan.roles.owner}';`,
    ),
    "t",
  );
  assert.equal(
    await sql("SELECT count(*) FROM pg_roles WHERE rolcanlogin;"),
    "2",
  );
  assert.equal(await sql("SELECT current_user;", true), plan.roles.read);
});
test("no product schema, ticket, market, deposit, commitment or payout record can be inherited", async () => {
  assert.equal(
    await sql(
      "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%';",
    ),
    "0",
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='development_only';",
    ),
    "2",
  );
  assert.equal(
    await sql("SELECT count(*) FROM development_only.boundary;"),
    "1",
  );
  for (const name of [
    "tickets",
    "markets",
    "accepted_payments",
    "ledger_records",
    "payout_intents",
  ]) {
    assert.equal(
      await sql(`SELECT to_regclass('public.${name}') IS NULL;`),
      "t",
    );
  }
});
test("no wallet, signer or watcher storage or key material is initialized", async () => {
  const names = await readdir(root);
  for (const name of [
    "wallets",
    "protected",
    "signer",
    "watcher",
    "wallet.sqlite",
    "data.sqlite",
    "keys.toml",
  ]) {
    assert.equal(names.includes(name), false);
  }
  assert.equal(names.includes("owner.xml"), false);
  assert.ok(names.includes("NOT_FINANCIALLY_AUTHORIZED.txt"));
  assert.throws(() =>
    liveWalletPath({ DARKPOOL_PG_ENV: "DEVELOPMENT_ONLY" }, "signer"),
  );
});
test("read role cannot create fundable tickets, mutate data or reactivate owner", async () => {
  for (const command of [
    "CREATE TABLE public.tickets(id text);",
    "INSERT INTO development_only.boundary VALUES(2,'NOT FINANCIALLY AUTHORIZED',false,'OFF_DEVICE_UNAVAILABLE','{}');",
    `ALTER ROLE "${plan.roles.owner}" LOGIN;`,
    "CREATE SCHEMA darkpool_issuance;",
    "SELECT * FROM development_only.boundary;",
  ]) {
    await assert.rejects(sql(command, true));
  }
  assert.equal(
    await sql(
      "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%';",
    ),
    "0",
  );
});
test("financial label is immutable even through ordinary maintenance DML", async () => {
  for (const command of [
    "UPDATE development_only.boundary SET financial_authorized=true;",
    "DELETE FROM development_only.boundary;",
    "TRUNCATE development_only.boundary;",
  ]) {
    await assert.rejects(sql(command));
  }
  assert.equal(
    await sql(
      "SELECT financial_authorized FROM development_only.status;",
      true,
    ),
    "f",
  );
});
const runtime = () => ({
  ...osEnv(),
  APP_ENV: "development",
  ZCASH_NETWORK: "testnet",
  DARKPOOL_PG_ENV: "DEVELOPMENT_ONLY",
  DARKPOOL_PG_PROFILE: plan.profile,
  PGHOST: "127.0.0.1",
  PGPORT: String(plan.port),
  PGDATABASE: plan.database,
  PGUSER: plan.roles.read,
  PGPASSWORD: credentials.read,
  DARKPOOL_ISSUANCE_INTERNAL: "1",
  DARKPOOL_WATCHER_INTERNAL: "1",
  DARKPOOL_LOCK_INTERNAL: "1",
});
test("issuance and watcher acceptance reject development configuration", async () => {
  await assert.rejects(issuanceQuery("SELECT 1;", runtime()));
  await assert.rejects(watcherQuery("SELECT 1;", runtime()));
});
test("payout execution sessions and LIVE setup reject development configuration", async () => {
  await assert.rejects(
    withPayoutSession(runtime(), () => {
      throw new Error("UNREACHABLE");
    }),
  );
  assert.throws(() => v2Plan(runtime()));
  await assert.rejects(loadEnvironmentGuard(runtime()));
  for (const kind of ["TEST", "LIVE_EVIDENCE"]) {
    await assert.rejects(
      loadEnvironmentGuard({
        ...runtime(),
        DARKPOOL_PG_ENV: kind,
        DARKPOOL_LIVE_INSTANCE:
          kind === "LIVE_EVIDENCE" ? "phase9_payment_v2" : undefined,
        DARKPOOL_TEST_ONLY: kind === "TEST" ? "TEST_ONLY" : undefined,
      }),
    );
  }
});
test("development profile tampering and attempted authorization upgrade fail closed", async () => {
  const original = await readFile(plan.profile);
  try {
    for (const fields of [
      { kind: "LIVE_EVIDENCE" },
      { financial_authorized: true },
      { system_identifier: "1234567890123456789" },
      { data_directory: join(root, "different") },
    ]) {
      await writeFile(plan.profile, JSON.stringify({ ...profile, ...fields }));
      await assert.rejects(loadProfile(plan));
    }
  } finally {
    await writeFile(plan.profile, original);
  }
});
test("DPAPI credentials and all fixture files retain restricted Windows ACLs", async () => {
  await storage("check", root);
  for (const name of ["maintenance.xml", "read.xml"]) {
    const bytes = await readFile(join(root, name));
    assert.equal(bytes.includes(Buffer.from(credentials.read)), false);
    assert.equal(bytes.includes(Buffer.from(credentials.maintenance)), false);
  }
});
test("missing development acknowledgement refuses before root creation", async () => {
  const other = join(
    tmpdir(),
    "darkpool-backup-fixture-" + randomBytes(16).toString("hex"),
  );
  await assert.rejects(
    privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script("v2-development.ps1"),
        "-Create",
        "-DisposableRehearsal",
        "-RehearsalRoot",
        other,
        "-RehearsalPort",
        String(plan.port),
      ],
      Buffer.alloc(0),
      4096,
      { ...osEnv(), DARKPOOL_DEV_REHEARSAL: "1" },
    ),
  );
  await assert.rejects(access(other));
});
test("existing LIVE_EVIDENCE backup acknowledgement still refuses an unacknowledged apply", async () => {
  await assert.rejects(
    privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script("v2-setup.ps1"),
        "-Instance",
        "phase9_payment_v2",
        "-Apply",
      ],
      Buffer.alloc(0),
      4096,
      osEnv(),
    ),
  );
});
test("existing root cannot be adopted or converted", async () => {
  await assert.rejects(
    privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script("v2-development.ps1"),
        "-Create",
        "-DevelopmentOnlyAcknowledged",
        "-DisposableRehearsal",
        "-RehearsalRoot",
        root,
        "-RehearsalPort",
        String(plan.port),
      ],
      Buffer.alloc(0),
      4096,
      { ...osEnv(), DARKPOOL_DEV_REHEARSAL: "1" },
    ),
  );
  assert.equal((await loadProfile(plan)).kind, "DEVELOPMENT_ONLY");
});

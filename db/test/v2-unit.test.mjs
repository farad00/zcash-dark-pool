import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { v2Plan, rehearsalPlan, validateOperation } from "../v2-target.mjs";
import {
  unifiedMigrationFiles,
  validateMigrationSet,
  migrationDigest,
} from "../v2-migrations.mjs";
import { scramVerifier } from "../v2-provision.mjs";

const sample = () => {
  const env = {
    LOCALAPPDATA: join(tmpdir(), "v2-offline-not-created"),
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    DARKPOOL_PG_ENV: "TEST",
    DARKPOOL_TEST_ONLY: "TEST_ONLY",
  };
  const plan = rehearsalPlan(env, "darkpool_phase9_0123456789abcdef");
  Object.assign(env, {
    PGHOST: "127.0.0.1",
    PGPORT: "55433",
    PGDATABASE: plan.database,
    PGUSER: plan.roles.owner,
    PGPASSWORD: "synthetic",
  });
  return { env, plan };
};
test("fixed V2 plan has disjoint target, roles and wallet paths without creation", () => {
  const plan = v2Plan({
    LOCALAPPDATA: join(tmpdir(), "v2-plan-only"),
    DARKPOOL_PG_ENV: "LIVE_EVIDENCE",
    DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2",
  });
  assert.equal(plan.port, 55435);
  assert.equal(plan.database, "darkpool_phase9_evidence_payment_v2");
  assert.equal(plan.roles.owner, "darkpool_live_v2_owner");
  assert.equal(plan.resource_creation, false);
  assert.ok(plan.signer.endsWith(join("protected", "signer")));
  assert.notEqual(plan.signer, plan.watcher);
});
for (const kind of ["HISTORICAL", "TEST", undefined])
  test(`V2 refuses ${kind} selection`, () => {
    assert.throws(
      () =>
        v2Plan({
          LOCALAPPDATA: tmpdir(),
          DARKPOOL_PG_ENV: kind,
          DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2",
        }),
      /V2_TARGET/,
    );
  });
test("V2 rejects preserved instance, missing instance and TEST acknowledgement", () => {
  for (const extra of [
    { DARKPOOL_LIVE_INSTANCE: "phase9_payment_v1" },
    {},
    {
      DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2",
      DARKPOOL_TEST_ONLY: "TEST_ONLY",
    },
  ])
    assert.throws(
      () =>
        v2Plan({
          LOCALAPPDATA: tmpdir(),
          DARKPOOL_PG_ENV: "LIVE_EVIDENCE",
          ...extra,
        }),
      /V2_TARGET/,
    );
});
test("Node TEST execution cannot authorize the real V2 operation path", () => {
  const env = {
    LOCALAPPDATA: join(tmpdir(), "v2-test-cannot-apply"),
    DARKPOOL_PG_ENV: "LIVE_EVIDENCE",
    DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2",
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    PGHOST: "127.0.0.1",
    PGPORT: "55435",
    PGDATABASE: "darkpool_phase9_evidence_payment_v2",
    PGUSER: "darkpool_live_v2_owner",
    PGPASSWORD: "synthetic",
  };
  assert.throws(
    () => validateOperation(v2Plan(env), env, "owner"),
    /V2_TARGET/,
  );
});
for (const port of [undefined, "5432", "55432", "55434", "55435"])
  test(`TEST operation rejects port ${port} before I/O`, () => {
    const { env, plan } = sample();
    assert.throws(
      () => validateOperation(plan, { ...env, PGPORT: port }, "owner"),
      /V2_TARGET/,
    );
  });
test("explicit correct fixture operation is accepted but forged plan/database/login are not", () => {
  const { env, plan } = sample();
  assert.deepEqual(validateOperation(plan, env, "owner"), plan);
  for (const changed of [
    { ...env, PGDATABASE: "postgres" },
    { ...env, PGDATABASE: "darkpool_phase9_evidence_payment_v2" },
    { ...env, PGUSER: plan.roles.maintenance },
    { ...env, PGPASSWORD: undefined },
  ])
    assert.throws(() => validateOperation(plan, changed, "owner"), /V2_TARGET/);
  assert.throws(
    () => validateOperation({ ...plan, port: 55434 }, env, "owner"),
    /V2_TARGET/,
  );
});
test("libpq/service/executable/connection-string override attempts fail closed", () => {
  const { env, plan } = sample();
  for (const key of [
    "PGOPTIONS",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGHOSTADDR",
    "PGPASSFILE",
    "PGSSLMODE",
    "DATABASE_URL",
    "PSQL_PATH",
  ])
    assert.throws(
      () => validateOperation(plan, { ...env, [key]: "untrusted" }, "owner"),
      /V2_TARGET/,
    );
});
test("fixture selectors cannot authorize retained or V2 database names", () => {
  const { env } = sample();
  for (const db of [
    "postgres",
    "darkpool_phase9_evidence_payment_v1",
    "darkpool_phase9_evidence_payment_v2",
    "darkpool_product_dev",
  ])
    assert.throws(() => rehearsalPlan(env, db), /V2_TARGET/);
});
test("all 13 actual migration files are ordered across both source directories", async () => {
  const files = await unifiedMigrationFiles();
  assert.equal(files.length, 13);
  assert.deepEqual(
    files.map((f) => Number(f.name.slice(0, 4))),
    Array.from({ length: 13 }, (_, i) => i + 1),
  );
  assert.equal(migrationDigest(files), migrationDigest([...files].reverse()));
});
test("missing, duplicate, unknown and malformed migration identifiers reject", async () => {
  const files = await unifiedMigrationFiles();
  for (const invalid of [
    files.slice(1),
    [...files, files[0]],
    [files[0], ...files.slice(0, 12)],
    [...files.slice(0, 12), { ...files[12], name: "0014_unapproved.sql" }],
    [...files.slice(0, 12), { ...files[12], name: "0013_unsafe-name.sql" }],
  ])
    assert.throws(() => validateMigrationSet(invalid), /V2_MIGRATION_SET/);
});
test("SCRAM verifiers use fresh salts and never contain plaintext credential", () => {
  const password = "ab".repeat(32),
    a = scramVerifier(password),
    b = scramVerifier(password);
  assert.notEqual(a, b);
  assert.match(a, /^SCRAM-SHA-256\$4096:/);
  assert.ok(!a.includes(password));
  assert.throws(() => scramVerifier("synthetic-invalid"), /V2_TARGET/);
});
test("synthetic protected ACL and retained DPAPI credential rehearsal", async () => {
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./v2-storage.test.ps1", import.meta.url)),
    ],
    { timeoutMs: 20000, maxBytes: 4096 },
  );
  assert.equal(boundedExit(result), 0, "isolated storage rehearsal failed");
  assert.equal(result.stdout.trim(), "V2_SYNTHETIC_STORAGE_PASS");
});

test("actual provisioning CLI plan lists 13 migrations without resource creation", async () => {
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("../../scripts/dev/v2-setup.ps1", import.meta.url)),
      "-Instance",
      "phase9_payment_v2",
      "-Plan",
    ],
    { timeoutMs: 20000, maxBytes: 16384 },
  );
  assert.equal(boundedExit(result), 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.port, 55435);
  assert.equal(plan.migrations.length, 13);
  assert.equal(plan.resource_creation, false);
  assert.equal(plan.creates_cluster, false);
  assert.equal(plan.creates_wallets, false);
});
test("apply without recovery acknowledgement is refused before credential access", async () => {
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("../../scripts/dev/v2-setup.ps1", import.meta.url)),
      "-Instance",
      "phase9_payment_v2",
      "-Apply",
    ],
    { timeoutMs: 20000, maxBytes: 4096 },
  );
  assert.notEqual(boundedExit(result), 0);
  assert.equal(result.stdout.trim(), "V2_SETUP_REJECTED_OR_UNCONFIRMED");
});

test("plan output redacts inherited synthetic protected-target credentials", async () => {
  const secret = "df".repeat(32);
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("../../scripts/dev/v2-setup.ps1", import.meta.url)),
      "-Instance",
      "phase9_payment_v2",
      "-Plan",
    ],
    {
      timeoutMs: 20000,
      maxBytes: 16384,
      env: {
        ...process.env,
        PGHOST: "127.0.0.1",
        PGPORT: "55434",
        PGDATABASE: "darkpool_phase9_evidence_payment_v1",
        PGUSER: "synthetic_only",
        PGPASSWORD: secret,
      },
    },
  );
  assert.equal(boundedExit(result), 0);
  assert.equal(JSON.parse(result.stdout).port, 55435);
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stderr.includes(secret));
});

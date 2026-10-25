// Offline fixtures are ordinary temporary files: no PostgreSQL or socket access.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  environmentLayout,
  validateEnvironment,
  assertClusterIdentity,
  assertFixtureSql,
  markerText,
  loadEnvironmentGuard,
  guardedSql,
} from "../environment.mjs";
import { psql } from "../test-fixtures.mjs";
import { watcherQuery } from "../../services/watcher/db.mjs";
import { issuanceQuery } from "../issuance-runtime.mjs";
import { createPublicReader } from "../public-read.mjs";
const sample = (kind = "TEST") => {
  const base = join(tmpdir(), "darkpool-isolation-offline");
  const instance = kind === "LIVE_EVIDENCE" ? "phase9_payment_v1" : undefined;
  const layout = environmentLayout(kind, base, instance);
  const profile = {
    version: 1,
    kind,
    cluster_id: randomUUID(),
    host: "127.0.0.1",
    port: layout.port,
    data_directory: layout.data,
    system_identifier: "7654321098765432101",
    directory_identity: { dev: "1", ino: "2" },
    maintenance_user: layout.maintenance,
  };
  const env = {
    LOCALAPPDATA: base,
    DARKPOOL_PG_ENV: kind,
    ...(instance === undefined ? {} : { DARKPOOL_LIVE_INSTANCE: instance }),
    DARKPOOL_PG_PROFILE: layout.profile,
    DARKPOOL_TEST_ONLY: kind === "TEST" ? "TEST_ONLY" : undefined,
    PGHOST: "127.0.0.1",
    PGPORT: String(layout.port),
    PGUSER: layout.maintenance,
    PGDATABASE: layout.database,
  };
  return { layout, profile, env };
};
const reject = (profile, env, options = {}) =>
  assert.throws(
    () =>
      validateEnvironment(profile, env, { requireKind: "TEST", ...options }),
    /POSTGRES_TARGET_REJECTED/,
  );
test("TEST positive identity and fixture targets are admitted", () => {
  const { profile, env, layout } = sample();
  assert.equal(
    validateEnvironment(profile, env, { requireKind: "TEST" }).port,
    55433,
  );
  assertClusterIdentity(profile, { ...profile, marker: markerText(profile) });
  for (const name of [
    "darkpool_phase3_aabbccddeeff0011",
    "darkpool_phase4_open_aabbccddeeff0011",
    "darkpool_phase7_boundary_aabbccddeeff0011",
  ]) {
    assert.equal(
      validateEnvironment(profile, env, { database: name }).data,
      layout.data,
    );
    assertFixtureSql(`CREATE DATABASE "${name}"; DROP DATABASE "${name}";`);
  }
});
test("HISTORICAL kind, port, path and database are independently rejected", () => {
  const { profile, env } = sample();
  reject(
    { ...profile, kind: "HISTORICAL" },
    { ...env, DARKPOOL_PG_ENV: "HISTORICAL" },
  );
  reject(profile, { ...env, PGPORT: "55432" });
  reject(
    {
      ...profile,
      data_directory: join(
        env.LOCALAPPDATA,
        "ZcashDarkPoolDev",
        "postgres",
        "data",
      ),
    },
    env,
  );
  reject(profile, {
    ...env,
    PGDATABASE: "darkpool_phase9_evidence_manual_20261007_a",
  });
});
test("LIVE kind, port, path and database are independently rejected by TEST", () => {
  const { profile, env } = sample(),
    live = sample("LIVE_EVIDENCE");
  reject(live.profile, live.env);
  reject(profile, { ...env, PGPORT: "55434" });
  reject({ ...profile, data_directory: live.layout.data }, env);
  reject(profile, { ...env, PGDATABASE: live.layout.database });
});
test("missing acknowledgement, marker kind and unexpected targets fail closed", () => {
  const { profile, env } = sample();
  for (const value of [undefined, "", "1", "test_only"])
    reject(profile, { ...env, DARKPOOL_TEST_ONLY: value });
  reject(profile, { ...env, DARKPOOL_PG_ENV: "LIVE_EVIDENCE" });
  reject(profile, {
    ...env,
    DARKPOOL_PG_PROFILE: join(tmpdir(), "wrong-profile.json"),
  });
  for (const name of [
    "darkpool_product_dev",
    "template1",
    "unrelated",
    "darkpool_phase9_bad",
  ])
    reject(profile, { ...env, PGDATABASE: name });
  for (const key of [
    "PGHOSTADDR",
    "PGOPTIONS",
    "PGSERVICE",
    "PGSERVICEFILE",
    "DATABASE_URL",
  ])
    reject(profile, { ...env, [key]: "unexpected" });
});
test("destructive fixture names reject retained and LIVE databases/roles", () => {
  for (const name of [
    "postgres",
    "darkpool_product_dev",
    "darkpool_phase9_evidence_payment_v1",
    "darkpool_phase9_evidence_payment_v2",
    "darkpool_phase9_live_payment_v1",
  ]) {
    assert.throws(
      () => assertFixtureSql(`DROP DATABASE IF EXISTS "${name}";`),
      /POSTGRES_TARGET_REJECTED/,
    );
    assert.throws(
      () => assertFixtureSql(`CREATE DATABASE "${name}";`),
      /POSTGRES_TARGET_REJECTED/,
    );
  }
  assert.throws(
    () => assertFixtureSql("DROP ROLE darkpool_live_watch;"),
    /POSTGRES_TARGET_REJECTED/,
  );
  assertFixtureSql(
    'CREATE ROLE "darkpool_watch_aabbccddeeff0011" NOLOGIN; DROP ROLE "darkpool_watch_aabbccddeeff0011";',
  );
});
test("actual-server system ID, path, port and marker mismatches reject", () => {
  const { profile } = sample(),
    facts = { ...profile, marker: markerText(profile) };
  for (const patch of [
    { system_identifier: "7654321098765432102" },
    { data_directory: join(tmpdir(), "other") },
    { port: 55432 },
    { marker: "{}" },
  ])
    assert.throws(
      () => assertClusterIdentity(profile, { ...facts, ...patch }),
      /POSTGRES_TARGET_REJECTED/,
    );
  const sql = guardedSql({ prefix: "GUARD\n" }, "DELETE FROM fixture;");
  assert.ok(sql.startsWith("GUARD\n"));
  assert.ok(sql.endsWith("\\else\n\\quit 3\n\\endif\n"));
});
test("local profile/control/marker identities checked without SQL", async () => {
  const base = await mkdtemp(join(tmpdir(), "darkpool-isolation-"));
  try {
    const { profile, env } = sample();
    env.LOCALAPPDATA = base;
    const layout = environmentLayout("TEST", base);
    env.DARKPOOL_PG_PROFILE = layout.profile;
    profile.data_directory = layout.data;
    await mkdir(join(layout.data, "global"), { recursive: true });
    const info = await stat(layout.data);
    profile.directory_identity = {
      dev: String(info.dev),
      ino: String(info.ino),
    };
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(profile.system_identifier));
    await writeFile(join(layout.data, "global", "pg_control"), bytes);
    const save = async () => {
      await writeFile(layout.profile, JSON.stringify(profile));
      await writeFile(layout.marker, markerText(profile));
    };
    await save();
    const guard = await loadEnvironmentGuard(env, { requireKind: "TEST" });
    assert.match(guard.prefix, /inet_server_port\(\)=55433/);
    assert.match(guard.prefix, /shobj_description/);
    bytes.writeBigUInt64LE(BigInt(profile.system_identifier) + 1n);
    await writeFile(join(layout.data, "global", "pg_control"), bytes);
    await assert.rejects(loadEnvironmentGuard(env), /POSTGRES_TARGET_REJECTED/);
    bytes.writeBigUInt64LE(BigInt(profile.system_identifier));
    await writeFile(join(layout.data, "global", "pg_control"), bytes);
    await writeFile(layout.marker, "{}");
    await assert.rejects(loadEnvironmentGuard(env), /POSTGRES_TARGET_REJECTED/);
    await save();
    profile.directory_identity.ino = "0";
    await writeFile(layout.profile, JSON.stringify(profile));
    await assert.rejects(loadEnvironmentGuard(env), /POSTGRES_TARGET_REJECTED/);
    await rm(layout.marker);
    await assert.rejects(loadEnvironmentGuard(env));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("query clients reject HISTORICAL before spawning psql", async () => {
  const env = {
    ...process.env,
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    PGHOST: "127.0.0.1",
    PGPORT: "55432",
    PGUSER: "darkpool_watch_fixture",
    PGDATABASE: "darkpool_phase9_evidence_forbidden",
    DARKPOOL_PG_ENV: "HISTORICAL",
    PSQL_PATH: "must-never-spawn",
  };
  await assert.rejects(
    watcherQuery("SELECT 1", { ...env, DARKPOOL_WATCHER_INTERNAL: "1" }),
    /WATCHER_UNAVAILABLE/,
  );
  await assert.rejects(
    issuanceQuery("SELECT 1", { ...env, DARKPOOL_ISSUANCE_INTERNAL: "1" }),
    /ISSUANCE_UNAVAILABLE/,
  );
  await assert.rejects(createPublicReader(env), /Market unavailable/);
  const before = {};
  for (const key of ["DARKPOOL_PG_ENV", "PGPORT", "PSQL_PATH"])
    before[key] = process.env[key];
  try {
    process.env.DARKPOOL_PG_ENV = "HISTORICAL";
    process.env.PGPORT = "55432";
    process.env.PSQL_PATH = "must-never-spawn";
    await assert.rejects(
      psql("DROP DATABASE darkpool_product_dev;", { database: "postgres" }),
      /POSTGRES_TARGET_REJECTED/,
    );
  } finally {
    for (const [key, value] of Object.entries(before))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
  }
});

// Disposable TEST databases only. No physical cluster copy, V2 or live adapter.
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  loadEnvironmentGuard,
  guardedSql,
  assertFixtureSql,
} from "../../db/environment.mjs";
import { assertSynthetic, privateProcess, LIMIT, reject } from "./crypto.mjs";

const binary = (name) =>
  fileURLToPath(new URL(`../../.tools/pgsql/bin/${name}.exe`, import.meta.url));
const cleanEnv = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([k]) =>
      ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].includes(k),
    ),
  );
export async function fixtureCommand(sql, env) {
  assertSynthetic(env);
  if (
    !/^darkpool_phase9_[a-f0-9]{16}$/.test(env.PGDATABASE) ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "55433" ||
    !env.PGPASSWORD
  )
    reject();
  assertFixtureSql(sql);
  const target = await loadEnvironmentGuard(env, {
    database: env.PGDATABASE,
    requireKind: "TEST",
  });
  const ack = "BACKUP_FIXTURE_ACK_" + randomBytes(32).toString("hex");
  const output = await privateProcess(
    binary("psql"),
    [
      "--no-psqlrc",
      "--no-password",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "--dbname",
      env.PGDATABASE,
    ],
    Buffer.from(
      guardedSql(
        target,
        `SET statement_timeout='20s'; SET synchronous_commit=on; SET TIME ZONE 'UTC';\n${sql}\n;\nSELECT '${ack}';`,
      ),
    ),
    LIMIT,
    { ...cleanEnv(env), PGCONNECT_TIMEOUT: "3" },
  );
  const lines = output.toString("utf8").trim().split(/\r?\n/);
  if (lines.pop() !== ack) reject();
  return lines.join("\n").trim();
}
export async function dumpFixture(env) {
  await fixtureCommand("SELECT current_database();", env);
  // pg_dump owns its consistent MVCC snapshot. This rehearsal has no writers.
  const bytes = await privateProcess(
    binary("pg_dump"),
    ["--no-password", "--format=custom", "--dbname", env.PGDATABASE],
    Buffer.alloc(0),
    LIMIT / 2,
    { ...cleanEnv(env), PGCONNECT_TIMEOUT: "3" },
  );
  await fixtureCommand("SELECT current_database();", env);
  return bytes;
}
export async function renderFixtureRestore(bytes) {
  assertSynthetic();
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT / 2) reject();
  // Offline rendering: no database, credential or network environment in child.
  return privateProcess(binary("pg_restore"), ["--file=-"], bytes, LIMIT);
}

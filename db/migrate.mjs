import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMutableTarget } from "./target-registry.mjs";
import {
  loadEnvironmentGuard,
  guardedSql,
  assertFixtureSql,
} from "./environment.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

// Credentials come from libpq environment/service configuration, never argv/logs.
// Do not echo server diagnostics: PostgreSQL DETAIL can contain private row data.
export async function psql(
  sql,
  {
    database = process.env.PGDATABASE,
    applicationName = "darkpool-schema",
    requireKind,
  } = {},
) {
  if (!database) throw new Error("Set PGDATABASE explicitly");
  const target = await loadEnvironmentGuard(process.env, {
    database,
    requireKind,
  });
  if (requireKind === "TEST") assertFixtureSql(sql);
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.env.PSQL_PATH || "psql",
      [
        "--no-psqlrc",
        "--no-password",
        "--quiet",
        "--no-align",
        "--tuples-only",
        "--set=ON_ERROR_STOP=1",
        "--set=VERBOSITY=sqlstate",
        "--dbname",
        database,
      ],
      {
        env: { ...process.env, PGAPPNAME: applicationName },
        windowsHide: true,
      },
    );
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", () => reject(new Error("Unable to start psql")));
    child.stdin.on("error", () => {}); // Exit handler reports closed-connection failures.
    child.on("close", (code) => {
      if (code === 0) resolveResult(output.trim());
      else {
        const state =
          /ERROR:\s+([0-9A-Z]{5})\b/.exec(error)?.[1] ||
          "CONNECTION_OR_CLIENT_ERROR";
        const failure = new Error(`psql failed (${state})`);
        failure.sqlstate = state;
        reject(failure);
      }
    });
    child.stdin.end(guardedSql(target, sql));
  });
}

export async function migrationFiles() {
  const directory = join(root, "migrations");
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(directory, name), "utf8"),
    })),
  );
}

export function migrationScript(files) {
  // One transaction covers journal bootstrap and all pending DDL. Concurrent
  // runners serialize before testing applied status. Changed history fails closed.
  let sql = `BEGIN;
SET LOCAL TIME ZONE 'UTC';
SELECT pg_advisory_xact_lock(1146110284, 3);
CREATE SCHEMA IF NOT EXISTS darkpool_migrations;
REVOKE ALL ON SCHEMA darkpool_migrations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS darkpool_migrations.applied (
  name text COLLATE "C" PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL
);
REVOKE ALL ON darkpool_migrations.applied FROM PUBLIC;
`;
  const knownNames = files.map((file) => literal(file.name)).join(",");
  sql += `DO $migration$ BEGIN
IF EXISTS (SELECT 1 FROM darkpool_migrations.applied WHERE ${knownNames ? `name NOT IN (${knownNames})` : "true"}) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'applied migration missing from source history';
END IF;
END $migration$;\n`;
  for (const file of files) {
    const hash = createHash("sha256").update(file.sql, "utf8").digest("hex");
    sql += `DO $migration$ BEGIN
IF EXISTS (SELECT 1 FROM darkpool_migrations.applied WHERE name = ${literal(file.name)} AND sha256 <> ${literal(hash)}) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'migration checksum mismatch';
END IF;
END $migration$;
SELECT NOT EXISTS (SELECT 1 FROM darkpool_migrations.applied WHERE name = ${literal(file.name)}) AS migration_pending \\gset
\\if :migration_pending
${file.sql}
INSERT INTO darkpool_migrations.applied VALUES (${literal(file.name)}, ${literal(hash)}, clock_timestamp());
\\endif
`;
  }
  return sql + "COMMIT;\n";
}

export async function migrate(options) {
  assertMutableTarget();
  await psql(migrationScript(await migrationFiles()), options);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await migrate();
    console.log(
      "PASS: product migrations applied / unchanged history verified",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Fixed one-time initialization of NEW isolated clusters; no arbitrary SQL API.
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  environmentLayout,
  markerText,
  loadEnvironmentGuard,
  assertClusterIdentity,
} from "./environment.mjs";
import { runBounded, boundedExit } from "../scripts/dev/run-bounded.mjs";
import { assertMutableTarget } from "./target-registry.mjs";
const layout = environmentLayout(
  process.env.DARKPOOL_PG_ENV,
  process.env.LOCALAPPDATA,
  process.env.DARKPOOL_LIVE_INSTANCE,
);
const command = process.argv[2];
if (command !== "check") assertMutableTarget();
async function query(sql) {
  const result = await runBounded(
    process.env.PSQL_PATH || "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "-d",
      "postgres",
    ],
    {
      timeoutMs: 8000,
      env: { ...process.env, PGCONNECT_TIMEOUT: "3" },
      input: "SET statement_timeout='5s'; SET lock_timeout='1s';\n" + sql,
    },
  );
  if (boundedExit(result) !== 0) throw Error("CLUSTER_IDENTITY_QUERY_FAILED");
  return result.stdout.trim();
}
if (command === "profile") {
  if ((await realpath(layout.data)).toLowerCase() !== layout.data.toLowerCase())
    throw Error("POSTGRES_TARGET_REJECTED");
  const info = await stat(layout.data);
  const bytes = await readFile(join(layout.data, "global", "pg_control"));
  const profile = {
    version: 1,
    kind: process.env.DARKPOOL_PG_ENV,
    ...(layout.instance === undefined ? {} : { instance: layout.instance }),
    cluster_id: randomUUID(),
    host: "127.0.0.1",
    port: layout.port,
    data_directory: layout.data,
    system_identifier: bytes.readBigUInt64LE().toString(),
    directory_identity: { dev: String(info.dev), ino: String(info.ino) },
    maintenance_user: layout.maintenance,
  };
  await writeFile(layout.profile, JSON.stringify(profile, null, 2) + "\n", {
    flag: "wx",
  });
  await writeFile(layout.marker, markerText(profile) + "\n", { flag: "wx" });
} else if (command === "initialize-marker") {
  const target = await loadEnvironmentGuard();
  if (
    process.env.PGUSER !== layout.maintenance ||
    process.env.PGDATABASE !== "postgres"
  )
    throw Error("POSTGRES_TARGET_REJECTED");
  const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
  // The actual server identity must match BEFORE the sole marker mutation.
  const sql = `SELECT current_user=${literal(layout.maintenance)} AND current_database()='postgres'
    AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=${layout.port}
    AND (SELECT system_identifier::text FROM pg_control_system())=${literal(target.profile.system_identifier)}
    AND lower(replace(current_setting('data_directory'),chr(92),'/'))=lower(${literal(layout.data.replaceAll("\\", "/"))})
    AND COALESCE(shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database'),'') IN ('','default administrative connection database') AS verified \\gset
\\if :verified
COMMENT ON DATABASE postgres IS ${literal(markerText(target.profile))};
\\else
\\quit 3
\\endif
`;
  await query(sql);
} else if (!["check", "complete"].includes(command))
  throw Error("Unknown bootstrap command");
if (command !== "profile") {
  const target = await loadEnvironmentGuard();
  if (
    process.env.PGUSER !== layout.maintenance ||
    process.env.PGDATABASE !== "postgres"
  )
    throw Error("POSTGRES_TARGET_REJECTED");
  const { guardedSql } = await import("./environment.mjs");
  const facts = JSON.parse(
    await query(
      guardedSql(
        target,
        `BEGIN READ ONLY; SELECT json_build_object('version',version(),'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),'data_directory',current_setting('data_directory'),'port',inet_server_port(),'marker',shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database'),'timezone',current_setting('TimeZone'),'listen_addresses',current_setting('listen_addresses'),'password_encryption',current_setting('password_encryption')); COMMIT;`,
      ),
    ),
  );
  assertClusterIdentity(target.profile, facts);
  if (command === "complete") {
    // Plain strings/JSON only. Get-Content strings carry a provider object graph
    // that Windows PowerShell ConvertTo-Json traverses at depth 8.
    const pid = (
      await readFile(join(layout.data, "postmaster.pid"), "utf8")
    ).split(/\r?\n/)[0];
    if (!/^[1-9][0-9]*$/.test(pid))
      throw Error("Invalid PostgreSQL PID record");
    const configuration = {};
    for (const name of [
      "postgresql.conf",
      "pg_hba.conf",
      "pg_ident.conf",
      "postgresql.auto.conf",
    ])
      configuration[name] = createHash("sha256")
        .update(await readFile(join(layout.data, name)))
        .digest("hex");
    await writeFile(
      join(layout.root, "startup-evidence.json"),
      JSON.stringify(
        {
          timestamp_utc: new Date().toISOString(),
          kind: target.profile.kind,
          version: facts.version,
          port: facts.port,
          startup_pid: pid,
          profile: target.profile,
          configuration,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log("PASS: isolated startup evidence recorded");
  } else console.log(JSON.stringify(facts));
}

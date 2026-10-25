// Nonfinancial bootstrap only. Not an accepted environment for product runtimes.
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile, stat, lstat, readdir } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { approvedTarget, rejectRedirects } from "./target-registry.mjs";
import { scramVerifier } from "./v2-provision.mjs";
import { privateProcess } from "../services/backup/crypto.mjs";

const fail = () => {
  throw new Error("V2_DEVELOPMENT_REJECTED");
};
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const binary = (name) =>
  fileURLToPath(new URL(`../.tools/pgsql/bin/${name}.exe`, import.meta.url));
const security = fileURLToPath(
  new URL("../scripts/dev/v2-security.ps1", import.meta.url),
);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonicalPath = (p) => resolve(p).toLowerCase();
export function developmentPlan(base = process.env.LOCALAPPDATA) {
  if (typeof base !== "string" || !base || !/^([a-z]:[\\/]|\/)/i.test(base))
    fail();
  const root = resolve(
    base,
    "ZcashDarkPoolDev",
    "postgres-development",
    "phase9_payment_v2",
  );
  const live = approvedTarget("LIVE_EVIDENCE", base, "phase9_payment_v2");
  if (
    /(?:^|[\\/])onedrive(?:[\\/]|$)/i.test(root) ||
    root
      .toLowerCase()
      .startsWith(fileURLToPath(new URL("../", import.meta.url)).toLowerCase())
  )
    fail();
  return Object.freeze({
    version: 1,
    kind: "DEVELOPMENT_ONLY",
    instance: "phase9_payment_v2",
    execution: "DEVELOPMENT_ONLY",
    financial_authorized: false,
    backup_status: "OFF_DEVICE_UNAVAILABLE",
    root,
    data: join(root, "data"),
    profile: join(root, "development-profile.json"),
    port: 55435,
    database: "darkpool_phase9_development_payment_v2",
    roles: {
      maintenance: "darkpool_v2dev_maintenance",
      owner: "darkpool_v2dev_owner",
      read: "darkpool_v2dev_read",
    },
    live_root: live.root,
    capabilities: ["READ_DEVELOPMENT_STATUS"],
    product_schema_installed: false,
  });
}
export function disposablePlan(root, port) {
  if (
    process.env.DARKPOOL_DEV_REHEARSAL !== "1" ||
    typeof root !== "string" ||
    canonicalPath(dirname(root)) !== canonicalPath(tmpdir()) ||
    !/^darkpool-backup-fixture-[a-f0-9]{32}$/.test(basename(root)) ||
    !Number.isInteger(port) ||
    port < 49152 ||
    port > 65535 ||
    [55432, 55433, 55434, 55435].includes(port)
  )
    fail();
  const fixed = developmentPlan(),
    suffix = basename(root).slice(-16);
  return {
    ...fixed,
    execution: "DISPOSABLE_REHEARSAL",
    root: resolve(root),
    data: join(resolve(root), "data"),
    profile: join(resolve(root), "development-profile.json"),
    port,
    database: "darkpool_development_" + suffix,
    roles: {
      maintenance: "darkpool_devmaint_" + suffix,
      owner: "darkpool_devowner_" + suffix,
      read: "darkpool_devread_" + suffix,
    },
    live_root: null,
  };
}
export function validatePlan(plan) {
  const expected =
    plan?.execution === "DISPOSABLE_REHEARSAL"
      ? disposablePlan(plan.root, plan.port)
      : developmentPlan();
  if (!same(plan, expected)) fail();
  return expected;
}
function cleanProcess() {
  if (
    Object.keys(process.env).some((k) => /^PG/i.test(k)) ||
    process.env.DATABASE_URL ||
    process.env.DARKPOOL_PG_ENV ||
    process.env.DARKPOOL_PG_PROFILE ||
    process.env.DARKPOOL_LIVE_INSTANCE ||
    process.env.DARKPOOL_TEST_ONLY ||
    process.env.WALLET_DB_PATH ||
    (process.env.ZCASH_NETWORK && process.env.ZCASH_NETWORK !== "testnet")
  )
    fail();
}
export async function checkStorage(plan) {
  validatePlan(plan);
  await rejectRedirects(plan.root);
  for (const credential of ["maintenance.xml", "read.xml"]) {
    await privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        security,
        "-Root",
        plan.root,
        "-Credential",
        credential,
      ],
      Buffer.alloc(0),
      4096,
    );
  }
}
export async function createProfile(plan) {
  cleanProcess();
  validatePlan(plan);
  await checkStorage(plan);
  const s = await stat(plan.data),
    control = await readFile(join(plan.data, "global", "pg_control"));
  const profile = {
    version: 1,
    kind: "DEVELOPMENT_ONLY",
    financial_authorized: false,
    backup_status: "OFF_DEVICE_UNAVAILABLE",
    instance: plan.instance,
    execution: plan.execution,
    system_identifier: control.readBigUInt64LE().toString(),
    cluster_id: randomUUID(),
    data_directory: plan.data,
    port: plan.port,
    host: "127.0.0.1",
    database: plan.database,
    maintenance_user: plan.roles.maintenance,
    directory_identity: { dev: String(s.dev), ino: String(s.ino) },
  };
  for (const kind of ["TEST", "LIVE_EVIDENCE"]) {
    const ids =
      kind === "TEST"
        ? [approvedTarget(kind, process.env.LOCALAPPDATA)]
        : [
            approvedTarget(kind, process.env.LOCALAPPDATA, "phase9_payment_v1"),
            approvedTarget(kind, process.env.LOCALAPPDATA, "phase9_payment_v2"),
          ];
    if (
      ids.some(
        (t) =>
          t.expected_system_identifier === profile.system_identifier ||
          t.reserved_system_identifiers.includes(profile.system_identifier),
      )
    )
      fail();
  }
  await writeFile(plan.profile, JSON.stringify(profile), { flag: "wx" });
  return profile;
}
export async function loadProfile(plan) {
  validatePlan(plan);
  await checkStorage(plan);
  if ((await lstat(plan.profile)).isSymbolicLink()) fail();
  const p = JSON.parse(await readFile(plan.profile, "utf8")),
    s = await stat(plan.data);
  if (
    p.kind !== "DEVELOPMENT_ONLY" ||
    p.financial_authorized !== false ||
    p.backup_status !== "OFF_DEVICE_UNAVAILABLE" ||
    p.version !== 1 ||
    p.instance !== plan.instance ||
    p.execution !== plan.execution ||
    p.database !== plan.database ||
    p.port !== plan.port ||
    p.host !== "127.0.0.1" ||
    p.data_directory !== plan.data ||
    p.maintenance_user !== plan.roles.maintenance ||
    !same(p.directory_identity, { dev: String(s.dev), ino: String(s.ino) }) ||
    (await readFile(join(plan.data, "global", "pg_control")))
      .readBigUInt64LE()
      .toString() !== p.system_identifier ||
    (await readdir(join(plan.data, "pg_tblspc"))).length
  )
    fail();
  await rejectRedirects(plan.data);
  await rejectRedirects(join(plan.data, "pg_wal"));
  return p;
}
async function query(
  plan,
  password,
  sql,
  { database = plan.database, reader = false, bootstrap = false } = {},
) {
  cleanProcess();
  const p = await loadProfile(plan);
  if (
    !/^[a-f0-9]{64}$/.test(password) ||
    !["postgres", plan.database].includes(database) ||
    (reader && database !== plan.database)
  )
    fail();
  const login = reader ? plan.roles.read : plan.roles.maintenance,
    ack = "development_ack_" + randomBytes(24).toString("hex");
  const guard = `DO $guard$ BEGIN IF current_user<>session_user OR session_user<>${quote(login)} OR current_database()<>${quote(database)} OR inet_server_addr()<>'127.0.0.1'::inet OR inet_server_port()<>${plan.port}${reader ? "" : ` OR lower(replace(current_setting('data_directory'),chr(92),'/'))<>${quote(plan.data.replaceAll("\\", "/").toLowerCase())} OR (SELECT system_identifier::text FROM pg_control_system())<>${quote(p.system_identifier)} OR current_setting('log_statement')<>'none' OR current_setting('log_min_error_statement')<>'panic'`}${bootstrap ? ` OR COALESCE(shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database'),'') NOT IN ('','default administrative connection database'${bootstrap === "stop" ? "," + quote(JSON.stringify(p)) : ""})` : ` OR shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database') IS DISTINCT FROM ${quote(JSON.stringify(p))}`} THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='development identity mismatch';END IF;END $guard$;`;
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
      database,
    ],
    Buffer.from(
      `SET statement_timeout='10s';SET synchronous_commit=on;SET TIME ZONE 'UTC';\n${guard}\n${sql}\n;SELECT '${ack}';`,
    ),
    1024 * 1024,
    {
      PGHOST: "127.0.0.1",
      PGPORT: String(plan.port),
      PGDATABASE: database,
      PGUSER: login,
      PGPASSWORD: password,
      PGCONNECT_TIMEOUT: "3",
      PGCLIENTENCODING: "UTF8",
    },
  );
  const lines = output.toString().trim().split(/\r?\n/);
  if (lines.pop() !== ack) fail();
  return lines.join("\n");
}
export async function installDevelopment(plan, maintenance, reader) {
  validatePlan(plan);
  const p = await loadProfile(plan);
  const rolePassword = scramVerifier(reader);
  await query(
    plan,
    maintenance,
    `COMMENT ON DATABASE postgres IS ${quote(JSON.stringify(p))};`,
    { database: "postgres", bootstrap: true },
  );
  await query(
    plan,
    maintenance,
    `BEGIN;CREATE ROLE "${plan.roles.owner}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE "${plan.roles.read}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quote(rolePassword)};COMMIT;`,
    { database: "postgres" },
  );
  await query(
    plan,
    maintenance,
    `CREATE DATABASE "${plan.database}" OWNER "${plan.roles.owner}" TEMPLATE template0 ENCODING 'UTF8';`,
    { database: "postgres" },
  );
  await query(
    plan,
    maintenance,
    `BEGIN;REVOKE ALL ON DATABASE "${plan.database}" FROM PUBLIC;GRANT CONNECT ON DATABASE "${plan.database}" TO "${plan.roles.read}";SET LOCAL ROLE "${plan.roles.owner}";REVOKE ALL ON SCHEMA public FROM PUBLIC;CREATE SCHEMA development_only;REVOKE ALL ON SCHEMA development_only FROM PUBLIC;
 CREATE TABLE development_only.boundary(version integer PRIMARY KEY CHECK(version=1),classification text NOT NULL CHECK(classification='NOT FINANCIALLY AUTHORIZED'),financial_authorized boolean NOT NULL CHECK(NOT financial_authorized),backup_status text NOT NULL CHECK(backup_status='OFF_DEVICE_UNAVAILABLE'),profile jsonb NOT NULL);
 INSERT INTO development_only.boundary VALUES(1,'NOT FINANCIALLY AUTHORIZED',false,'OFF_DEVICE_UNAVAILABLE',${quote(JSON.stringify(p))}::jsonb);
 CREATE FUNCTION development_only.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='immutable development boundary';END$$;REVOKE ALL ON FUNCTION development_only.reject_change() FROM PUBLIC;
 CREATE TRIGGER immutable_boundary BEFORE UPDATE OR DELETE OR TRUNCATE ON development_only.boundary FOR EACH STATEMENT EXECUTE FUNCTION development_only.reject_change();
 CREATE VIEW development_only.status AS SELECT version,classification,financial_authorized,backup_status FROM development_only.boundary;
 REVOKE ALL ON ALL TABLES IN SCHEMA development_only FROM PUBLIC;GRANT USAGE ON SCHEMA development_only TO "${plan.roles.read}";GRANT SELECT ON development_only.status TO "${plan.roles.read}";COMMIT;`,
  );
  return verifyDevelopment(plan, maintenance, reader);
}
export async function verifyDevelopment(plan, maintenance, reader) {
  const flags = JSON.parse(
    await query(
      plan,
      maintenance,
      `SELECT jsonb_build_object('product_schemas',(SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%'),'other_user_schemas',(SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema','public','development_only')),'owner_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname=${quote(plan.roles.owner)}),'reader_privileged',(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit FROM pg_roles WHERE rolname=${quote(plan.roles.read)}),'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${quote(plan.roles.read)})),'reader_create',has_database_privilege(${quote(plan.roles.read)},current_database(),'CREATE,TEMP'),'other_login_roles',(SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname NOT IN (${quote(plan.roles.maintenance)},${quote(plan.roles.read)})));`,
    ),
  );
  if (
    !same(flags, {
      product_schemas: 0,
      other_user_schemas: 0,
      owner_login: false,
      reader_privileged: false,
      memberships: 0,
      reader_create: false,
      other_login_roles: 0,
    })
  ) {
    // jsonb key order is independent of insertion order.
    const expected = {
      product_schemas: 0,
      other_user_schemas: 0,
      owner_login: false,
      reader_privileged: false,
      memberships: 0,
      reader_create: false,
      other_login_roles: 0,
    };
    if (Object.keys(expected).some((k) => flags[k] !== expected[k])) fail();
  }
  const status = JSON.parse(
    await query(
      plan,
      reader,
      "SELECT row_to_json(s) FROM development_only.status s;",
      { reader: true },
    ),
  );
  if (
    status.classification !== "NOT FINANCIALLY AUTHORIZED" ||
    status.financial_authorized !== false ||
    status.backup_status !== "OFF_DEVICE_UNAVAILABLE"
  )
    fail();
  return {
    ...status,
    kind: "DEVELOPMENT_ONLY",
    instance: plan.instance,
    port: plan.port,
    database: plan.database,
    root: plan.root,
    product_schema_installed: false,
  };
}
export async function fixtureQuery(plan, password, sql, reader = false) {
  if (
    plan.execution !== "DISPOSABLE_REHEARSAL" ||
    !process.env.NODE_TEST_CONTEXT
  )
    fail();
  return query(plan, password, sql, { reader });
}
export async function verifyFixtureStop(plan, password) {
  if (plan.execution !== "DISPOSABLE_REHEARSAL") fail();
  return query(plan, password, "SELECT 1;", {
    database: "postgres",
    bootstrap: "stop",
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const action = process.argv[2];
    let input = "";
    if (action !== "plan") {
      for await (const b of process.stdin) {
        input += b;
        if (input.length > 16384) fail();
      }
    }
    const value = input ? JSON.parse(input) : null;
    if (action === "plan")
      process.stdout.write(JSON.stringify(developmentPlan()) + "\n");
    else if (action === "fixture-plan")
      process.stdout.write(
        JSON.stringify(disposablePlan(value.root, value.port)) + "\n",
      );
    else if (action === "profile")
      process.stdout.write(
        JSON.stringify(await createProfile(validatePlan(value.plan))) + "\n",
      );
    else if (action === "install")
      process.stdout.write(
        JSON.stringify(
          await installDevelopment(value.plan, value.maintenance, value.read),
        ) + "\n",
      );
    else fail();
  } catch {
    process.stderr.write("V2 development initialization rejected\n");
    process.exitCode = 1;
  }
}

// Fixed-target design, executable ONLY through private disposable TEST capabilities.
// Reuses the existing physical-cluster harness; never imports a retained profile.
import { PhysicalFixture, storage } from "../../backup/physical.mjs";
import { digest } from "../../backup/crypto.mjs";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  lstat,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { rejectRedirects } from "../../../db/target-registry.mjs";
import { assertDisposable, provisioningPlan, reject } from "./policy.mjs";

const sessions = new WeakMap();
const quote = (v) => "'" + v.replaceAll("'", "''") + "'";
const json = (v) => quote(JSON.stringify(v)) + "::jsonb";
export async function durableNew(path, bytes) {
  await rejectRedirects(path);
  const h = await open(path, "wx", 0o600);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
}
const ino = (s) => `${s.dev}:${s.ino}`;
export async function session(cap) {
  assertDisposable();
  const s = sessions.get(cap);
  if (!s || s.disposed) reject();
  await s.f.owned();
  await rejectRedirects(s.f.source);
  await rejectRedirects(s.control);
  const stat = await lstat(s.control);
  if (
    !stat.isDirectory() ||
    ino(stat) !== s.controlIdentity ||
    (await readFile(join(s.control, "scope.json"), "utf8")) !== s.marker ||
    (await readFile(join(s.f.source, "pg_hba.conf"), "utf8")) !== s.hba
  )
    reject();
  return s;
}
export async function provisionDisposable(options = {}) {
  assertDisposable();
  if (!options || Object.keys(options).some((k) => k !== "fault")) reject();
  const { fault = null } = options;
  if (![null, "schema_transaction", "after_storage"].includes(fault)) reject();
  const f = new PhysicalFixture();
  // Reject an OS-selected collision BEFORE any PostgreSQL server can start.
  const fixtureStart = f.start.bind(f);
  f.start = async (which) => {
    if ([5432, 55432, 55433, 55434, 55435, 55436].includes(f.port)) reject();
    if (!["source", "restored"].includes(which)) reject();
    await rejectRedirects(f[which]);
    return fixtureStart(which);
  };
  try {
    await f.create();
    // The inherited helper never selects a registered target. Exclude the new
    // persistent port too, even in the extremely unlikely random-port collision.
    if ([5432, 55432, 55433, 55434, 55435, 55436].includes(f.port)) reject();
    await f.seed({
      profile: "OBSERVATION_V1_NONFINANCIAL_FIXTURE",
      financial_authorization: "NOT_GRANTED",
    });
    const context = {
      version: 1,
      instance: "testnet_observation_v1",
      mode: "DISPOSABLE_TEST_ONLY",
      state: "DRAFT",
      revision: "0",
      hold: false,
      acceptance: "NOT_EVALUATED",
      financial_authorization: "NOT_GRANTED",
      spending_enabled: false,
    };
    await f.sql(
      "source",
      `BEGIN;
      ALTER ROLE "${f.roles.owner}" NOLOGIN;
      ALTER ROLE "${f.roles.read}" SET default_transaction_read_only=on;
      REVOKE ALL ON SCHEMA recovery_probe FROM "${f.roles.read}";
      REVOKE ALL ON recovery_probe.safe_summary FROM "${f.roles.read}";
      CREATE SCHEMA darkpool_watcher AUTHORIZATION "${f.roles.owner}";
      REVOKE ALL ON SCHEMA darkpool_watcher FROM PUBLIC;
      SET LOCAL ROLE "${f.roles.owner}";
      CREATE TABLE darkpool_watcher.fixture_boundary(value jsonb NOT NULL);
      INSERT INTO darkpool_watcher.fixture_boundary VALUES(${json(context)});
      CREATE FUNCTION darkpool_watcher.context() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog AS $$SELECT value FROM darkpool_watcher.fixture_boundary$$;
      REVOKE ALL ON FUNCTION darkpool_watcher.context() FROM PUBLIC;
      CREATE FUNCTION darkpool_watcher.immutable_fixture() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog AS $$BEGIN RAISE EXCEPTION 'immutable nonfinancial boundary'; END$$;
      REVOKE ALL ON FUNCTION darkpool_watcher.immutable_fixture() FROM PUBLIC;
      CREATE TRIGGER immutable_boundary BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
        ON darkpool_watcher.fixture_boundary FOR EACH STATEMENT EXECUTE FUNCTION darkpool_watcher.immutable_fixture();
      RESET ROLE;
      GRANT USAGE ON SCHEMA darkpool_watcher TO "${f.roles.read}";
      GRANT EXECUTE ON FUNCTION darkpool_watcher.context() TO "${f.roles.read}";
      ${["issue", "watch", "operator"].map((p) => `CREATE ROLE "darkpool_obs_${p}_${f.nonce.slice(0, 16)}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`).join("\n")}
      ${fault === "schema_transaction" ? "SELECT 1/0;" : ""}
      COMMIT;`,
    );
    const hba = `host postgres ${f.roles.admin} 127.0.0.1/32 scram-sha-256\nhost ${f.database} ${f.roles.admin},${f.roles.read} 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n`;
    await f.stop("source");
    await writeFile(join(f.source, "pg_hba.conf"), hba);
    await f.start("source");
    const control = join(f.root, "observation-controller");
    await mkdir(control);
    const marker = JSON.stringify({
      version: 1,
      scope: "DISPOSABLE_TEST_ONLY",
      nonce: f.nonce,
      system_identifier: f.systemId,
      port: f.port,
      database: f.database,
      descriptor_sha256: provisioningPlan().descriptor_sha256,
    });
    await durableNew(join(control, "scope.json"), Buffer.from(marker));
    // Deliberately NOT a maintained wallet DB, UFVK, seed or native wallet fixture.
    await durableNew(
      join(control, "synthetic-viewer.json"),
      Buffer.from(
        JSON.stringify({
          profile: "NOT_A_WALLET_SYNTHETIC_JOURNAL",
          nonce: f.nonce,
          observations: [],
          allocations: [],
          spending_keys: false,
          financial_authorization: "NOT_GRANTED",
        }),
      ),
    );
    await storage("check", f.root);
    const cap = Object.freeze({
      scope: "DISPOSABLE_TEST_ONLY",
      instance: "testnet_observation_v1",
      nonce: f.nonce,
      root: f.root,
      port: f.port,
      database: f.database,
      system_identifier: f.systemId,
      control,
      descriptor_sha256: provisioningPlan().descriptor_sha256,
    });
    sessions.set(cap, {
      f,
      control,
      controlIdentity: ino(await lstat(control)),
      marker,
      hba,
      active: false,
      disposed: false,
      context,
    });
    if (fault === "after_storage")
      throw Error("OBSERVATION_V1_SYNTHETIC_INTERRUPTION");
    return cap;
  } catch {
    let rollbackVerified = false;
    if (fault === "schema_transaction" && f.running === "source") {
      try {
        const state = JSON.parse(
          await f.sql(
            "source",
            `SELECT jsonb_build_object(
          'schemas',(SELECT count(*) FROM pg_namespace WHERE nspname='darkpool_watcher'),
          'owner_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname=${quote(f.roles.owner)}),
          'new_roles',(SELECT count(*) FROM pg_roles WHERE rolname IN (${["issue", "watch", "operator"].map((p) => quote(`darkpool_obs_${p}_${f.nonce.slice(0, 16)}`)).join(",")})));`,
          ),
        );
        rollbackVerified =
          state.schemas === 0 &&
          state.owner_login === true &&
          state.new_roles === 0;
      } catch {
        /* Never infer rollback from cleanup alone. */
      }
    }
    const result = await f.cleanup();
    const e = Error("OBSERVATION_V1_PROVISION_FAILED");
    e.cleanup = result; // Public identities only, never SQL or synthetic passwords.
    e.rollback_verified = rollbackVerified;
    throw e;
  }
}
export async function verifyDisposable(cap, which = "source") {
  const { f, context } = await session(cap);
  if (!["source", "restored"].includes(which)) reject();
  const actual = JSON.parse(
    await f.sql(
      which,
      "BEGIN READ ONLY;SELECT darkpool_watcher.context();COMMIT;",
      "read",
    ),
  );
  if (
    JSON.stringify(actual) === "" ||
    Object.keys(context).length !== Object.keys(actual).length ||
    Object.keys(context).some((k) => context[k] !== actual[k])
  )
    reject();
  const checks = JSON.parse(
    await f.sql(
      which,
      `SELECT jsonb_build_object(
    'owner_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname=${quote(f.roles.owner)}),
    'context_privileged',(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit FROM pg_roles WHERE rolname=${quote(f.roles.read)}),
    'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${quote(f.roles.read)})),
    'database_write',has_database_privilege(${quote(f.roles.read)},current_database(),'CREATE,TEMP'),
    'table_access',has_table_privilege(${quote(f.roles.read)},'darkpool_watcher.fixture_boundary','SELECT,INSERT,UPDATE,DELETE'),
    'private_schema',has_schema_privilege(${quote(f.roles.read)},'recovery_probe','USAGE'),
    'product_tables',(SELECT count(*) FROM pg_class WHERE relname IN ('tickets','markets','receipts','claims','payout_intents')));`,
    ),
  );
  if (Object.values(checks).some((v) => v !== false && v !== 0)) reject();
  return Object.freeze({
    status: "DISPOSABLE_PROVISION_VERIFIED",
    owner_login: false,
    runtime_access: "CONTEXT_FUNCTION_ONLY",
    product_migrations: false,
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
  });
}
// Literal negative probes only. No caller-selected SQL/credentials/executable.
export async function denialProbe(cap, name) {
  const { f } = await session(cap);
  const probes = {
    table: "SELECT * FROM darkpool_watcher.fixture_boundary;",
    create: "CREATE TABLE public.forbidden(id int);",
    mutation: "UPDATE darkpool_watcher.fixture_boundary SET value='{}';",
    owner: `SET ROLE "${f.roles.owner}";`,
    acceptance: "SELECT darkpool_watcher.reconcile();",
    payout: "SELECT darkpool_claims.reserve();",
    other_database: "SELECT 1;",
  };
  if (!Object.hasOwn(probes, name)) reject();
  return f.sql(
    "source",
    probes[name],
    "read",
    name === "other_database" ? "postgres" : f.database,
  );
}
export async function controllerInventory(cap) {
  const { control } = await session(cap);
  const files = [];
  for (const name of (await readdir(control)).sort()) {
    if (
      !/^(scope\.json|synthetic-viewer\.json|controller\.lease|(?:allocation|scan|observation)-(?:attempt|child|completed)\.json)$/.test(
        name,
      )
    )
      reject();
    const path = join(control, name);
    await rejectRedirects(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768) reject();
    const bytes = await readFile(path);
    files.push({
      path: name,
      sha256: digest(bytes),
      bytes: bytes.toString("base64"),
    });
  }
  return files;
}
export async function disposeDisposable(cap) {
  const s = await session(cap);
  if (s.active) reject();
  const result = await s.f.cleanup();
  if (result.cleaned) s.disposed = true;
  return result;
}

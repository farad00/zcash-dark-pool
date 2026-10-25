import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psql } from "../test-fixtures.mjs";
import { markerText } from "../environment.mjs";
import { rehearsalPlan, purposes, queryTarget } from "../v2-target.mjs";
import {
  provisionProduct,
  preflightProvision,
  scramVerifier,
} from "../v2-provision.mjs";
import { migrateProduct } from "../v2-migrations.mjs";
import { privilegeChecks } from "../v2-privileges.mjs";

const maintenance = { ...process.env };
assert.equal(maintenance.DARKPOOL_PG_ENV, "TEST");
assert.equal(maintenance.PGPORT, "55433");
assert.equal(maintenance.PGDATABASE, "postgres");

const fixture = async (work, provision = true) => {
  const database = "darkpool_phase9_" + randomBytes(8).toString("hex");
  const plan = rehearsalPlan(maintenance, database);
  const credentials = Object.fromEntries(
    purposes.map((p) => [p, randomBytes(32).toString("hex")]),
  );
  const envFor = (purpose) => ({
    ...maintenance,
    PGDATABASE: database,
    PGUSER: plan.roles[purpose],
    PGPASSWORD: credentials[purpose],
  });
  const adminSql = (sql) => psql(sql, { database });
  assert.equal(
    await psql(
      `SELECT
   (SELECT count(*) FROM pg_database WHERE datname='${database}')+
   (SELECT count(*) FROM pg_roles WHERE rolname IN (${purposes.map((p) => `'${plan.roles[p]}'`).join(",")}));`,
      { database: "postgres" },
    ),
    "0",
  );
  try {
    if (provision) await provisionProduct(plan, credentials, maintenance);
    return await work({
      plan,
      credentials,
      envFor,
      adminSql,
      database,
      owner: envFor("owner"),
    });
  } finally {
    // Only this newly generated database and its exact generated roles.
    await psql(`DROP DATABASE IF EXISTS "${database}";`, {
      database: "postgres",
    });
    await psql(
      purposes.map((p) => `DROP ROLE IF EXISTS "${plan.roles[p]}";`).join("\n"),
      { database: "postgres" },
    );
  }
};
const denied = (promise, state) =>
  assert.rejects(
    promise,
    (e) =>
      e.message === "V2_DATABASE_REJECTED" && (!state || e.sqlstate === state),
  );
const inspect = async (f) =>
  JSON.parse(
    await f.adminSql(`SELECT json_build_object(
 'journal',(SELECT json_agg(t ORDER BY name) FROM darkpool_migrations.applied t),
 'seal',(SELECT row_to_json(s) FROM darkpool_v2_setup.schema_seal s));`),
  );

test("clean provisioning authenticates five independent restricted roles and applies all 13", async () =>
  fixture(async (f) => {
    assert.equal(
      (await preflightProvision(f.plan, maintenance)).roles_present,
      5,
    );
    const result = await migrateProduct(f.plan, f.owner);
    assert.equal(result.migrations, 13);
    assert.equal(
      await queryTarget(
        f.plan,
        f.owner,
        "owner",
        "SELECT current_setting('synchronous_commit');",
      ),
      "on",
    );
    const data = await inspect(f);
    assert.equal(data.journal.length, 13);
    for (const name of [
      "markets",
      "tickets",
      "ledger_records",
      "publication_policies",
      "oracle_authorities",
      "claim_reservations",
      "payout_intents",
      "payout_operator_requests",
    ])
      assert.equal(
        await f.adminSql(`SELECT count(*) FROM darkpool_private.${name};`),
        "0",
      );
    for (const [purpose, check] of Object.entries(privilegeChecks))
      assert.equal(
        await queryTarget(f.plan, f.envFor(purpose), purpose, check),
        "t",
      );
  }));
test("safe provisioning/migration re-entry preserves credentials, journal timestamps and seal", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    const original = await inspect(f);
    await provisionProduct(f.plan, f.credentials, maintenance);
    await migrateProduct(f.plan, f.owner);
    assert.deepEqual(await inspect(f), original);
  }));
test("concurrent unified runners serialize without duplicate migrations", async () =>
  fixture(async (f) => {
    const results = await Promise.all([
      migrateProduct(f.plan, f.owner),
      migrateProduct(f.plan, f.owner),
    ]);
    assert.equal(results.length, 2);
    assert.equal((await inspect(f)).journal.length, 13);
  }));
test("changed retained password fails rather than resetting existing SQL credentials", async () =>
  fixture(async (f) => {
    await denied(
      provisionProduct(
        f.plan,
        { ...f.credentials, owner: randomBytes(32).toString("hex") },
        maintenance,
      ),
    );
    await migrateProduct(f.plan, f.owner);
    assert.equal((await inspect(f)).journal.length, 13);
  }));
test("runtime users cannot migrate, create roles/databases, read secrets or gain settlement capabilities", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    for (const p of ["admin", "watch", "issue", "read"]) {
      await assert.rejects(migrateProduct(f.plan, f.envFor(p)), /V2_TARGET/);
      await denied(
        queryTarget(
          f.plan,
          f.envFor(p),
          p,
          "SELECT * FROM darkpool_private.claim_reservations;",
        ),
        "42501",
      );
      await denied(
        queryTarget(
          f.plan,
          f.envFor(p),
          p,
          "SELECT * FROM darkpool_v2_setup.schema_seal;",
        ),
        "42501",
      );
      assert.equal(
        await queryTarget(
          f.plan,
          f.envFor(p),
          p,
          "SELECT has_schema_privilege(current_user,'darkpool_publication','USAGE') OR has_schema_privilege(current_user,'darkpool_resolution','USAGE') OR has_schema_privilege(current_user,'darkpool_claims','USAGE');",
        ),
        "f",
      );
    }
    await denied(
      queryTarget(
        f.plan,
        f.owner,
        "owner",
        `CREATE ROLE "darkpool_v2forbidden_${f.database.slice(-16)}";`,
      ),
      "42501",
    );
    await denied(
      queryTarget(
        f.plan,
        f.owner,
        "owner",
        `CREATE DATABASE "darkpool_phase9_${randomBytes(8).toString("hex")}";`,
      ),
      "42501",
    );
  }));
test("conflicting applied checksum rejects without repairing journal", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    await f.adminSql(
      "UPDATE darkpool_migrations.applied SET sha256=repeat('0',64) WHERE name LIKE '0005_%';",
    );
    await denied(migrateProduct(f.plan, f.owner), "23514");
    assert.equal(
      await f.adminSql(
        "SELECT sha256 FROM darkpool_migrations.applied WHERE name LIKE '0005_%';",
      ),
      "0".repeat(64),
    );
  }));
test("missing history row fails closed and does not reapply existing DDL", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    await f.adminSql(
      "DELETE FROM darkpool_migrations.applied WHERE name LIKE '0007_%';",
    );
    await denied(migrateProduct(f.plan, f.owner));
    assert.equal(
      await f.adminSql("SELECT count(*) FROM darkpool_migrations.applied;"),
      "12",
    );
  }));
test("schema drift rejects rather than silently accepting changed tables", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    await f.adminSql(
      "ALTER TABLE darkpool_private.tickets ADD COLUMN synthetic_drift text;",
    );
    await denied(migrateProduct(f.plan, f.owner), "23514");
  }));
test("grant drift rejects before rerun can repair permissions", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    await f.adminSql(
      `REVOKE EXECUTE ON FUNCTION darkpool_watcher.context() FROM "${f.plan.roles.watch}";`,
    );
    await denied(migrateProduct(f.plan, f.owner), "23514");
    assert.equal(
      await f.adminSql(
        `SELECT has_function_privilege('${f.plan.roles.watch}','darkpool_watcher.context()','EXECUTE');`,
      ),
      "f",
    );
  }));
test("partial DDL failure at migration 0008 rolls back all prior DDL and journal", async () =>
  fixture(async (f) => {
    await f.adminSql(`CREATE FUNCTION pg_catalog.v2_synthetic_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$
   BEGIN IF current_query() LIKE '%CREATE TABLE darkpool_private.lock_requests%' THEN RAISE EXCEPTION 'synthetic injected failure'; END IF; END $$;
   CREATE EVENT TRIGGER v2_synthetic_fault ON ddl_command_start EXECUTE FUNCTION pg_catalog.v2_synthetic_fault();`);
    await denied(migrateProduct(f.plan, f.owner), "P0001");
    assert.equal(
      await f.adminSql(
        "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%';",
      ),
      "0",
    );
    await f.adminSql(
      "DROP EVENT TRIGGER v2_synthetic_fault; DROP FUNCTION pg_catalog.v2_synthetic_fault();",
    );
    assert.equal((await migrateProduct(f.plan, f.owner)).migrations, 13);
  }));
test("an existing unmarked database is never adopted", async () =>
  fixture(async (f) => {
    await f.adminSql(`COMMENT ON DATABASE "${f.database}" IS NULL;`);
    await denied(provisionProduct(f.plan, f.credentials, maintenance), "42501");
  }));
test("unrecognized preexisting role collision is not overwritten", async () =>
  fixture(async (f) => {
    await psql(
      `CREATE ROLE "${f.plan.roles.owner}" LOGIN NOINHERIT PASSWORD '${scramVerifier(f.credentials.owner)}';`,
      { database: "postgres" },
    );
    await denied(provisionProduct(f.plan, f.credentials, maintenance), "42501");
    assert.equal(
      await psql(
        `SELECT count(*) FROM pg_roles WHERE rolname='${f.plan.roles.admin}';`,
        { database: "postgres" },
      ),
      "0",
    );
  }, false));
test("elevated role or inherited membership fails closed", async () =>
  fixture(async (f) => {
    await f.adminSql(`ALTER ROLE "${f.plan.roles.issue}" CREATEROLE;`);
    await denied(provisionProduct(f.plan, f.credentials, maintenance), "42501");
    await f.adminSql(
      `ALTER ROLE "${f.plan.roles.issue}" NOCREATEROLE; GRANT "${f.plan.roles.owner}" TO "${f.plan.roles.issue}";`,
    );
    await denied(provisionProduct(f.plan, f.credentials, maintenance), "42501");
  }));
test("database CREATE/TEMP privilege escalation is rejected", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    await f.adminSql(
      `GRANT CREATE,TEMP ON DATABASE "${f.database}" TO "${f.plan.roles.issue}";`,
    );
    await denied(migrateProduct(f.plan, f.owner), "42501");
  }));
test("PUBLIC database access cannot be silently restored or adopted", async () =>
  fixture(async (f) => {
    await migrateProduct(f.plan, f.owner);
    await f.adminSql(`GRANT CONNECT ON DATABASE "${f.database}" TO PUBLIC;`);
    await denied(provisionProduct(f.plan, f.credentials, maintenance), "42501");
    await denied(migrateProduct(f.plan, f.owner), "42501");
  }));
test("wrong target database and all protected/default ports fail before SQL", async () =>
  fixture(async (f) => {
    for (const port of ["5432", "55432", "55434", "55435", undefined])
      await assert.rejects(
        migrateProduct(f.plan, { ...f.owner, PGPORT: port }),
        /V2_TARGET/,
      );
    for (const db of [
      "postgres",
      "darkpool_phase9_evidence_payment_v1",
      "darkpool_phase9_evidence_payment_v2",
    ])
      await assert.rejects(
        migrateProduct(f.plan, { ...f.owner, PGDATABASE: db }),
        /V2_TARGET/,
      );
    assert.equal(
      await f.adminSql(
        "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%';",
      ),
      "0",
    );
  }));
test("server cluster marker mismatch refuses a locally consistent synthetic profile", async () =>
  fixture(async (f) => {
    const base = await mkdtemp(join(tmpdir(), "darkpool-v2-fake-profile-"));
    try {
      const env = { ...f.owner, LOCALAPPDATA: base };
      const plan = rehearsalPlan(env, f.database);
      await mkdir(join(plan.data, "global"), { recursive: true });
      const info = await stat(plan.data);
      const profile = {
        version: 1,
        kind: "TEST",
        cluster_id: randomUUID(),
        host: "127.0.0.1",
        port: 55433,
        data_directory: plan.data,
        system_identifier: "7654321098765432101",
        maintenance_user: plan.maintenance,
        directory_identity: { dev: String(info.dev), ino: String(info.ino) },
      };
      await writeFile(plan.profile, JSON.stringify(profile));
      await writeFile(plan.marker, markerText(profile));
      const control = Buffer.alloc(8);
      control.writeBigUInt64LE(BigInt(profile.system_identifier));
      await writeFile(join(plan.data, "global", "pg_control"), control);
      env.DARKPOOL_PG_PROFILE = plan.profile;
      await denied(
        queryTarget(plan, env, "owner", "SELECT 1/0;"),
        "UNAVAILABLE",
      );
      control.writeBigUInt64LE(BigInt(profile.system_identifier) + 1n);
      await writeFile(join(plan.data, "global", "pg_control"), control);
      await assert.rejects(
        queryTarget(plan, env, "owner", "SELECT 1/0;"),
        /POSTGRES_TARGET_REJECTED/,
      );
      assert.equal(
        await f.adminSql(
          "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool_%';",
        ),
        "0",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }));
test("unsealed existing product schemas cannot be adopted", async () =>
  fixture(async (f) => {
    await f.adminSql("CREATE SCHEMA darkpool_unrecognized;");
    await denied(migrateProduct(f.plan, f.owner), "23514");
    assert.equal(
      await f.adminSql(
        "SELECT count(*) FROM pg_namespace WHERE nspname='darkpool_migrations';",
      ),
      "0",
    );
  }));

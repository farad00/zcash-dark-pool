import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { guardSql, guardedSql } from "../../../db/environment-identity.mjs";
import { migrate, psql } from "../../../db/test-fixtures.mjs";
import { provisionPublicScript } from "../../../db/public-provision.mjs";
import {
  publicPrivilegeCheck,
  createPublicReader,
} from "../../../db/public-read.mjs";
import {
  publicMarketKeys,
  projectPublicMarket,
} from "../src/public-market.mjs";
import { market, forbiddenFields } from "./public-fixtures.mjs";
const readPublicMarketRows = async (env) => (await createPublicReader(env))();

const suffix = randomBytes(8).toString("hex");
const database = `darkpool_phase5_${suffix}`,
  reader = `darkpool_public_${suffix}`;
const password = randomBytes(32).toString("hex"),
  maintenance = process.env.PGDATABASE;
const sql = (query) => psql(query, { database });
const runtimeEnv = () => {
  const env = {
    ...process.env,
    PGDATABASE: database,
    PGUSER: reader,
    PGPASSWORD: password,
    ZCASH_NETWORK: "testnet",
  };
  for (const key of [
    "PGOPTIONS",
    "PGSERVICE",
    "PGSERVICEFILE",
    "DATABASE_URL",
    "DARKPOOL_ADMIN_INTERNAL",
    "WALLET_DB_PATH",
  ])
    delete env[key];
  return env;
};
let created = false,
  roleCreated = false;
const configuration = {
  id: market.market_id,
  network: "testnet",
  vault_context_ref: "PRIVATE_VAULT_SENTINEL",
  question: market.question,
  yes_definition: market.yes_definition,
  no_definition: market.no_definition,
  opens_at: "2026-10-05T00:00:00.000Z",
  closes_at: "2026-10-06T00:00:00.000Z",
  close_policy_ref: "unreviewed",
  payment_policy_ref: "unreviewed",
  fee_policy_ref: "unreviewed",
  resolution_rule: market.resolution_rule,
  resolution_sources: market.resolution_sources,
  void_conditions: market.void_conditions,
  min_stake_zat: "1",
  max_stake_zat: "9007199254740993",
  zero_winner_policy: "NO_WINNER_REFUND",
  deposit_confirmations: null,
  payout_confirmations: null,
};
const wire = (value) =>
  `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("hex")}','hex'),'UTF8')::jsonb`;
before(async () => {
  assert.ok(maintenance);
  assert.match(database, /^darkpool_phase5_[a-f0-9]{16}$/);
  await psql(
    `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
    { database: maintenance },
  );
  created = true;
  await migrate({ database });
  await psql(
    `CREATE ROLE "${reader}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    { database: maintenance },
  );
  roleCreated = true;
  await sql(provisionPublicScript(reader));
});
after(async () => {
  if (created) {
    assert.match(database, /^darkpool_phase5_[a-f0-9]{16}$/);
    await psql(`DROP DATABASE "${database}";`, { database: maintenance });
  }
  if (roleCreated) {
    assert.match(reader, /^darkpool_public_[a-f0-9]{16}$/);
    await psql(`DROP ROLE "${reader}";`, { database: maintenance });
  }
});

// Actual authenticated reader; SET ROLE over maintenance alone cannot prove login isolation.
async function authenticated(query) {
  const oldUser = process.env.PGUSER,
    oldPassword = process.env.PGPASSWORD;
  try {
    process.env.PGUSER = reader;
    process.env.PGPASSWORD = password;
    return await sql(query);
  } finally {
    process.env.PGUSER = oldUser;
    process.env.PGPASSWORD = oldPassword;
  }
}
async function startWeb(env) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/server.mjs", import.meta.url))],
    {
      env: { ...env, PORT: "0" },
      windowsHide: true,
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stderr = "",
    stdout = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("test server startup timeout"));
    }, 10000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("test server unavailable"));
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error("test server exited"));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill();
      await closed;
      assert.equal(stderr, "");
      assert.match(stdout, /^Public web listening on 127\.0\.0\.1:\d+\r?\n$/);
    },
  };
}

test("INT01 / SEC04/12: restricted login privileges, private tables/functions/DML/escalation denied", async () => {
  assert.equal(await sql(publicPrivilegeCheck), "f");
  assert.equal(await authenticated(publicPrivilegeCheck), "t");
  const tables = (
    await sql(
      "SELECT tablename FROM pg_tables WHERE schemaname='darkpool_private' ORDER BY tablename;",
    )
  ).split(/\r?\n/);
  assert.equal(tables.length, 22); // Phase 9 adds only watcher_state/evidence.
  assert.ok(
    tables.includes("watcher_state") && tables.includes("watcher_evidence"),
  );
  for (const table of tables)
    await assert.rejects(
      authenticated(`SELECT * FROM darkpool_private.${table};`),
      (e) => e.sqlstate === "42501",
    );
  for (const query of [
    "SELECT * FROM darkpool_migrations.applied;",
    "SELECT darkpool_admin.command('open','{}');",
    "SELECT darkpool_admin.snapshot();",
    "SELECT darkpool_private.reject_mutation();",
    "SELECT darkpool_watcher.context();",
    "SELECT darkpool_watcher.reconcile(0,'{}');",
    "CREATE TABLE darkpool_public.forbidden(id int);",
    "CREATE TABLE public.forbidden(id int);",
    "CREATE SCHEMA forbidden;",
    "DELETE FROM darkpool_public.markets;",
    "UPDATE darkpool_public.markets SET question='changed';",
    "INSERT INTO darkpool_public.markets(id) VALUES ('forbidden');",
    "TRUNCATE darkpool_private.tickets;",
    "ALTER TABLE darkpool_private.markets DISABLE TRIGGER ALL;",
    `SET ROLE "${process.env.PGUSER}";`,
  ])
    await assert.rejects(authenticated(query), (e) => e.sqlstate === "42501");
  await assert.rejects(sql(provisionPublicScript(process.env.PGUSER)));
  assert.throws(() => provisionPublicScript('invalid"; SQL'));
});

test("FR-01: actual empty database read/page/API report market not found", async () => {
  assert.deepEqual(await readPublicMarketRows(runtimeEnv()), []);
  const web = await startWeb(runtimeEnv());
  try {
    for (const path of ["/", "/api/market"]) {
      const response = await fetch(web.base + path);
      assert.equal(response.status, 404);
      assert.ok((await response.text()).includes("Market not found"));
    }
  } finally {
    await web.stop();
  }
});

test("SEC04: authenticated reader has exactly the public application SELECT/schema surface and no app EXECUTE", async () => {
  const surface = JSON.parse(
    await authenticated(`SELECT jsonb_build_object(
   'schemas',(SELECT jsonb_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname LIKE 'darkpool%' AND has_schema_privilege(current_user,oid,'USAGE')),
   'selects',(SELECT jsonb_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool%' AND c.relkind IN ('r','v','p','m','f') AND has_table_privilege(current_user,c.oid,'SELECT')),
   'executes',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%' AND has_function_privilege(current_user,p.oid,'EXECUTE')));`),
  );
  assert.deepEqual(surface, {
    schemas: ["darkpool_public"],
    selects: ["darkpool_public.markets"],
    executes: 0,
  });
});

test("SEC04: bound real reader ignores later environment and supplied target arguments; HTTP cannot select targets", async () => {
  const env = runtimeEnv();
  const read = await createPublicReader(env);
  Object.assign(env, {
    PGHOST: "wrong",
    PGPORT: "1",
    PGDATABASE: "postgres",
    PGUSER: "owner",
    PGPASSWORD: "wrong",
    DARKPOOL_PG_ENV: "HISTORICAL",
    PSQL_PATH: "must-not-spawn",
  });
  assert.deepEqual(await read(env, "DROP DATABASE forbidden"), []);
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    assert.deepEqual(await read(), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const web = await startWeb(runtimeEnv());
  try {
    for (const field of [
      "PGHOST",
      "PGPORT",
      "PGDATABASE",
      "PGUSER",
      "PGPASSWORD",
      "DARKPOOL_PG_ENV",
      "DARKPOOL_PG_PROFILE",
      "PSQL_PATH",
    ]) {
      assert.equal(
        (await fetch(web.base + "/api/market?" + field + "=wrong")).status,
        400,
      );
      assert.equal(
        (
          await fetch(web.base + "/api/market", {
            headers: { [field]: "wrong" },
          })
        ).status,
        404,
      );
    }
    assert.equal(
      (
        await fetch(web.base + "/api/market", {
          method: "POST",
          body: JSON.stringify(env),
        })
      ).status,
      405,
    );
  } finally {
    await web.stop();
  }
});

test("SEC04: actual-server guard rejects wrong marker/system ID/database, reader rejects wrong database/role", async () => {
  const profile = JSON.parse(
    await readFile(process.env.DARKPOOL_PG_PROFILE, "utf8"),
  );
  for (const [candidate, expectedDatabase] of [
    [
      { ...profile, cluster_id: "00000000-0000-4000-8000-000000000000" },
      database,
    ],
    [
      {
        ...profile,
        system_identifier: String(BigInt(profile.system_identifier) + 1n),
      },
      database,
    ],
    [profile, "not_this_database"],
  ])
    // psql can quit successfully when a conditional guard refuses the read.
    // No sentinel result may escape; the public adapter also rejects empty JSON output.
    assert.equal(
      await authenticated(
        guardedSql(
          { prefix: guardSql(candidate, expectedDatabase) },
          "SELECT 1;",
        ),
      ),
      "",
    );
  for (const change of [
    { PGDATABASE: "postgres" },
    { PGDATABASE: "not_a_database" },
    { PGUSER: process.env.PGUSER, PGPASSWORD: process.env.PGPASSWORD },
  ])
    await assert.rejects(createPublicReader({ ...runtimeEnv(), ...change }), {
      message: "Market unavailable",
    });
});

test("SEC01: actual view/read/API/page omit private book populated alongside DRAFT market; reads never mutate", async () => {
  await sql(`INSERT INTO darkpool_private.policy_refs VALUES ('unreviewed','UNPINNED','TEST ONLY unresolved',NULL);
  SELECT darkpool_admin.command('create',${wire({ request_key: "phase5-fixture", expected_revision: null, configuration })});
  INSERT INTO darkpool_private.tickets VALUES ('PRIVATE_TICKET_SENTINEL',1,'${market.market_id}','PRIVATE_VAULT_SENTINEL','YES',
   735199,0,'PRIVATE_RECEIVER_SENTINEL','PRIVATE_DIVERSIFIER_SENTINEL',decode(repeat('ab',32),'hex'),
   'DARKPOOL_CLAIM_V1_ID_FRAME_1','PRIVATE_DEADLINE_SENTINEL','AWAITING_PAYMENT','unreviewed',NULL,now(),NULL);
  INSERT INTO darkpool_private.payment_receipts VALUES ('PRIVATE_RECEIPT_SENTINEL','${market.market_id}','PRIVATE_VAULT_SENTINEL',
   'testnet','PRIVATE_WALLET_RECEIPT_SENTINEL',decode(repeat('cd',32),'hex'),'IRONWOOD',0,'PRIVATE_TICKET_SENTINEL',
   'PRIVATE_RECEIVER_SENTINEL',735199,4454000,decode(repeat('ef',32),'hex'),'PRIVATE_CHAIN_SENTINEL','unreviewed',now());
  INSERT INTO darkpool_private.entitlements VALUES ('PRIVATE_ENTITLEMENT_SENTINEL','${market.market_id}','PRIVATE_TICKET_SENTINEL','ACCEPTED_STAKE',NULL,'unreviewed',735199);
  INSERT INTO darkpool_private.claims VALUES ('PRIVATE_CLAIM_SENTINEL',1,'${market.market_id}','PRIVATE_TICKET_SENTINEL','PRIVATE_ENTITLEMENT_SENTINEL',
   'PAYOUT',NULL,'PRIVATE_SCOPE_SENTINEL','PRIVATE_KEY_SENTINEL','unreviewed','PRIVATE_DESTINATION_SENTINEL','PRIVATE_VALIDATION_SENTINEL',735199,
   'UNCLAIMED',NULL,NULL,now(),now());`);
  const view = JSON.parse(
    await authenticated("SELECT jsonb_agg(m) FROM darkpool_public.markets m;"),
  );
  const expectedViewKeys = publicMarketKeys
    .map((key) => (key === "market_id" ? "id" : key))
    .sort();
  assert.deepEqual(Object.keys(view[0]).sort(), expectedViewKeys);
  const rows = await readPublicMarketRows(runtimeEnv());
  assert.deepEqual(Object.keys(rows[0]).sort(), [...publicMarketKeys].sort());
  for (const key of forbiddenFields)
    assert.equal(Object.hasOwn(view[0], key), false);
  const tables = (
    await sql(
      "SELECT tablename FROM pg_tables WHERE schemaname='darkpool_private' ORDER BY tablename;",
    )
  ).split("\n");
  const snapshot = async () =>
    Promise.all(
      tables.map((table) =>
        sql(
          `SELECT COALESCE(jsonb_agg(r ORDER BY r::text),'[]') FROM darkpool_private.${table} r;`,
        ),
      ),
    );
  const before = await snapshot();
  const web = await startWeb(runtimeEnv());
  try {
    for (const path of ["/", "/api/market"]) {
      const response = await fetch(web.base + path);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.doesNotMatch(
        body,
        /PRIVATE_.*SENTINEL|735199|9007199254740993|darkpool_private|unreviewed/,
      );
      for (const key of forbiddenFields) assert.ok(!body.includes(`"${key}"`));
      if (path === "/api/market")
        assert.deepEqual(JSON.parse(body), {
          market: projectPublicMarket(rows),
        });
      else {
        assert.ok(body.includes("DRAFT"));
        assert.ok(body.includes("not accepting predictions"));
      }
    }
    assert.equal(
      (await fetch(web.base + "/api/market", { method: "POST" })).status,
      405,
    );
    assert.equal(
      (await fetch(web.base + "/api/tickets", { method: "POST" })).status,
      404,
    );
  } finally {
    await web.stop();
  }
  assert.deepEqual(await snapshot(), before);
  const blocked = JSON.parse(
    await sql("SELECT darkpool_admin.command('open','{}');"),
  );
  assert.equal(blocked.result, "BLOCKED");
  assert.equal(
    await sql("SELECT status FROM darkpool_private.markets;"),
    "DRAFT",
  );
});

test("SEC04/12: owner, private-reader and admin authority rejected by actual public adapter", async () => {
  await assert.rejects(
    readPublicMarketRows({
      ...runtimeEnv(),
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    }),
    { message: "Market unavailable" },
  );
  for (const [grant, revoke] of [
    [
      `GRANT CREATE ON DATABASE "${database}" TO "${reader}";`,
      `REVOKE CREATE ON DATABASE "${database}" FROM "${reader}";`,
    ],
    [
      `GRANT USAGE ON SCHEMA darkpool_private TO "${reader}";`,
      `REVOKE USAGE ON SCHEMA darkpool_private FROM "${reader}";`,
    ],
    [
      `GRANT SELECT ON darkpool_private.tickets TO "${reader}";`,
      `REVOKE SELECT ON darkpool_private.tickets FROM "${reader}";`,
    ],
    [
      `GRANT EXECUTE ON FUNCTION darkpool_admin.command(text,jsonb) TO "${reader}";`,
      `REVOKE EXECUTE ON FUNCTION darkpool_admin.command(text,jsonb) FROM "${reader}";`,
    ],
    [
      `GRANT USAGE ON SCHEMA darkpool_watcher TO "${reader}";`,
      `REVOKE USAGE ON SCHEMA darkpool_watcher FROM "${reader}";`,
    ],
    [
      `GRANT EXECUTE ON FUNCTION darkpool_watcher.context() TO "${reader}";`,
      `REVOKE EXECUTE ON FUNCTION darkpool_watcher.context() FROM "${reader}";`,
    ],
    [
      `GRANT INSERT ON darkpool_public.markets TO "${reader}";`,
      `REVOKE INSERT ON darkpool_public.markets FROM "${reader}";`,
    ],
    [
      `GRANT pg_read_all_data TO "${reader}";`,
      `REVOKE pg_read_all_data FROM "${reader}";`,
    ],
    [
      `GRANT pg_read_all_data TO "${reader}" WITH INHERIT FALSE;`,
      `REVOKE pg_read_all_data FROM "${reader}";`,
    ],
  ]) {
    await sql(grant);
    try {
      await assert.rejects(readPublicMarketRows(runtimeEnv()), {
        message: "Market unavailable",
      });
      await assert.rejects(sql(provisionPublicScript(reader)));
    } finally {
      await sql(revoke);
    }
  }
  assert.equal(await authenticated(publicPrivilegeCheck), "t");
});

test("Malformed and multiple actual market rows fail closed; database faults sanitized over HTTP", async () => {
  const web = await startWeb(runtimeEnv());
  try {
    await sql("UPDATE darkpool_private.markets SET question=' ';");
    for (const path of ["/", "/api/market"])
      assert.equal((await fetch(web.base + path)).status, 503);
    await sql(`UPDATE darkpool_private.markets SET question='${market.question}';
      INSERT INTO darkpool_private.markets SELECT 'second-synthetic-market',version,network,'second-private-vault',question,yes_definition,no_definition,
      opens_at,closes_at,close_policy_ref,resolution_rule,resolution_sources,void_conditions,min_stake_zat,max_stake_zat,
      payment_policy_ref,fee_policy_ref,zero_winner_policy,deposit_confirmations,payout_confirmations,status,created_at,updated_at FROM darkpool_private.markets;`);
    assert.equal((await fetch(web.base + "/api/market")).status, 503);
    await sql(
      `DELETE FROM darkpool_private.markets WHERE id='second-synthetic-market'; REVOKE SELECT ON darkpool_public.markets FROM "${reader}";`,
    );
    try {
      for (const path of ["/", "/api/market"]) {
        const response = await fetch(web.base + path);
        assert.equal(response.status, 503);
        assert.doesNotMatch(
          await response.text(),
          /SQL|darkpool_|postgres|PRIVATE_|stack|password/,
        );
      }
    } finally {
      await sql(`GRANT SELECT ON darkpool_public.markets TO "${reader}";`);
    }
  } finally {
    await web.stop();
  }
  for (const change of [
    { PSQL_PATH: "missing-public-test-client" },
    { PGPORT: "1" },
    { PGPASSWORD: "incorrect-synthetic-test-password" },
  ]) {
    await assert.rejects(readPublicMarketRows({ ...runtimeEnv(), ...change }), {
      message: "Market unavailable",
    });
  }
});

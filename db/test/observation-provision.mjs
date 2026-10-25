// Extra ephemeral context-only login, within an existing disposable lifecycle fixture.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql } from "../test-fixtures.mjs";
import { assertSyntheticLifecycle } from "./lifecycle-fixtures.mjs";
import {
  createContextReader,
  contextPrivileges,
} from "../../services/observation-bridge/context.mjs";
export async function withObservationReader(f, work) {
  assertSyntheticLifecycle();
  const suffix = /^darkpool_phase9_([0-9a-f]{16})$/.exec(f.database)?.[1];
  if (!suffix) throw Error("OBSERVATION_TEST_ONLY");
  const role = "darkpool_observe_" + suffix,
    password = randomBytes(32).toString("hex");
  assert.equal(
    await psql(`SELECT count(*) FROM pg_roles WHERE rolname='${role}';`, {
      database: "postgres",
    }),
    "0",
  );
  let created = false,
    oid;
  try {
    await psql(
      `CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}';`,
      { database: "postgres" },
    );
    created = true;
    oid = await psql(
      `SELECT oid::text FROM pg_roles WHERE rolname='${role}';`,
      { database: "postgres" },
    );
    await f.sql(`BEGIN; GRANT USAGE ON SCHEMA darkpool_watcher TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_watcher.context() TO "${role}";
COMMIT;`);
    const env = {
      ...f.env("watch"),
      PGUSER: role,
      PGPASSWORD: password,
      DARKPOOL_OBSERVATION_ONLY: "1",
    };
    const reader = createContextReader(env);
    await work({ env, role, reader, privileges: contextPrivileges });
  } finally {
    if (created) {
      assert.equal(
        await psql(`SELECT oid::text FROM pg_roles WHERE rolname='${role}';`, {
          database: "postgres",
        }),
        oid,
        "context role cleanup identity",
      );
      await f.sql(
        `REVOKE ALL ON FUNCTION darkpool_watcher.context() FROM "${role}"; REVOKE ALL ON SCHEMA darkpool_watcher FROM "${role}";`,
      );
      await psql(`DROP ROLE "${role}";`, { database: "postgres" });
    }
  }
}

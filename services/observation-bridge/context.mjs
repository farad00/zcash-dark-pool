// Context-only transport. No watcher reconciliation or operational-target fallback.
import { openLockSession } from "../lock/db-session.mjs";
const fail = () => {
  throw new Error("OBSERVATION_UNAVAILABLE");
};
export const contextFunction = "darkpool_watcher.context()";
export const contextPrivileges = `SELECT current_user=session_user
 AND current_setting('transaction_read_only')='on'
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE
  (r.rolname=current_user AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
  OR (r.rolname<>current_user AND pg_has_role(current_user,r.oid,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
  AND (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')
   OR (nspname<>'darkpool_watcher' AND nspname LIKE 'darkpool%' AND has_schema_privilege(current_user,oid,'USAGE'))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','p','m','f')
   AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND has_schema_privilege(current_user,'darkpool_watcher','USAGE')
 AND has_function_privilege(current_user,'${contextFunction}','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%'
  AND p.oid<>'${contextFunction}'::regprocedure AND has_function_privilege(current_user,p.oid,'EXECUTE'))`;

export function assertContextTarget(env) {
  const suffix = /^darkpool_phase9_([a-f0-9]{16})$/.exec(
    env.PGDATABASE ?? "",
  )?.[1];
  if (
    !process.env.NODE_TEST_CONTEXT ||
    !suffix ||
    env.PGUSER !== "darkpool_observe_" + suffix ||
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.DARKPOOL_OBSERVATION_ONLY !== "1" ||
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.DARKPOOL_LIFECYCLE_TEST_ONLY !== "1" ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "55433" ||
    !env.PGPASSWORD ||
    !env.DARKPOOL_PG_PROFILE ||
    [
      "DARKPOOL_LIVE_INSTANCE",
      "WALLET_DB_PATH",
      "PGPASSFILE",
      "DATABASE_URL",
      "PGOPTIONS",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGHOSTADDR",
    ].some((k) => env[k] !== undefined)
  )
    fail();
}
export function createContextReader(env) {
  assertContextTarget(env);
  const clean = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APP_ENV",
    "ZCASH_NETWORK",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "DARKPOOL_PG_ENV",
    "DARKPOOL_PG_PROFILE",
    "DARKPOOL_TEST_ONLY",
    "DARKPOOL_LIFECYCLE_TEST_ONLY",
  ])
    if (env[key] !== undefined) clean[key] = env[key];
  return async () => {
    let session;
    try {
      session = await openLockSession({
        ...clean,
        DARKPOOL_LOCK_INTERNAL: "1",
      });
      return await session.query(`BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
${contextPrivileges} AS permitted \\gset
\\if :permitted
SELECT ${contextFunction};
\\else
SELECT 1/0;
\\endif`);
    } catch {
      fail();
    } finally {
      await session?.close();
    }
  };
}

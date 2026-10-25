// Private runtime adapter; no owner tools, wallet files or bearer claim secrets.
import { spawn } from "node:child_process";
import { loadEnvironmentGuard, guardedSql } from "./environment.mjs";
import { assertLiveComponent } from "./target-registry.mjs";

export const issuanceFunctions = [
  "darkpool_issuance.reserve(bytea,text,text,text,text)",
  "darkpool_issuance.begin_completion(bytea,text,bytea)",
  "darkpool_issuance.finish(bytea,text,bytea,text,text)",
];
export const issuancePrivilegeCheck = `SELECT current_user=session_user
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE
  (r.rolname=current_user AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
  OR (r.rolname<>current_user AND pg_has_role(current_user,r.oid,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
  AND (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')
   OR (nspname<>'darkpool_issuance' AND has_schema_privilege(current_user,oid,'USAGE') AND nspname LIKE 'darkpool%')))
 AND has_schema_privilege(current_user,'darkpool_issuance','USAGE')
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','p','m','f')
  AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%'
  AND p.oid NOT IN (${issuanceFunctions.map((f) => `'${f}'::regprocedure`).join(",")}) AND has_function_privilege(current_user,p.oid,'EXECUTE'))
 ${issuanceFunctions.map((f) => `AND has_function_privilege(current_user,'${f}','EXECUTE')`).join("\n")}`;

export function issuanceEnvironment(env) {
  try {
    assertLiveComponent(env, "issue");
  } catch {
    throw new Error("ISSUANCE_UNAVAILABLE");
  }
  if (
    env.APP_ENV !== "development" ||
    env.DARKPOOL_ISSUANCE_INTERNAL !== "1" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.PGHOST !== "127.0.0.1" ||
    !/^[0-9]{1,5}$/.test(env.PGPORT ?? "") ||
    +env.PGPORT < 1 ||
    +env.PGPORT > 65535 ||
    !/^[A-Za-z0-9_]+$/.test(env.PGUSER ?? "") ||
    !/^[A-Za-z0-9_]+$/.test(env.PGDATABASE ?? "") ||
    env.PGOPTIONS ||
    env.PGSERVICE ||
    env.PGSERVICEFILE ||
    env.DATABASE_URL ||
    env.WALLET_DB_PATH ||
    env.DARKPOOL_ADMIN_INTERNAL
  )
    throw new Error("ISSUANCE_UNAVAILABLE");
  const clean = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGDATABASE",
    "PGPASSWORD",
    "PGPASSFILE",
  ])
    if (env[key] !== undefined) clean[key] = env[key];
  return {
    ...clean,
    PGCONNECT_TIMEOUT: "3",
    PGCLIENTENCODING: "UTF8",
    PGAPPNAME: "darkpool-issuance",
  };
}
export async function issuanceQuery(query, env = process.env) {
  const clean = issuanceEnvironment(env);
  let target;
  try {
    target = await loadEnvironmentGuard(env);
  } catch {
    throw new Error("ISSUANCE_UNAVAILABLE");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.PSQL_PATH || "psql",
      [
        "--no-psqlrc",
        "--no-password",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=sqlstate",
        "-d",
        clean.PGDATABASE,
      ],
      { env: clean, windowsHide: true },
    );
    let output = "",
      diagnostics = "",
      failed = false;
    const fail = (code = "ISSUANCE_UNAVAILABLE") => {
      failed = true;
      const error = new Error(code);
      // SQLSTATE is safe internal diagnostic metadata. Never include stderr,
      // SQL text, DETAIL rows or request/credential values in the exception.
      error.sqlstate = /ERROR:\s+([0-9A-Z]{5})\b/.exec(diagnostics)?.[1];
      reject(error);
    };
    const timer = setTimeout(() => {
      fail();
      child.kill();
    }, 10000);
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 65536) {
        fail();
        child.kill();
      }
    });
    child.stderr.on("data", (data) => {
      if (diagnostics.length < 4096) diagnostics += data;
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      fail();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        fail(
          /ERROR:\s+P4502\b/.test(diagnostics)
            ? "ISSUANCE_CONFLICT"
            : /ERROR:\s+P4501\b/.test(diagnostics)
              ? "INVALID_REQUEST"
              : "ISSUANCE_UNAVAILABLE",
        );
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        fail();
      }
    });
    child.stdin.end(
      guardedSql(
        target,
        `BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL TIME ZONE 'UTC';
      ${issuancePrivilegeCheck} AS permitted \\gset
      \\if :permitted
      ${query}
      COMMIT;
      \\else
      SELECT 1/0;
      \\endif\n`,
      ),
    );
  });
}
export const sqlText = (value) =>
  `convert_from(decode('${Buffer.from(value, "utf8").toString("hex")}','hex'),'UTF8')`;

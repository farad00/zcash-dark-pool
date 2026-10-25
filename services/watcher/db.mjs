// Private runtime capability. Never use maintenance credentials here.
import { spawn } from "node:child_process";
import { loadEnvironmentGuard, guardedSql } from "../../db/environment.mjs";
import { assertLiveComponent } from "../../db/target-registry.mjs";

export const watcherFunctions = [
  "darkpool_watcher.context()",
  "darkpool_watcher.reconcile(bigint,jsonb)",
];
export const watcherPrivilegeCheck = `SELECT current_user=session_user
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE
  (r.rolname=current_user AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
  OR (r.rolname<>current_user AND pg_has_role(current_user,r.oid,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
  AND (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')
   OR (nspname<>'darkpool_watcher' AND nspname LIKE 'darkpool%' AND has_schema_privilege(current_user,oid,'USAGE'))))
 AND has_schema_privilege(current_user,'darkpool_watcher','USAGE')
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','p','m','f')
  AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%'
  AND p.oid NOT IN (${watcherFunctions.map((f) => `'${f}'::regprocedure`).join(",")}) AND has_function_privilege(current_user,p.oid,'EXECUTE'))
 ${watcherFunctions.map((f) => `AND has_function_privilege(current_user,'${f}','EXECUTE')`).join("\n")}`;

export function watcherEnvironment(env) {
  try {
    assertLiveComponent(env, "watch");
  } catch {
    throw new Error("WATCHER_UNAVAILABLE");
  }
  if (
    env.APP_ENV !== "development" ||
    env.DARKPOOL_WATCHER_INTERNAL !== "1" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.PGHOST !== "127.0.0.1" ||
    !/^[0-9]{1,5}$/.test(env.PGPORT ?? "") ||
    +env.PGPORT < 1 ||
    +env.PGPORT > 65535 ||
    !/^[A-Za-z0-9_]+$/.test(env.PGUSER ?? "") ||
    !/^darkpool_phase9_(?:[a-f0-9]{16}|evidence_[A-Za-z0-9_]+)$/.test(
      env.PGDATABASE ?? "",
    ) ||
    env.PGOPTIONS ||
    env.PGSERVICE ||
    env.PGSERVICEFILE ||
    env.DATABASE_URL ||
    env.DARKPOOL_ADMIN_INTERNAL
  )
    throw new Error("WATCHER_UNAVAILABLE");
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
    PGAPPNAME: "darkpool-watcher",
  };
}

export async function watcherQuery(query, env = process.env) {
  const clean = watcherEnvironment(env);
  let target;
  try {
    target = await loadEnvironmentGuard(env);
  } catch {
    throw new Error("WATCHER_UNAVAILABLE");
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
    const fail = (code = "WATCHER_UNAVAILABLE") => {
      if (!failed) {
        failed = true;
        reject(new Error(code));
      }
    };
    const timer = setTimeout(() => {
      fail();
      child.kill();
    }, 10000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 4194304) {
        fail();
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (diagnostics.length < 4096) diagnostics += chunk;
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
          /ERROR:\s+P4902\b/.test(diagnostics)
            ? "WATCHER_CONFLICT"
            : "WATCHER_UNAVAILABLE",
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
${watcherPrivilegeCheck} AS permitted \\gset
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

export function createWatcherDb(env = process.env, query = watcherQuery) {
  return {
    context: () => query("SELECT darkpool_watcher.context();", env),
    reconcile: (revision, request) => {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(String(revision)))
        throw new Error("WATCHER_UNAVAILABLE");
      const body = Buffer.from(JSON.stringify(request), "utf8");
      if (body.length > 4194304) throw new Error("WATCHER_UNAVAILABLE");
      return query(
        `SELECT darkpool_watcher.reconcile(${revision},convert_from(decode('${body.toString("hex")}','hex'),'UTF8')::jsonb);`,
        env,
      );
    },
  };
}

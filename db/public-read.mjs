// Public read adapter only. No maintenance/admin helper or wallet import.
import { spawn } from "node:child_process";
import { bindPublicReaderTarget } from "./public-reader-runtime.mjs";
import { guardedSql } from "./environment-identity.mjs";
export { publicConnectionEnvironment } from "./public-reader-runtime.mjs";

// Dedicated login with no role memberships, ownership, private reads or DML.
export const publicPrivilegeCheck = `SELECT
 current_user = session_user
 AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE
  (r.rolname=current_user AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
  OR (r.rolname<>current_user AND pg_has_role(current_user,r.oid,'MEMBER')))
 AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database()
  AND pg_has_role(current_user,datdba,'MEMBER'))
 AND NOT has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
  AND nspname<>'information_schema' AND
  (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')))
 AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool%'
  AND nspname<>'darkpool_public' AND has_schema_privilege(current_user,oid,'USAGE'))
 AND has_schema_privilege(current_user,'darkpool_public','USAGE')
 AND has_table_privilege(current_user,'darkpool_public.markets','SELECT')
 AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','p','m','f')
  AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR (c.oid<>'darkpool_public.markets'::regclass AND has_table_privilege(current_user,c.oid,'SELECT'))))
 AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname LIKE 'darkpool%'
  AND has_function_privilege(current_user,p.oid,'EXECUTE'))`;

// Explicit keys even if the view expands. LIMIT 2 detects invalid multi-market state.
export const publicMarketQuery = `SELECT COALESCE(jsonb_agg(m),'[]'::jsonb) FROM (
 SELECT id::text AS market_id, version, network, question, yes_definition, no_definition,
  to_char(opens_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opens_at,
  to_char(closes_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS closes_at,
  resolution_rule, resolution_sources, void_conditions, status::text
 FROM darkpool_public.markets LIMIT 2
) m;`;

export async function createPublicReader(env = process.env) {
  let target;
  try {
    target = await bindPublicReaderTarget(env);
  } catch {
    throw new Error("Market unavailable");
  }
  const { connection } = target;
  const script = `
${publicPrivilegeCheck} AS permitted \\gset
\\if :permitted
${publicMarketQuery}
COMMIT;
\\else
SELECT 1/0;
\\endif
`;
  const read = async () => {
    try {
      await target.verify();
    } catch {
      throw new Error("Market unavailable");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        target.executable,
        [
          "--no-psqlrc",
          "--no-password",
          "--quiet",
          "--no-align",
          "--tuples-only",
          "--set=ON_ERROR_STOP=1",
          "--set=VERBOSITY=sqlstate",
          "--dbname",
          connection.PGDATABASE,
        ],
        { env: connection, windowsHide: true },
      );
      let output = "",
        failed = false;
      const fail = () => {
        failed = true;
        reject(new Error("Market unavailable"));
      };
      const timer = setTimeout(() => {
        fail();
        child.kill();
      }, 8000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        if (
          Buffer.byteLength(output) + Buffer.byteLength(chunk) >
          2 * 1024 * 1024
        ) {
          fail();
          child.kill();
        } else output += chunk;
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        fail();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) {
          fail();
          return;
        }
        try {
          resolve(JSON.parse(output));
        } catch {
          fail();
        }
      });
      child.stdin.end(
        "BEGIN READ ONLY;\nSET LOCAL statement_timeout='3s';\n" +
          guardedSql(target, script + "\n\\else\n\\quit 3\n\\endif\n"),
      );
    });
  };
  // Authenticate and verify the reader grant boundary before serving any request.
  await read();
  return Object.freeze(read);
}

// Internal development CLI only. No HTTP/admin route or production auth system.
import { psql } from "../../../db/migrate.mjs";
import { assertLiveComponent } from "../../../db/target-registry.mjs";

export function requireInternalEnvironment(env) {
  assertLiveComponent(env, "admin");
  if (
    env.APP_ENV !== "development" ||
    env.DARKPOOL_ADMIN_INTERNAL !== "1" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.PGHOST !== "127.0.0.1" ||
    !/^[0-9]{1,5}$/.test(env.PGPORT ?? "") ||
    Number(env.PGPORT) < 1 ||
    Number(env.PGPORT) > 65535 ||
    !/^[A-Za-z0-9_]+$/.test(env.PGDATABASE ?? "") ||
    !/^[A-Za-z0-9_]+$/.test(env.PGUSER ?? "") ||
    env.PGOPTIONS ||
    env.PGSERVICE ||
    env.PGSERVICEFILE
  )
    throw new Error("INTERNAL_DEVELOPMENT_ONLY");
}

const operations = new Set([
  "create",
  "edit",
  "validate",
  "inspect",
  "open",
  "pause",
  "reopen",
  "finalize-lock",
  "resolve",
]);

export function parseCommand(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536)
    throw new Error("INVALID_REQUEST");
  let command;
  try {
    command = JSON.parse(text);
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  if (
    !command ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    Object.keys(command).length !== 2 ||
    !Object.hasOwn(command, "operation") ||
    !Object.hasOwn(command, "request") ||
    !operations.has(command.operation) ||
    !command.request ||
    typeof command.request !== "object" ||
    Array.isArray(command.request)
  )
    throw new Error("INVALID_REQUEST");
  return command;
}

// Defense in depth: authenticated runtime login must itself be restricted;
// SET ROLE over an owner connection is not an acceptable application credential.
export const runtimePrivilegeCheck = `SELECT
 current_user = session_user AND NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname=current_user AND
   (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 AND NOT EXISTS (
  SELECT 1 FROM pg_namespace WHERE nspname IN
   ('darkpool_private','darkpool_public','darkpool_admin','darkpool_migrations')
   AND pg_has_role(current_user,nspowner,'MEMBER'))
 AND NOT EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('darkpool_private','darkpool_migrations') AND c.relkind IN ('r','v','p')
   AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_has_role(current_user,c.relowner,'MEMBER')))
 AND NOT has_schema_privilege(current_user,'darkpool_admin','CREATE')
 AND NOT has_schema_privilege(current_user,'darkpool_private','USAGE');`;

const failures = {
  P4001: "INVALID_CONFIGURATION_OR_REQUEST",
  P4002: "SINGLE_MARKET_PRECONDITION",
  P4003: "RETRY_OR_REVISION_CONFLICT",
  P4004: "DRAFT_EDIT_UNAVAILABLE",
  P4005: "OPEN_PRECONDITION_FAILED",
  42501: "DATABASE_ACCESS_DENIED",
  23514: "DATABASE_INVARIANT_REJECTED",
  23503: "DATABASE_BINDING_REJECTED",
  23505: "DUPLICATE_REJECTED",
};

export async function executeCommand(command) {
  requireInternalEnvironment(process.env);
  // Hex transports JSON through psql without quoting/backslash/meta-command input.
  const operation = Buffer.from(command.operation, "utf8").toString("hex");
  const request = Buffer.from(JSON.stringify(command.request), "utf8").toString(
    "hex",
  );
  try {
    if ((await psql(runtimePrivilegeCheck)) !== "t")
      return { result: "REJECTED", code: "RESTRICTED_LOGIN_REQUIRED" };
    const output = await psql(`SELECT darkpool_admin.command(
      convert_from(decode('${operation}','hex'),'UTF8'),
      convert_from(decode('${request}','hex'),'UTF8')::jsonb);`);
    return JSON.parse(output);
  } catch (error) {
    // Never return PostgreSQL DETAIL, raw requests, libpq errors or credentials.
    return {
      result: "REJECTED",
      code:
        failures[error.sqlstate] ??
        (error.message === "Unable to start psql"
          ? "DATABASE_CLIENT_UNAVAILABLE"
          : "DATABASE_OPERATION_FAILED"),
    };
  }
}

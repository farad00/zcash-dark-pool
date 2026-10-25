// Disposable TEST session; never a production/DEV adapter or a migration.
import { createHash } from "node:crypto";
import { openLockSession } from "../lock/db-session.mjs";
import {
  paymentStatusPacket,
  paymentStatusResult,
  statusUnavailable,
} from "../../apps/web/src/payment-status-wire.mjs";

export const statusFunction =
  "darkpool_test_bridge.payment_status(bytea,text,text)";
export const statusPrivilegeCheck = `SELECT current_user=session_user
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE
  (r.rolname=current_user AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
  OR (r.rolname<>current_user AND pg_has_role(current_user,r.oid,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
  AND (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')
   OR (nspname<>'darkpool_test_bridge' AND nspname LIKE 'darkpool%' AND has_schema_privilege(current_user,oid,'USAGE'))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','p','m','f')
   AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND has_schema_privilege(current_user,'darkpool_test_bridge','USAGE')
 AND has_function_privilege(current_user,'${statusFunction}','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%'
  AND p.oid<>'${statusFunction}'::regprocedure AND has_function_privilege(current_user,p.oid,'EXECUTE'))`;

export function assertBridgeTarget(env) {
  const suffix = /^darkpool_phase9_([a-f0-9]{16})$/.exec(
    env.PGDATABASE ?? "",
  )?.[1];
  if (
    !process.env.NODE_TEST_CONTEXT ||
    !suffix ||
    env.PGUSER !== "darkpool_e2e_other_" + suffix ||
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.DARKPOOL_BRIDGE_TEST_ONLY !== "1" ||
    env.DARKPOOL_LIFECYCLE_TEST_ONLY !== "1" ||
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "55433" ||
    !env.PGPASSWORD ||
    !env.DARKPOOL_PG_PROFILE ||
    [
      "DARKPOOL_LIVE_INSTANCE",
      "WALLET_DB_PATH",
      "DATABASE_URL",
      "PGOPTIONS",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGHOSTADDR",
      "PGPASSFILE",
    ].some((k) => env[k] !== undefined)
  )
    statusUnavailable();
}

export function createTestPaymentStatus(env) {
  env = { ...env };
  assertBridgeTarget(env);
  return async (value) => {
    let session;
    try {
      const packet = paymentStatusPacket(value);
      const token = Buffer.from(packet.issuance_token, "hex");
      let digest;
      try {
        digest = createHash("sha256").update(token).digest("hex");
      } finally {
        token.fill(0);
      }
      session = await openLockSession({ ...env, DARKPOOL_LOCK_INTERNAL: "1" });
      // Only hex reaches SQL stdin. No capability or claim secret in argv/errors.
      const market = Buffer.from(packet.market_id).toString("hex");
      const answer =
        await session.query(`BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
${statusPrivilegeCheck} AS permitted \\gset
\\if :permitted
SELECT ${statusFunction.split("(")[0]}(decode('${digest}','hex'),convert_from(decode('${market}','hex'),'UTF8'),'${packet.ticket_id}');
\\else
SELECT 1/0;
\\endif`);
      return paymentStatusResult(answer);
    } catch {
      statusUnavailable();
    } finally {
      await session?.close();
    }
  };
}

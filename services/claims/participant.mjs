// Narrow server-only reservation session. No preparation, planner or wallet capability.
import { fileURLToPath } from "node:url";
import { withClaimSession } from "./session.mjs";
import { claimInSession } from "./reserve.mjs";
import { validateClaimPacket } from "../../apps/web/src/claim-wire.mjs";

const deny = () => {
  throw new Error("CLAIM_NOT_CONFIRMED");
};
export function assertParticipantTarget(env) {
  if (
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "55433" ||
    !/^darkpool_phase9_[a-f0-9]{16}$/.test(env.PGDATABASE ?? "") ||
    !/^darkpool_[a-z0-9_]+_[a-f0-9]{16}$/.test(env.PGUSER ?? "") ||
    (!env.PGPASSWORD && !env.PGPASSFILE) ||
    !env.DARKPOOL_PG_PROFILE ||
    [
      "DARKPOOL_LIVE_INSTANCE",
      "WALLET_DB_PATH",
      "DATABASE_URL",
      "PGOPTIONS",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGHOSTADDR",
    ].some((k) => env[k] !== undefined)
  )
    deny();
}
export const participantPrivileges = `SELECT to_jsonb(
 current_user=session_user
 AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND
  (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname<>current_user AND pg_has_role(current_user,oid,'MEMBER'))
 AND NOT has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND
  (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool%' AND nspname<>'darkpool_claims' AND has_schema_privilege(current_user,oid,'USAGE'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname LIKE 'darkpool%' AND c.relkind IN ('r','v','p','m','f') AND
  has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND has_schema_privilege(current_user,'darkpool_claims','USAGE')
 AND has_function_privilege(current_user,'darkpool_claims.begin_claim(text,text,text)','EXECUTE')
 AND has_function_privilege(current_user,'darkpool_claims.store(text,text,text,jsonb,text,boolean)','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%' AND
  NOT(n.nspname='darkpool_claims' AND p.proname IN ('begin_claim','store')) AND has_function_privilege(current_user,p.oid,'EXECUTE')));`;

export async function createParticipantClaims({ env, syntheticTest = false }) {
  assertParticipantTarget(env);
  if (
    syntheticTest &&
    (!process.env.NODE_TEST_CONTEXT || env.DARKPOOL_LIFECYCLE_TEST_ONLY !== "1")
  )
    deny();
  const connection = {};
  for (const k of [
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "DARKPOOL_PG_ENV",
    "DARKPOOL_PG_PROFILE",
    "DARKPOOL_TEST_ONLY",
  ])
    if (env[k] !== undefined) connection[k] = env[k];
  Object.assign(connection, {
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    DARKPOOL_LOCK_INTERNAL: "1",
    PSQL_PATH: fileURLToPath(
      new URL("../../.tools/pgsql/bin/psql.exe", import.meta.url),
    ),
  });
  Object.freeze(connection);
  const check = async (s) => {
    if ((await s.query(participantPrivileges)) !== true) deny();
  };
  await withClaimSession(connection, check);
  return Object.freeze({
    mode: syntheticTest ? "SYNTHETIC_TEST_ONLY" : "EXTERNAL_REQUIRED",
    async reserve(packet) {
      let secret;
      try {
        validateClaimPacket(packet);
        secret = new Uint8Array(Buffer.from(packet.claim_secret, "hex"));
        const saved = await withClaimSession(connection, async (s) => {
          await check(s);
          return claimInSession(
            {
              query: async (sql) => {
                const value = await s.query(sql);
                if (
                  sql.startsWith("SELECT darkpool_claims.begin_claim(") &&
                  value.execution_class !==
                    (syntheticTest ? "SYNTHETIC_TEST" : "EXTERNAL")
                )
                  deny();
                return value;
              },
            },
            { ...packet, claim_secret: secret },
          );
        });
        if (
          !["RESERVED", "PREPARED"].includes(saved.state) ||
          saved.spending_authorized !== false
        )
          deny();
        return Object.freeze({
          status: saved.state,
          payment: "NOT_SENT",
          environment: syntheticTest
            ? "SYNTHETIC_TEST_ONLY"
            : "EXTERNAL_REQUIRED",
        });
      } catch {
        deny();
      } finally {
        secret?.fill(0);
      }
    },
  });
}

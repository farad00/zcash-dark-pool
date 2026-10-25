import { createHash } from "node:crypto";
import {
  paymentStatusPacket,
  paymentStatusResult,
  statusUnavailable,
} from "../../apps/web/src/payment-status-wire.mjs";
export const statusFunction =
  "darkpool_participant_status.payment_status(bytea,text,text)";
export const statusPrivileges = `SELECT current_user=session_user
 AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname<>current_user AND pg_has_role(current_user,oid,'MEMBER'))
 AND NOT has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND (has_schema_privilege(current_user,oid,'CREATE') OR pg_has_role(current_user,nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool%' AND nspname<>'darkpool_participant_status' AND has_schema_privilege(current_user,oid,'USAGE'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool%' AND c.relkind IN ('r','v','p','m','f') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND has_schema_privilege(current_user,'darkpool_participant_status','USAGE')
 AND has_function_privilege(current_user,'${statusFunction}','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool%' AND p.oid<>'${statusFunction}'::regprocedure AND has_function_privilege(current_user,p.oid,'EXECUTE'))`;
// Trusted startup query capability only; never a callback in a participant request.
export function createParticipantStatus(query, environment) {
  if (
    typeof query !== "function" ||
    !["TESTNET_OBSERVATION", "DISPOSABLE_TEST"].includes(environment)
  )
    statusUnavailable();
  return async (value) => {
    try {
      const p = paymentStatusPacket(value);
      const token = Buffer.from(p.issuance_token, "hex");
      let digest;
      try {
        digest = createHash("sha256").update(token).digest("hex");
      } finally {
        token.fill(0);
      }
      const market = Buffer.from(p.market_id).toString("hex");
      const answer = await query(
        `SELECT darkpool_participant_status.payment_status(decode('${digest}','hex'),convert_from(decode('${market}','hex'),'UTF8'),'${p.ticket_id}');`,
      );
      if (answer.environment !== environment) statusUnavailable();
      return paymentStatusResult(answer);
    } catch {
      statusUnavailable();
    }
  };
}

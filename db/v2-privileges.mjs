// Fixed deposit-intake roles only. No publication/oracle/claim/signer authority.
import { literal, purposes } from "./v2-target.mjs";
import {
  issuanceFunctions,
  issuancePrivilegeCheck,
} from "./issuance-runtime.mjs";
import {
  watcherFunctions,
  watcherPrivilegeCheck,
} from "../services/watcher/db.mjs";
import { publicPrivilegeCheck } from "./public-read.mjs";
import { runtimePrivilegeCheck } from "../apps/web/src/admin.mjs";

export function roleChecks(plan) {
  return `DO $roles$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (${purposes.map((p) => literal(plan.roles[p])).join(",")})
 AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
 OR rolinherit OR rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL OR rolconfig IS NOT NULL))
 OR (SELECT count(*) FROM pg_roles WHERE rolname IN (${purposes.map((p) => literal(plan.roles[p])).join(",")}))<>5
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN (${purposes.map((p) => literal(plan.roles[p])).join(",")}))
 OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN (${purposes.map((p) => literal(plan.roles[p])).join(",")})))
 OR (SELECT datdba FROM pg_database WHERE datname=current_database())<>(SELECT oid FROM pg_roles WHERE rolname=${literal(plan.roles.owner)})
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (${["admin", "watch", "issue", "read"].map((p) => literal(plan.roles[p])).join(",")})
 AND (has_database_privilege(oid,current_database(),'CREATE,TEMP') OR NOT has_database_privilege(oid,current_database(),'CONNECT')))
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='setup roles rejected'; END IF;
END $roles$;`;
}

export const privilegeChecks = Object.freeze({
  admin: runtimePrivilegeCheck,
  watch: watcherPrivilegeCheck,
  issue: issuancePrivilegeCheck,
  read: publicPrivilegeCheck,
});

export function runtimeGrants(plan) {
  const grants = [
    `GRANT USAGE ON SCHEMA darkpool_admin TO "${plan.roles.admin}";`,
    `GRANT EXECUTE ON FUNCTION darkpool_admin.command(text,jsonb) TO "${plan.roles.admin}";`,
    `GRANT USAGE ON SCHEMA darkpool_watcher TO "${plan.roles.watch}";`,
    ...watcherFunctions.map(
      (f) => `GRANT EXECUTE ON FUNCTION ${f} TO "${plan.roles.watch}";`,
    ),
    `GRANT USAGE ON SCHEMA darkpool_issuance TO "${plan.roles.issue}";`,
    ...issuanceFunctions.map(
      (f) => `GRANT EXECUTE ON FUNCTION ${f} TO "${plan.roles.issue}";`,
    ),
    `GRANT USAGE ON SCHEMA darkpool_public TO "${plan.roles.read}";`,
    `GRANT SELECT ON darkpool_public.markets TO "${plan.roles.read}";`,
  ];
  for (const [purpose, check] of Object.entries(privilegeChecks)) {
    const expression = check
      .trim()
      .replace(/;$/, "")
      .replaceAll("current_user", literal(plan.roles[purpose]))
      .replaceAll("session_user", literal(plan.roles[purpose]));
    grants.push(
      `${expression} AS v2_permitted \\gset\n\\if :v2_permitted\n\\else\nSELECT 1/0;\n\\endif`,
    );
  }
  return grants.join("\n");
}

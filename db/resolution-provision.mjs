import { canonical } from "../services/publication/profile.mjs";
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const json = (v) =>
  `convert_from(decode('${Buffer.from(canonical(v)).toString("hex")}','hex'),'UTF8')::jsonb`;
const roleName = (s) => {
  if (typeof s !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(s))
    throw new Error("RESOLUTION_ROLE_REJECTED");
  return s;
};

// Maintenance SQL generator only. Grants neither broad admin nor signing rights.
export function provisionResolutionScript(oracle, coordinator) {
  roleName(oracle);
  roleName(coordinator);
  if (oracle === coordinator)
    throw new Error("RESOLUTION_SEPARATE_ROLES_REQUIRED");
  return `BEGIN;
DO $roles$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY[${literal(oracle)},${literal(coordinator)}] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r AND rolcanlogin AND NOT
   (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=r))
  OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND
   (pg_has_role(r,nspowner,'MEMBER') OR has_schema_privilege(r,oid,'CREATE')))
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%'
   AND c.relkind IN ('r','v','p') AND has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool_%'
   AND NOT(n.nspname='darkpool_resolution' AND ((r=${literal(oracle)} AND p.proname='approve')
    OR (r=${literal(coordinator)} AND p.proname IN ('begin_resolution','finish_resolution'))))
   AND has_function_privilege(r,p.oid,'EXECUTE')) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='separate restricted resolution roles required'; END IF;
 END LOOP;
END $roles$;
GRANT USAGE ON SCHEMA darkpool_resolution TO "${oracle}","${coordinator}";
GRANT EXECUTE ON FUNCTION darkpool_resolution.approve(jsonb) TO "${oracle}";
GRANT EXECUTE ON FUNCTION darkpool_resolution.begin_resolution(text),darkpool_resolution.finish_resolution(text,jsonb) TO "${coordinator}";
COMMIT;`;
}

/** Must run while DRAFT, with explicit human-reviewed objective rule and resource
 * bounds. Trigger captures database/cluster identity and checks exact market rules.
 * No default operator, oracle judgment, financial cap or observation time exists. */
export function registerOracleScript({
  market_id,
  oracle_login,
  coordinator_login,
  actor_ref,
  execution_class,
  rule,
  observation_at,
  resources,
}) {
  roleName(oracle_login);
  roleName(coordinator_login);
  if (
    typeof market_id !== "string" ||
    !market_id.length ||
    typeof actor_ref !== "string" ||
    !actor_ref.length ||
    !["EXTERNAL", "SYNTHETIC_TEST"].includes(execution_class) ||
    typeof observation_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(observation_at) ||
    !rule ||
    typeof rule.rule_version !== "string" ||
    !rule.rule_version.length ||
    !resources ||
    Object.keys(resources).sort().join(",") !==
      [
        "max_tickets",
        "max_text_bytes",
        "max_amount_bytes",
        "max_ledger_bytes",
        "max_total_zat",
        "max_numerator_zat_squared",
      ]
        .sort()
        .join(",")
  )
    throw new Error("ORACLE_REGISTRATION_REJECTED");
  for (const key of [
    "max_tickets",
    "max_total_zat",
    "max_numerator_zat_squared",
  ])
    if (
      typeof resources[key] !== "string" ||
      !/^[1-9][0-9]{0,154}$/.test(resources[key])
    )
      throw new Error("ORACLE_RESOURCE_REJECTED");
  for (const key of ["max_text_bytes", "max_amount_bytes", "max_ledger_bytes"])
    if (!Number.isSafeInteger(resources[key]) || resources[key] < 1)
      throw new Error("ORACLE_RESOURCE_REJECTED");
  return `INSERT INTO darkpool_private.oracle_authorities VALUES(${literal(market_id)},${literal(oracle_login)},${literal(coordinator_login)},
   ${literal(actor_ref)},${literal(execution_class)},${json(rule)},${literal(observation_at)},${json(resources)},0,'',NULL,now());`;
}

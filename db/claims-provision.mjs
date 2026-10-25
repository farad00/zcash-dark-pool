const literal = (v) => "'" + v.replaceAll("'", "''") + "'";
// Maintenance SQL generator; does not create a login, read credentials or connect.
export function provisionClaimsScript(role, market, executionClass) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof market !== "string" ||
    !market.length ||
    !["EXTERNAL", "SYNTHETIC_TEST"].includes(executionClass)
  )
    throw new Error("CLAIM_PROVISION_REJECTED");
  return `BEGIN;
DO $restricted$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(role)} AND rolcanlogin AND NOT
  (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${literal(role)}))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND
  (pg_has_role(${literal(role)},nspowner,'MEMBER') OR has_schema_privilege(${literal(role)},oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%'
  AND c.relkind IN ('r','v','p') AND has_table_privilege(${literal(role)},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool_%'
  AND NOT(n.nspname='darkpool_claims' AND p.proname IN ('begin_claim','store')) AND has_function_privilege(${literal(role)},p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='restricted claim service required'; END IF;
END $restricted$;
INSERT INTO darkpool_private.claim_services VALUES(${literal(market)},${literal(role)},${literal(executionClass)}) ON CONFLICT(market_id) DO NOTHING;
DO $binding$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.claim_services WHERE market_id=${literal(market)} AND service_login=${literal(role)}
  AND execution_class=${literal(executionClass)}) THEN RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='claim service binding conflict'; END IF;
END $binding$;
GRANT USAGE ON SCHEMA darkpool_claims TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_claims.begin_claim(text,text,text),darkpool_claims.store(text,text,text,jsonb,text,boolean) TO "${role}";
COMMIT;`;
}

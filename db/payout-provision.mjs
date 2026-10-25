const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
// Maintenance SQL generator only. This grants no signer or transaction capability.
export function provisionPayoutPlanningScript(
  planner,
  reconciler,
  configuration,
) {
  const keys = [
    "market_id",
    "execution_class",
    "external_funding_ref",
    "planning_fee_budget_zat",
    "per_intent_fee_ceiling_zat",
  ];
  if (
    !configuration ||
    Object.keys(configuration).sort().join(",") !== keys.sort().join(",") ||
    Object.values(configuration).some((v) => typeof v !== "string") ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(planner) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(reconciler) ||
    planner === reconciler ||
    typeof configuration.market_id !== "string" ||
    !configuration.market_id.length ||
    configuration.market_id.length > 256 ||
    !["EXTERNAL", "SYNTHETIC_TEST"].includes(configuration.execution_class) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(configuration.external_funding_ref) ||
    !/^(0|[1-9][0-9]{0,15})$/.test(configuration.planning_fee_budget_zat) ||
    !/^[1-9][0-9]{0,15}$/.test(configuration.per_intent_fee_ceiling_zat) ||
    BigInt(configuration.planning_fee_budget_zat) > 2100000000000000n ||
    BigInt(configuration.per_intent_fee_ceiling_zat) > 2100000000000000n
  )
    throw new Error("PAYOUT_PROVISION_REJECTED");
  const restricted = (role, functions) => `DO $restricted$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(role)} AND rolcanlogin AND NOT
  (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${literal(role)}))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND
  (pg_has_role(${literal(role)},nspowner,'MEMBER') OR has_schema_privilege(${literal(role)},oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%'
  AND c.relkind IN ('r','v','p') AND has_table_privilege(${literal(role)},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool_%'
  AND NOT(n.nspname='darkpool_payout' AND p.proname IN (${functions.map(literal).join(",")}))
  AND has_function_privilege(${literal(role)},p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='restricted payout service required'; END IF;
END $restricted$;`;
  const q = Object.fromEntries(
    Object.entries(configuration).map(([k, v]) => [k, literal(v)]),
  );
  return `BEGIN;
${restricted(planner, ["begin_plan", "store_plan"])}
${restricted(reconciler, ["report"])}
INSERT INTO darkpool_private.payout_planner_scopes VALUES(${q.market_id},${literal(planner)},${literal(reconciler)},
 ${q.execution_class},${q.external_funding_ref},${q.planning_fee_budget_zat}::numeric,${q.per_intent_fee_ceiling_zat}::numeric,
 false,session_user,clock_timestamp()) ON CONFLICT(market_id) DO NOTHING;
DO $binding$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.payout_planner_scopes WHERE market_id=${q.market_id}
  AND planner_login=${literal(planner)} AND reconciler_login=${literal(reconciler)} AND execution_class=${q.execution_class}
  AND external_funding_ref=${q.external_funding_ref} AND planning_fee_budget_zat=${q.planning_fee_budget_zat}::numeric
  AND per_intent_fee_ceiling_zat=${q.per_intent_fee_ceiling_zat}::numeric AND NOT funding_verified) THEN
  RAISE EXCEPTION USING ERRCODE='P1501',MESSAGE='payout scope conflict'; END IF;
END $binding$;
GRANT USAGE ON SCHEMA darkpool_payout TO "${planner}","${reconciler}";
GRANT EXECUTE ON FUNCTION darkpool_payout.begin_plan(text),darkpool_payout.store_plan(text,jsonb) TO "${planner}";
GRANT EXECUTE ON FUNCTION darkpool_payout.report(text,jsonb) TO "${reconciler}";
COMMIT;`;
}

const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
// Only blocked operator review requests, not a signer/funding capability.
export function provisionPayoutReviewScript(operator, market, executionClass) {
  if (
    typeof operator !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(operator) ||
    typeof market !== "string" ||
    !market.length ||
    market.length > 256 ||
    !["EXTERNAL", "SYNTHETIC_TEST"].includes(executionClass)
  )
    throw new Error("PAYOUT_REVIEW_PROVISION_REJECTED");
  return `BEGIN;
DO $restricted$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(operator)} AND rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${literal(operator)}))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND(pg_has_role(${literal(operator)},nspowner,'MEMBER') OR has_schema_privilege(${literal(operator)},oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%'
  AND c.relkind IN ('r','v','p') AND has_table_privilege(${literal(operator)},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool_%'
  AND NOT(n.nspname='darkpool_payout_review' AND p.proname IN ('preview','request')) AND has_function_privilege(${literal(operator)},p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='restricted payout review login required'; END IF;
END $restricted$;
INSERT INTO darkpool_private.payout_review_scopes VALUES(${literal(market)},${literal(operator)},${literal(executionClass)},3,false,session_user,clock_timestamp()) ON CONFLICT(market_id) DO NOTHING;
DO $binding$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.payout_review_scopes WHERE market_id=${literal(market)} AND operator_login=${literal(operator)}
  AND execution_class=${literal(executionClass)} AND proposed_confirmations=3 AND NOT spending_enabled) THEN
  RAISE EXCEPTION USING ERRCODE='P1601',MESSAGE='payout review scope conflict'; END IF;
END $binding$;
GRANT USAGE ON SCHEMA darkpool_payout_review TO "${operator}";
GRANT EXECUTE ON FUNCTION darkpool_payout_review.preview(text),darkpool_payout_review.request(text,text,jsonb) TO "${operator}";
COMMIT;`;
}

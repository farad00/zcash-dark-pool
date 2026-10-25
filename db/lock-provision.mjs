// Maintenance-only SQL generator. Does not connect, create credentials or run SQL.
export function provisionLockScript(role) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role))
    throw new Error("INVALID_LOCK_ROLE");
  return `BEGIN;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}' AND rolcanlogin AND NOT
  (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='${role}'))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND pg_has_role('${role}',nspowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('darkpool_private','darkpool_migrations') AND c.relkind IN ('r','v','p')
  AND has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('darkpool_private','darkpool_public','darkpool_admin','darkpool_watcher','darkpool_issuance','darkpool_migrations')
  AND has_schema_privilege('${role}',oid,'USAGE,CREATE'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='darkpool_lock'
  AND p.proname NOT IN ('begin_lock','finish_lock') AND has_function_privilege('${role}',p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='restricted finalizer role required'; END IF;
END $check$;
GRANT USAGE ON SCHEMA darkpool_lock TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_lock.begin_lock(jsonb),darkpool_lock.finish_lock(jsonb,jsonb,jsonb) TO "${role}";
COMMIT;`;
}

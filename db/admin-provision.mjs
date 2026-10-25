// Schema-owner maintenance command only. Never invoke from web/admin traffic.
import { psql } from "./migrate.mjs";
import { assertProvisionTarget } from "./target-registry.mjs";

export function provisionScript(role) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
    throw new Error("Invalid role name");
  return `BEGIN; DO $provision$
DECLARE r pg_roles;
BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname='${role}';
 IF NOT FOUND OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
  OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN
    ('darkpool_private','darkpool_public','darkpool_admin','darkpool_migrations')
    AND pg_has_role('${role}',nspowner,'MEMBER'))
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('darkpool_private','darkpool_migrations') AND c.relkind IN ('r','v','p')
    AND has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  OR has_schema_privilege('${role}','darkpool_private','USAGE')
  OR has_schema_privilege('${role}','darkpool_admin','CREATE') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='restricted operator role required';
 END IF;
END $provision$;
GRANT USAGE ON SCHEMA darkpool_admin TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_admin.command(text,jsonb) TO "${role}"; COMMIT;`;
}

if (process.argv[1]?.endsWith("admin-provision.mjs")) {
  try {
    assertProvisionTarget(process.argv[2], "admin");
    await psql(provisionScript(process.argv[2] ?? ""));
    process.stdout.write(
      "PASS: restricted internal admin entrypoint granted\n",
    );
  } catch {
    process.stderr.write("Admin provisioning rejected or unavailable\n");
    process.exitCode = 1;
  }
}

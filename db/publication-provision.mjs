import {
  canonical,
  sha256,
  trustProfile,
} from "../services/publication/profile.mjs";
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

// SQL generator only. No credential creation, service access or implicit policy.
export function provisionPublicationScript(role, database, configuredTrust) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    !/^darkpool_phase9_[a-f0-9]{16}$/.test(database)
  )
    throw new Error("PUBLICATION_TEST_ONLY");
  const trust = trustProfile(configuredTrust);
  // Only simulated trust may be installed by this TEST provisioning helper.
  // External policy registration requires separately reviewed trust configuration.
  if (trust.evidence_class !== "SYNTHETIC_TEST")
    throw new Error("PUBLICATION_UNAVAILABLE");
  const raw = canonical(trust),
    digest = sha256(Buffer.from(raw));
  return `BEGIN;
DO $check$ BEGIN
 IF current_database()<>${literal(database)} OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(role)} AND rolcanlogin AND NOT
  (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${literal(role)}))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%' AND
  (pg_has_role(${literal(role)},nspowner,'MEMBER') OR has_schema_privilege(${literal(role)},oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%'
  AND c.relkind IN ('r','v','p') AND has_table_privilege(${literal(role)},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool_%'
  AND (n.nspname<>'darkpool_publication' OR p.proname NOT IN ('outbox','persist'))
  AND has_function_privilege(${literal(role)},p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='restricted publication verifier required'; END IF;
END $check$;
INSERT INTO darkpool_private.publication_policies VALUES(${literal(trust.policy_ref)},${literal(role)},${literal(database)},
 'SYNTHETIC_TEST',convert_from(decode('${Buffer.from(raw).toString("hex")}','hex'),'UTF8')::jsonb,decode('${digest}','hex'))
 ON CONFLICT(policy_ref) DO NOTHING;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.publication_policies WHERE policy_ref=${literal(trust.policy_ref)}
  AND verifier_login=${literal(role)} AND database_name=${literal(database)} AND encode(trust_sha256,'hex')='${digest}') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='publication policy conflict'; END IF;
END $check$;
GRANT USAGE ON SCHEMA darkpool_publication TO "${role}";
GRANT EXECUTE ON FUNCTION darkpool_publication.outbox(text),darkpool_publication.persist(jsonb) TO "${role}";
COMMIT;`;
}

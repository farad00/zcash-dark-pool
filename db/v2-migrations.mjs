import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationScript } from "./migrate.mjs";
import { v2Plan, literal, rejected, queryTarget } from "./v2-target.mjs";
import { roleChecks, runtimeGrants } from "./v2-privileges.mjs";
import { databaseCheck } from "./v2-provision.mjs";
import { loadEnvironmentGuard } from "./environment.mjs";

export function validateMigrationSet(files) {
  if (!Array.isArray(files) || files.length !== 13)
    throw new Error("V2_MIGRATION_SET_REJECTED");
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    if (
      !/^\d{4}_[a-z0-9_]+\.sql$/.test(f.name) ||
      Number(f.name.slice(0, 4)) !== i + 1 ||
      typeof f.sql !== "string" ||
      !f.sql.trim()
    )
      throw new Error("V2_MIGRATION_SET_REJECTED");
  }
  return ordered;
}
export async function unifiedMigrationFiles() {
  const files = [];
  for (const path of ["./migrations/", "./schema/migrations/"]) {
    const dir = new URL(path, import.meta.url);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".sql")) continue;
      const bytes = await readFile(new URL(name, dir));
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!Buffer.from(sql, "utf8").equals(bytes))
        throw new Error("V2_MIGRATION_SET_REJECTED");
      files.push({ name, sql });
    }
  }
  return validateMigrationSet(files);
}
export const migrationDigest = (files) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        validateMigrationSet(files).map((f) => [
          f.name,
          createHash("sha256").update(f.sql, "utf8").digest("hex"),
        ]),
      ),
    )
    .digest("hex");

// Catalog definitions, owners and grants, never participant rows. OIDs are resolved
// into qualified names; data/sequence counters and migration timestamps excluded.
export const schemaFingerprint = `(SELECT encode(sha256(convert_to(COALESCE(string_agg(item,E'\\n' ORDER BY item COLLATE "C"),''),'UTF8')),'hex') FROM (
 SELECT jsonb_build_array('database',pg_get_userbyid(datdba),datacl::text,datallowconn,datistemplate)::text item FROM pg_database WHERE datname=current_database()
 UNION ALL SELECT jsonb_build_array('schema',n.nspname,pg_get_userbyid(n.nspowner),n.nspacl::text)::text
 FROM pg_namespace n WHERE (n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup') OR n.nspname='public'
 UNION ALL SELECT jsonb_build_array('relation',n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner),c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,
 CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,false) END)::text
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
 UNION ALL SELECT jsonb_build_array('column',n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl::text,
 (SELECT ns.nspname||'.'||co.collname FROM pg_collation co JOIN pg_namespace ns ON ns.oid=co.collnamespace WHERE co.oid=a.attcollation),pg_get_expr(d.adbin,d.adrelid,false))::text
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup' AND a.attnum>0
 UNION ALL SELECT jsonb_build_array('constraint',n.nspname,c.conname,c.conrelid::regclass::text,c.contypid::regtype::text,c.convalidated,pg_get_constraintdef(c.oid,false))::text
 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
 UNION ALL SELECT jsonb_build_array('function',n.nspname,p.proname,pg_get_userbyid(p.proowner),p.proacl::text,pg_get_functiondef(p.oid))::text
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
 UNION ALL SELECT jsonb_build_array('type',n.nspname,t.typname,pg_get_userbyid(t.typowner),t.typacl::text,t.typtype,format_type(t.typbasetype,t.typtypmod),t.typnotnull,t.typdefault)::text
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
 UNION ALL SELECT jsonb_build_array('trigger',n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,false))::text
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
 UNION ALL SELECT jsonb_build_array('index',n.nspname,c.relname,pg_get_indexdef(c.oid))::text
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='i' AND n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
 UNION ALL SELECT jsonb_build_array('default_acl',pg_get_userbyid(a.defaclrole),n.nspname,a.defaclobjtype,a.defaclacl::text)::text
 FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE a.defaclnamespace=0 OR n.nspname LIKE 'darkpool_%'
 UNION ALL SELECT jsonb_build_array('policy',n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))::text
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'darkpool_%' AND n.nspname<>'darkpool_v2_setup'
) catalog)`;

export async function migrateProduct(plan, env) {
  const { validateOperation } = await import("./v2-target.mjs");
  validateOperation(plan, env, "owner");
  const files = await unifiedMigrationFiles(),
    digest = migrationDigest(files);
  const { profile } = await loadEnvironmentGuard(env, {
    database: plan.database,
    requireKind: plan.execution === "V2" ? "LIVE_EVIDENCE" : "TEST",
  });
  const script = migrationScript(files);
  if (!script.startsWith("BEGIN;\n") || !script.endsWith("COMMIT;\n"))
    rejected();
  const output = await queryTarget(
    plan,
    env,
    "owner",
    `BEGIN;
SET LOCAL synchronous_commit=on; SET LOCAL search_path=pg_catalog;
SELECT pg_advisory_xact_lock(1146110284,3) AS migration_lock \\gset
${databaseCheck(plan, profile.cluster_id)}
${roleChecks(plan)}
DO $owner$ BEGIN IF session_user<>${literal(plan.roles.owner)} THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='migration owner required'; END IF; END $owner$;
DO $seal$ DECLARE prior text; BEGIN
 IF to_regclass('darkpool_v2_setup.schema_seal') IS NOT NULL THEN
  IF (SELECT count(*) FROM darkpool_migrations.applied)<>13 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='incomplete sealed history'; END IF;
  SELECT fingerprint INTO STRICT prior FROM darkpool_v2_setup.schema_seal WHERE version=1
   AND migration_digest=${literal(digest)} AND database_name=current_database()
   AND cluster_id=${literal(profile.cluster_id)} AND owner_name=session_user;
  IF prior IS DISTINCT FROM ${schemaFingerprint} THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='schema drift'; END IF;
 ELSIF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'darkpool_%') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='unsealed schema adoption forbidden';
 END IF;
END $seal$;
${script.slice("BEGIN;\n".length, -"COMMIT;\n".length)}
${runtimeGrants(plan)}
CREATE SCHEMA IF NOT EXISTS darkpool_v2_setup;
REVOKE ALL ON SCHEMA darkpool_v2_setup FROM PUBLIC;
CREATE TABLE IF NOT EXISTS darkpool_v2_setup.schema_seal(
 version integer PRIMARY KEY CHECK(version=1), migration_digest text NOT NULL,
 database_name name NOT NULL, cluster_id text NOT NULL, owner_name name NOT NULL,
 fingerprint text NOT NULL, created_at timestamptz NOT NULL);
REVOKE ALL ON darkpool_v2_setup.schema_seal FROM PUBLIC;
INSERT INTO darkpool_v2_setup.schema_seal VALUES(1,${literal(digest)},current_database(),
 ${literal(profile.cluster_id)},session_user,${schemaFingerprint},clock_timestamp()) ON CONFLICT(version) DO NOTHING;
DO $final$ BEGIN IF (SELECT count(*) FROM darkpool_migrations.applied)<>13
 OR NOT EXISTS(SELECT 1 FROM darkpool_v2_setup.schema_seal WHERE fingerprint=${schemaFingerprint})
 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='incomplete setup'; END IF; END $final$;
COMMIT;
SELECT json_build_object('result','MIGRATED','migrations',13,'execution',${literal(plan.execution)});
`,
  );
  const result = JSON.parse(output.split(/\r?\n/).at(-1));
  if (result.result !== "MIGRATED" || result.migrations !== 13)
    throw new Error("V2_COMMIT_UNCONFIRMED");
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.slice(2).join() !== "apply") rejected();
    process.stdout.write(
      JSON.stringify(await migrateProduct(v2Plan(process.env), process.env)) +
        "\n",
    );
  } catch {
    process.stderr.write("V2 migration rejected\n");
    process.exitCode = 1;
  }
}

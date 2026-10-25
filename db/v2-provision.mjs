import { randomBytes, pbkdf2Sync, createHmac, createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  v2Plan,
  purposes,
  literal,
  rejected,
  queryTarget,
} from "./v2-target.mjs";
import { roleChecks } from "./v2-privileges.mjs";

// PostgreSQL's native SCRAM verifier format; plaintext password never enters SQL.
export function scramVerifier(password) {
  if (typeof password !== "string" || !/^[a-f0-9]{64}$/.test(password))
    rejected();
  const salt = randomBytes(16),
    salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}

export const databaseMarker = (plan, clusterId) =>
  `DARKPOOL_V2_PRODUCT_V1:${clusterId}:${plan.database}:${plan.roles.owner}`;
export function databaseCheck(plan, clusterId) {
  return `DO $database$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_database
 WHERE datname=current_database() AND datname=${literal(plan.database)}
 AND datdba=(SELECT oid FROM pg_roles WHERE rolname=${literal(plan.roles.owner)})
 AND NOT datistemplate AND datallowconn AND pg_encoding_to_char(encoding)='UTF8'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(datacl,acldefault('d',datdba))) a WHERE a.grantee=0)
 AND shobj_description(oid,'pg_database')=${literal(databaseMarker(plan, clusterId))})
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unrecognized product database'; END IF; END $database$;`;
}

export async function preflightProvision(plan, env) {
  const { validateOperation } = await import("./v2-target.mjs");
  validateOperation(plan, env, "maintenance", true);
  const { loadEnvironmentGuard } = await import("./environment.mjs");
  const { profile } = await loadEnvironmentGuard(env, {
    database: "postgres",
    requireKind: plan.execution === "V2" ? "LIVE_EVIDENCE" : "TEST",
  });
  const output = await queryTarget(
    plan,
    env,
    "maintenance",
    `BEGIN READ ONLY;
DO $maintenance$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=session_user)
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='maintenance required'; END IF; END $maintenance$;
SELECT json_build_object('result','PREFLIGHT','roles_present',
 (SELECT count(*) FROM pg_roles WHERE rolname IN (${purposes.map((p) => literal(plan.roles[p])).join(",")})),
 'cluster_id',${literal(profile.cluster_id)});
COMMIT;`,
    true,
  );
  return JSON.parse(output);
}

export async function provisionProduct(plan, credentials, env) {
  if (
    !credentials ||
    Object.keys(credentials).sort().join() !== [...purposes].sort().join()
  )
    rejected();
  const verifiers = Object.fromEntries(
    purposes.map((p) => [p, scramVerifier(credentials[p])]),
  );
  // Query transport re-verifies profile/control/marker and server before each operation.
  const { loadEnvironmentGuard } = await import("./environment.mjs");
  // Validate closed target before touching a profile (including in direct API use).
  const { validateOperation } = await import("./v2-target.mjs");
  validateOperation(plan, env, "maintenance", true);
  const { profile } = await loadEnvironmentGuard(env, {
    database: "postgres",
    requireKind: plan.execution === "V2" ? "LIVE_EVIDENCE" : "TEST",
  });
  const cluster = profile.cluster_id;
  const rolesSql = purposes
    .map((p) => {
      const name = plan.roles[p],
        marker = `DARKPOOL_V2_ROLE_V1:${cluster}:${plan.database}:${p}`;
      return `DO $role$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(name)}) THEN
  IF shobj_description((SELECT oid FROM pg_roles WHERE rolname=${literal(name)}),'pg_authid') IS DISTINCT FROM ${literal(marker)}
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unrecognized role'; END IF;
 ELSE
  CREATE ROLE "${name}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(verifiers[p])};
  COMMENT ON ROLE "${name}" IS ${literal(marker)};
 END IF; END $role$;`;
    })
    .join("\n");
  await queryTarget(
    plan,
    env,
    "maintenance",
    `
SELECT pg_advisory_lock(1146110284,14) AS setup_lock \\gset
DO $maintenance$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=session_user)
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='maintenance required'; END IF; END $maintenance$;
BEGIN;
${rolesSql}
COMMIT;
SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${literal(plan.database)}) AS v2_exists \\gset
\\if :v2_exists
DO $existing$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=${literal(plan.database)}
 AND datdba=(SELECT oid FROM pg_roles WHERE rolname=${literal(plan.roles.owner)})
 AND shobj_description(oid,'pg_database')=${literal(databaseMarker(plan, cluster))})
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='database adoption forbidden'; END IF; END $existing$;
\\else
CREATE DATABASE "${plan.database}" OWNER "${plan.roles.owner}" TEMPLATE template0 ENCODING 'UTF8';
COMMENT ON DATABASE "${plan.database}" IS ${literal(databaseMarker(plan, cluster))};
REVOKE ALL ON DATABASE "${plan.database}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${plan.database}" TO ${purposes.map((p) => `"${plan.roles[p]}"`).join(",")};
\\endif
SELECT pg_advisory_unlock(1146110284,14) AS setup_unlock \\gset
`,
    true,
  );
  // Authenticate each retained credential. Never reset passwords on retry.
  for (const purpose of purposes) {
    const child = {
      ...env,
      PGDATABASE: plan.database,
      PGUSER: plan.roles[purpose],
      PGPASSWORD: credentials[purpose],
    };
    await queryTarget(
      plan,
      child,
      purpose,
      `BEGIN READ ONLY;
${databaseCheck(plan, cluster)}
${roleChecks(plan)}
COMMIT;`,
    );
  }
  const owner = {
    ...env,
    PGDATABASE: plan.database,
    PGUSER: plan.roles.owner,
    PGPASSWORD: credentials.owner,
  };
  await queryTarget(
    plan,
    owner,
    "owner",
    `BEGIN;
${databaseCheck(plan, cluster)}
${roleChecks(plan)}
DO $public$ BEGIN IF to_regclass('darkpool_v2_setup.schema_seal') IS NULL THEN
 REVOKE ALL ON SCHEMA public FROM PUBLIC; END IF; END $public$;
COMMIT;`,
  );
  return {
    result: "PROVISIONED",
    execution: plan.execution,
    database: plan.database,
    cluster_id: cluster,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const action = process.argv.slice(2).join();
    if (!["apply", "preflight"].includes(action)) rejected();
    const plan = v2Plan(process.env);
    if (action === "preflight") {
      process.stdout.write(
        JSON.stringify(await preflightProvision(plan, process.env)) + "\n",
      );
    } else {
      let input = "";
      for await (const part of process.stdin) {
        input += part;
        if (input.length > 4096) rejected();
      }
      const result = await provisionProduct(
        plan,
        JSON.parse(input),
        process.env,
      );
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch {
    process.stderr.write("V2 provisioning rejected\n");
    process.exitCode = 1;
  }
}

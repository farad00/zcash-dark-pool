// Private provisioning transport. No cluster lifecycle or wallet capability.
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { approvedTarget, rejectRedirects } from "./target-registry.mjs";
import {
  loadEnvironmentGuard,
  guardedSql,
  assertFixtureSql,
} from "./environment.mjs";
import { runBounded, boundedExit } from "../scripts/dev/run-bounded.mjs";

export const purposes = Object.freeze([
  "owner",
  "admin",
  "watch",
  "issue",
  "read",
]);
export const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
export const rejected = () => {
  throw new Error("V2_TARGET_REJECTED");
};
const repo = fileURLToPath(new URL("../", import.meta.url));
const allowedPg = new Set([
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
]);

export function v2Plan(env) {
  if (
    env.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE" ||
    env.DARKPOOL_LIVE_INSTANCE !== "phase9_payment_v2" ||
    env.DARKPOOL_TEST_ONLY !== undefined
  )
    rejected();
  const target = approvedTarget(
    "LIVE_EVIDENCE",
    env.LOCALAPPDATA,
    "phase9_payment_v2",
  );
  return Object.freeze({
    ...target,
    execution: "V2",
    resource_creation: false,
  });
}

// Explicitly separate fixture names/physical TEST target; never a V2 override.
export function rehearsalPlan(env, database) {
  if (
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.DARKPOOL_LIVE_INSTANCE !== undefined ||
    !/^darkpool_phase9_[a-f0-9]{16}$/.test(database)
  )
    rejected();
  const target = approvedTarget("TEST", env.LOCALAPPDATA);
  const suffix = database.slice(-16);
  return Object.freeze({
    ...target,
    database,
    execution: "TEST_REHEARSAL",
    roles: Object.freeze({
      maintenance: target.maintenance,
      ...Object.fromEntries(
        purposes.map((p) => [p, `darkpool_v2${p}_${suffix}`]),
      ),
    }),
    resource_creation: false,
  });
}

export function validateOperation(plan, env, purpose, administrative = false) {
  const fixed =
    plan.execution === "V2" ? v2Plan(env) : rehearsalPlan(env, plan.database);
  if (
    JSON.stringify(plan) !== JSON.stringify(fixed) ||
    !["maintenance", ...purposes].includes(purpose) ||
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== String(fixed.port) ||
    env.PGUSER !== fixed.roles[purpose] ||
    env.PGDATABASE !== (administrative ? "postgres" : fixed.database) ||
    (administrative && purpose !== "maintenance") ||
    typeof env.PGPASSWORD !== "string" ||
    !env.PGPASSWORD.length ||
    Object.keys(env).some((k) => /^PG/i.test(k) && !allowedPg.has(k)) ||
    env.DATABASE_URL ||
    env.PSQL_PATH ||
    (process.env.NODE_TEST_CONTEXT && fixed.execution !== "TEST_REHEARSAL")
  )
    rejected();
  return fixed;
}

export async function verifyV2Storage(plan, purpose) {
  const role = purpose === "maintenance" ? "maintenance" : purpose;
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(repo, "scripts/dev/v2-security.ps1"),
      "-Root",
      plan.root,
      "-Credential",
      role + ".xml",
    ],
    {
      timeoutMs: 10000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA)$/i.test(k),
        ),
      ),
    },
  );
  if (boundedExit(result) !== 0) throw new Error("V2_STORAGE_REJECTED");
}

export async function queryTarget(
  plan,
  env,
  purpose,
  sql,
  administrative = false,
) {
  validateOperation(plan, env, purpose, administrative); // Before filesystem/credential/socket access.
  await rejectRedirects(plan.root);
  if (plan.execution === "V2") await verifyV2Storage(plan, purpose);
  const target = await loadEnvironmentGuard(env, {
    database: env.PGDATABASE,
    requireKind: plan.execution === "V2" ? "LIVE_EVIDENCE" : "TEST",
  });
  if (plan.execution === "TEST_REHEARSAL") assertFixtureSql(sql);
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([k]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k) || allowedPg.has(k),
    ),
  );
  const acknowledgement = "V2_ACK_" + randomBytes(32).toString("hex");
  const result = await runBounded(
    join(repo, ".tools/pgsql/bin/psql.exe"),
    [
      "--no-psqlrc",
      "--no-password",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "--dbname",
      env.PGDATABASE,
    ],
    {
      timeoutMs: 30000,
      maxBytes: 1048576,
      env: {
        ...clean,
        PGCONNECT_TIMEOUT: "3",
        PGCLIENTENCODING: "UTF8",
        PGAPPNAME: "darkpool-v2-setup",
      },
      input: guardedSql(
        target,
        `SET statement_timeout='20s'; SET lock_timeout='3s'; SET synchronous_commit=on; SET TIME ZONE 'UTC';
DO $server$ BEGIN
 IF current_user<>session_user OR current_user<>${literal(env.PGUSER)}
 OR current_setting('server_version_num')::int<>180006
 OR current_setting('password_encryption')<>'scram-sha-256'
 OR current_setting('log_statement')<>'none'
 OR current_setting('log_min_error_statement')<>'panic'
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='setup server precondition'; END IF;
END $server$;\n` +
          sql +
          `\n;\nSELECT ${literal(acknowledgement)};`,
      ),
    },
  );
  const lines = result.stdout.trim().split(/\r?\n/);
  if (boundedExit(result) !== 0 || lines.at(-1) !== acknowledgement) {
    const error = new Error("V2_DATABASE_REJECTED");
    error.sqlstate =
      /ERROR:\s+([0-9A-Z]{5})\b/.exec(result.stderr)?.[1] || "UNAVAILABLE";
    throw error; // Never propagate SQL/credential/row diagnostics.
  }
  return lines.slice(0, -1).join("\n").trim();
}

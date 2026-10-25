// Closed, read-only resolver. Does not execute PostgreSQL, select databases,
// load credentials, change PATH or activate a persistent runtime.
import fixed from "./profile.json" with { type: "json" };
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { privateProcess } from "../../backup/crypto.mjs";
const reject = () => {
  throw Error("PINNED_POSTGRESQL_TOOLS_UNAVAILABLE");
};
Object.freeze(fixed);
const tools = Object.freeze({
  initialize: "initdb.exe",
  control: "pg_ctl.exe",
  context: "psql.exe",
  server: "postgres.exe",
  identity: "pg_controldata.exe",
  checksums: "pg_checksums.exe",
  dump: "pg_dump.exe",
  restore: "pg_restore.exe",
});
export function postgresToolPlan(purpose) {
  if (
    !Object.hasOwn(tools, purpose) ||
    fixed.destination !== "C:\\ZcashTools\\PostgreSQL\\18.6-5" ||
    fixed.archive_sha256 !==
      "e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2" ||
    fixed.inventory_sha256 !==
      "16a59b60f7b18e8eddc8c95a935081a08d8419c760e9838c1a1fd173369ac2db"
  )
    reject();
  return Object.freeze({
    purpose,
    destination: fixed.destination,
    executable: win32.join(fixed.destination, "bin", tools[purpose]),
    archive_sha256: fixed.archive_sha256,
    inventory_sha256: fixed.inventory_sha256,
    verification_required: "FULL_INVENTORY_ACL_AND_COMPLETION_RECEIPT",
    execution_authorization: "NOT_GRANTED",
    financial_authorization: "NOT_GRANTED",
  });
}
export function validateToolVerification(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      [
        "status",
        "scope",
        "destination",
        "archive_sha256",
        "inventory_sha256",
        "binary_execution",
        "financial_authorization",
        "production_trust",
      ]
        .sort()
        .join() ||
    value.status !== "PINNED_BINARIES_STAGED_ONLY" ||
    value.scope !== "STAGED_BINARIES_ONLY" ||
    value.destination !== fixed.destination ||
    value.archive_sha256 !== fixed.archive_sha256 ||
    value.inventory_sha256 !== fixed.inventory_sha256 ||
    value.binary_execution !== "NOT_AUTHORIZED" ||
    value.financial_authorization !== "NOT_GRANTED" ||
    value.production_trust !== "UNAVAILABLE"
  )
    reject();
  return Object.freeze({ ...value });
}
export async function verifyInstalledPostgresTools() {
  const script = fileURLToPath(
    new URL("../../../scripts/dev/postgresql-staging.ps1", import.meta.url),
  );
  try {
    const result = await privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Action",
        "Verify",
      ],
      Buffer.alloc(0),
      4096,
    );
    return validateToolVerification(JSON.parse(result.toString("utf8")));
  } catch {
    reject();
  }
}
export async function resolvePostgresTool(purpose) {
  const plan = postgresToolPlan(purpose);
  await verifyInstalledPostgresTools();
  // A verified path is not permission to run it. Current persistent entrypoints
  // still throw and there is deliberately no spawn/export of credentials here.
  return plan;
}

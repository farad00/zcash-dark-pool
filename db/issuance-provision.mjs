// Maintenance only. Provision an existing restricted login, never create credentials.
import { psql } from "./migrate.mjs";
import { assertProvisionTarget } from "./target-registry.mjs";
import {
  issuanceFunctions,
  issuancePrivilegeCheck,
} from "./issuance-runtime.mjs";
export function provisionIssuanceScript(role) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
    throw new Error("Invalid role name");
  return `BEGIN;
    GRANT USAGE ON SCHEMA darkpool_issuance TO "${role}";
    ${issuanceFunctions.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO "${role}";`).join("\n")}
    SET LOCAL ROLE "${role}";
    ${issuancePrivilegeCheck.replace("current_user=session_user", "true")} AS permitted \\gset
    \\if :permitted
    COMMIT;
    \\else
    SELECT 1/0;
    \\endif\n`;
}
if (process.argv[1]?.endsWith("issuance-provision.mjs")) {
  try {
    assertProvisionTarget(process.argv[2], "issue");
    await psql(provisionIssuanceScript(process.argv[2] ?? ""));
    process.stdout.write("Restricted issuance operations granted\n");
  } catch {
    process.stderr.write("Issuance provisioning rejected\n");
    process.exitCode = 1;
  }
}

// Maintenance-only provisioning; not imported by runtime.
import { psql } from "./migrate.mjs";
import { assertProvisionTarget } from "./target-registry.mjs";
import {
  watcherFunctions,
  watcherPrivilegeCheck,
} from "../services/watcher/db.mjs";

export function provisionWatcherScript(role) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
    throw new Error("Invalid role name");
  return `BEGIN;
GRANT USAGE ON SCHEMA darkpool_watcher TO "${role}";
${watcherFunctions.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO "${role}";`).join("\n")}
SET LOCAL ROLE "${role}";
${watcherPrivilegeCheck.replace("current_user=session_user", "true")} AS permitted \\gset
\\if :permitted
COMMIT;
\\else
ROLLBACK;
SELECT 1/0;
\\endif\n`;
}
if (process.argv[1]?.endsWith("watcher-provision.mjs")) {
  try {
    assertProvisionTarget(process.argv[2], "watch");
    await psql(provisionWatcherScript(process.argv[2] ?? ""));
    process.stdout.write("Restricted watcher capability granted\n");
  } catch {
    process.stderr.write("Watcher provisioning unavailable\n");
    process.exitCode = 1;
  }
}

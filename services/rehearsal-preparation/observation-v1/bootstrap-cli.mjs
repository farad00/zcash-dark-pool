// No filesystem, PostgreSQL process, account-provisioning or wallet capability.
import { proposal } from "../plan.mjs";
import {
  persistentBootstrapPlan,
  accountProvisioningPlan,
  assertPersistentExecution,
} from "./bootstrap-plan.mjs";
import { computerBRecoveryPlan } from "./bootstrap-recovery.mjs";
import { windowsSecurityPlan, toolAccessPlan } from "./windows-security.mjs";
import { offlineCustodyPlan } from "./computer-b-recovery.mjs";
try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["plan", "create"].includes(args[0]))
    throw Error("INVALID_ACTION");
  if (args[0] === "create") assertPersistentExecution(proposal(), {});
  console.log(
    JSON.stringify({
      status: "BOOTSTRAP_PLAN_ONLY",
      plan: persistentBootstrapPlan(),
      accounts: accountProvisioningPlan(),
      recovery: computerBRecoveryPlan(),
      windows: windowsSecurityPlan(),
      tools: toolAccessPlan(),
      offline_custody: offlineCustodyPlan(),
    }),
  );
} catch {
  console.log(
    JSON.stringify({
      status: "BOOTSTRAP_BLOCKED",
      reason: "PERSISTENT_EXECUTION_NOT_APPROVED",
      persistent_created: false,
      financial_authorization: "NOT_GRANTED",
      production_trust: "UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
}

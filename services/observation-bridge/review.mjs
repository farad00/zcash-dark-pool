// Source-only readiness report, never a launcher or authorization flag.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
export function reviewDeployment() {
  return Object.freeze({
    mode: "OBSERVATION_ONLY",
    readiness: "BLOCKED_BY_OPERATOR_APPROVAL",
    real_process_launch_enabled: false,
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    blockers: [
      "ISOLATED_NON_DEV_TARGET",
      "VIEW_ONLY_WALLET_PROVISIONING_AND_ACL",
      "ALLOCATOR_JOURNAL_WRITES",
      "SCANNER_STATE_WRITES_OR_NATIVE_READ_ONLY_COMMAND",
      "CONTEXT_ONLY_OPERATIONAL_ROLE",
      "RECOVERY_AND_KEY_CUSTODY",
    ],
    resource_creation: false,
  });
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.stdout.write(JSON.stringify(reviewDeployment()) + "\n");

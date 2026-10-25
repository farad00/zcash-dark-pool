// Conditional design approval is NOT resource-creation or wallet authority.
import {
  proposal,
  proposalDigest,
  validateProposal,
  reviewPrincipalBindings,
} from "../plan.mjs";
import { assertPersistentExecution } from "./bootstrap-plan.mjs";
export const reject = () => {
  throw Error("OBSERVATION_V1_REJECTED");
};
export const hashPattern = /^[a-f0-9]{64}$/;
export function assertDisposable() {
  if (
    !process.env.NODE_TEST_CONTEXT ||
    process.env.DARKPOOL_OBSERVATION_V1_TEST_ONLY !== "1" ||
    process.env.DARKPOOL_BACKUP_TEST_ONLY !== "1" ||
    process.env.DARKPOOL_PHYSICAL_REHEARSAL !== "1" ||
    process.env.DARKPOOL_PG_ENV !== "TEST" ||
    process.env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    process.env.DARKPOOL_LIVE_INSTANCE !== undefined ||
    process.env.DATABASE_URL ||
    Object.keys(process.env).some((k) => /^PG/i.test(k))
  )
    reject();
}
export function provisioningPlan(value = proposal()) {
  const p = validateProposal(value);
  return Object.freeze({
    profile: "OBSERVATION_V1_CONDITIONAL_DESIGN",
    descriptor_sha256: proposalDigest(p),
    instance: p.instance,
    host: p.host,
    port: p.port,
    database: p.database,
    root: p.root,
    signer_root: p.signer_root,
    design: "APPROVED_IMPLEMENTATION_AND_DISPOSABLE_TEST_ONLY",
    persistent_creation: "NOT_APPROVED",
    native_launch: "DISABLED",
    wallet_import: "NOT_APPROVED",
    product_migrations: false,
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
  });
}
export function provisionPersistent(value = proposal()) {
  provisioningPlan(value);
  return assertPersistentExecution(value, {});
}
export function launchPersistent(value = proposal()) {
  provisioningPlan(value);
  throw Error("NATIVE_LAUNCH_NOT_APPROVED");
}
// Explicit DACL application plan. Actual service logon/group/token checks and
// cross-user denial tests require approved account provisioning; a SID plan is not proof.
export function permissionPlan(sids) {
  reviewPrincipalBindings(sids);
  const p = proposal();
  const entry = (path, principal, rights) =>
    Object.freeze({ path, sid: sids[principal], rights });
  return Object.freeze({
    protected_dacl: true,
    inherited_grants: false,
    administrator_override: true,
    actual_access_tests: "NOT_EXECUTED",
    grants: Object.freeze([
      entry(p.paths.postgres_data, "postgres", "Modify"),
      entry(p.paths.viewer_directory, "viewer_controller", "Modify"),
      entry(p.paths.runtime_bin, "viewer_controller", "ReadAndExecute"),
      entry(p.paths.control, "viewer_controller", "Modify"),
      entry(p.paths.evidence, "viewer_controller", "Modify"),
      entry(p.paths.recovery_staging, "backup_operator", "Modify"),
      entry(p.paths.encrypted_local_backups, "backup_operator", "Modify"),
      entry(p.signer_root, "signer", "Modify"),
    ]),
    web_private_grants: Object.freeze([]),
    credentials: "SEPARATE_PER_PURPOSE_DPAPI_UNDER_ACTUAL_SERVICE_SID",
    parent_traversal:
      "READ_EXECUTE_ONLY_TO_REQUIRED_CHILDREN_NO_PRIVATE_DIRECTORY_LISTING",
    recovery_access:
      "EXPLICIT_STOPPED_SOURCE_MAINTENANCE_ONLY_NO_SIGNER_SECRET_ACCESS",
  });
}

// Inert persistent specification shared with the fenced physical TEST backend.
import {
  proposal,
  proposalDigest,
  validateProposal,
  reviewPrincipalBindings,
} from "../plan.mjs";
import { createHash } from "node:crypto";
export const rejectBootstrap = () => {
  throw Error("OBSERVATION_BOOTSTRAP_REJECTED");
};
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export function persistentBootstrapPlan(value = proposal()) {
  const p = validateProposal(value);
  return freeze({
    profile: "OBSERVATION_V1_PERSISTENT_BOOTSTRAP_V1",
    descriptor_sha256: proposalDigest(p),
    instance: p.instance,
    host: p.host,
    port: p.port,
    database: p.database,
    root: p.root,
    signer_root: p.signer_root,
    phases: [
      "EXCLUSIVE_ATTEMPT",
      "INITIALIZED",
      "SCHEMA_COMMITTED",
      "HBA_RESTRICTED",
      "VERIFIED",
      "STOPPED_SEALED",
    ],
    production_backend: "DISABLED_PENDING_ACCOUNT_AND_RECOVERY_REVIEW",
    required_approvals: [
      "EXACT_TARGET_CREATION",
      "FIVE_ACCOUNT_SECURITY_POLICY",
      "SERVICE_USER_DPAPI_AND_DENIAL_TESTS",
      "COMPUTER_B_RECOVERY_AND_OFFLINE_KEY_CUSTODY",
      "PINNED_TOOL_EXECUTION",
    ],
    native_launch: "DISABLED",
    product_migrations: false,
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    recovery: "COLD_PHYSICAL_AGE_X25519_QUARANTINED_RESTORE",
    initialization: {
      executable: p.root + "\\postgres\\runtime-18.6-5\\bin\\initdb.exe",
      arguments: [
        "-D",
        p.paths.postgres_data,
        "-U",
        p.roles.maintenance.name,
        "--pwfile=" + p.paths.credentials + "\\bootstrap.password",
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C",
        "--no-clean",
      ],
      run_as: p.os_principals.postgres,
      credential_file: "CREATE_ONLY_PROTECTED_PLAINTEXT_WINDOW_REQUIRES_REVIEW",
      permission_to_execute: false,
    },
  });
}
export function accountProvisioningPlan(sids) {
  if (sids !== undefined) reviewPrincipalBindings(sids);
  const p = proposal();
  return freeze({
    status: "IMPLEMENTATION_PLAN_NOT_ACCOUNT_CREATION_APPROVAL",
    accounts: Object.entries(p.os_principals).map(([purpose, name]) => ({
      purpose,
      name,
      sid: sids?.[purpose] ?? null,
      create_only: true,
      initially_disabled: true,
      explicit_group_memberships: [],
      password: "INDEPENDENT_CSPRNG_NO_ARGUMENTS_OR_LOGS",
      deny: [
        "SeDenyInteractiveLogonRight",
        "SeDenyRemoteInteractiveLogonRight",
        "SeDenyNetworkLogonRight",
        ...(["signer", "backup_operator"].includes(purpose)
          ? ["SeDenyServiceLogonRight"]
          : ["SeDenyBatchLogonRight"]),
      ],
      allow: ["signer", "backup_operator"].includes(purpose)
        ? ["SeBatchLogonRight"]
        : ["SeServiceLogonRight"],
      activation: "SEPARATE_APPROVAL_REQUIRED",
    })),
    tool_permissions: {
      path: "C:\\ZcashTools\\PostgreSQL\\18.6-5",
      postgres: "NONE",
      backup_operator: "NONE",
      viewer_controller: "NONE",
      web: "NONE",
      signer: "NONE",
      recursive_write: false,
      application: "NOT_PERFORMED",
      strategy: "SEPARATE_CREATE_ONLY_VERIFIED_RUNTIME_COPY_PENDING_APPROVAL",
      runtime_copy: p.root + "\\postgres\\runtime-18.6-5",
    },
    credential_storage:
      "CURRENT_USER_DPAPI_UNDER_ACTUAL_SERVICE_SID_PER_PURPOSE",
    dpapi_portable_recovery: false,
    service_installation: "NOT_IMPLEMENTED_OR_AUTHORIZED",
    actual_cross_account_access: "NOT_TESTED",
    actual_service_user_dpapi: "NOT_TESTED",
    password_rotation_and_expiry: "EXPLICIT_OPERATOR_POLICY_REQUIRED",
  });
}
export function assertPersistentExecution(value, approvals) {
  persistentBootstrapPlan(value);
  // No environment flag, synthetic receipt, caller SID or boolean enables this.
  if (!approvals || Object.keys(approvals).length !== 0) rejectBootstrap();
  throw Error("PERSISTENT_CREATION_NOT_APPROVED");
}
export function validateLayout(layout) {
  if (
    !layout ||
    !["DISPOSABLE_TEST_ONLY", "PERSISTENT_DISABLED"].includes(layout.scope) ||
    !/^[0-9]{16,20}$/.test(layout.system_identifier ?? "") ||
    [
      "7697706083887339692",
      "7697541254856017064",
      "7698884242696928048",
    ].includes(layout.system_identifier) ||
    !/^[a-f0-9]{32}$/.test(layout.nonce ?? "")
  )
    rejectBootstrap();
  if (layout.scope === "DISPOSABLE_TEST_ONLY") {
    if (
      !Number.isInteger(layout.port) ||
      layout.port < 49152 ||
      layout.port > 65535 ||
      [55432, 55433, 55434, 55435, 55436].includes(layout.port) ||
      layout.database !== "darkpool_physical_" + layout.nonce.slice(0, 16) ||
      Object.entries(layout.roles).some(
        ([k, v]) =>
          v !==
          "darkpool_physical_" +
            ({ maintenance: "admin", owner: "owner", context: "read" }[k] ??
              "INVALID") +
            "_" +
            layout.nonce.slice(0, 16),
      ) ||
      Object.keys(layout.roles).sort().join() !== "context,maintenance,owner"
    )
      rejectBootstrap();
  } else {
    const p = proposal();
    if (
      layout.port !== p.port ||
      layout.database !== p.database ||
      Object.keys(layout.roles).sort().join() !== "context,maintenance,owner" ||
      Object.entries(layout.roles).some(([k, v]) => v !== p.roles[k].name)
    )
      rejectBootstrap();
  }
  return layout;
}
const q = (value) => "'" + value.replaceAll("'", "''") + "'";
export function roleCreationSql(layout, contextPassword) {
  validateLayout(layout);
  if (!/^[a-f0-9]{64}$/.test(contextPassword ?? "")) rejectBootstrap();
  const r = layout.roles;
  return `BEGIN; CREATE ROLE "${r.owner}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE "${r.context}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${q(contextPassword)};
ALTER ROLE "${r.context}" SET default_transaction_read_only=on;
REVOKE ALL ON DATABASE postgres FROM PUBLIC; REVOKE ALL ON DATABASE template1 FROM PUBLIC; COMMIT;`;
}
export function databaseCreationSql(layout) {
  validateLayout(layout);
  return `CREATE DATABASE "${layout.database}" OWNER "${layout.roles.owner}" TEMPLATE template0 ENCODING 'UTF8';`;
}
export function schemaSql(layout, { rollbackProbe = false } = {}) {
  validateLayout(layout);
  if (
    typeof rollbackProbe !== "boolean" ||
    (rollbackProbe && layout.scope !== "DISPOSABLE_TEST_ONLY")
  )
    rejectBootstrap();
  const r = layout.roles;
  const binding = {
    profile: "OBSERVATION_V1_NONFINANCIAL_BOOTSTRAP",
    scope: layout.scope,
    nonce: layout.nonce,
    system_identifier: layout.system_identifier,
    database: layout.database,
    descriptor_sha256: proposalDigest(proposal()),
    financial_authorization: "NOT_GRANTED",
  };
  const encoded = Buffer.from(JSON.stringify(binding)).toString("hex");
  return `BEGIN;
REVOKE ALL ON DATABASE "${layout.database}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${layout.database}" TO "${r.context}";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA darkpool_watcher AUTHORIZATION "${r.owner}";
REVOKE ALL ON SCHEMA darkpool_watcher FROM PUBLIC;
SET LOCAL ROLE "${r.owner}";
CREATE TABLE darkpool_watcher.bootstrap_boundary(singleton boolean PRIMARY KEY CHECK(singleton), binding jsonb NOT NULL);
INSERT INTO darkpool_watcher.bootstrap_boundary VALUES(true,convert_from(decode('${encoded}','hex'),'UTF8')::jsonb);
CREATE FUNCTION darkpool_watcher.context() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('instance','testnet_observation_v1','mode','UNFUNDED_STATUS_ONLY','state','DRAFT',
 'acceptance','NOT_EVALUATED','financial_authorization','NOT_GRANTED','spending_enabled',false)
 FROM darkpool_watcher.bootstrap_boundary WHERE singleton $$;
CREATE FUNCTION darkpool_watcher.bootstrap_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'immutable nonfinancial bootstrap'; END $$;
CREATE TRIGGER immutable_bootstrap BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON darkpool_watcher.bootstrap_boundary
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_watcher.bootstrap_immutable();
REVOKE ALL ON ALL TABLES IN SCHEMA darkpool_watcher FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_watcher FROM PUBLIC;
RESET ROLE;
GRANT USAGE ON SCHEMA darkpool_watcher TO "${r.context}";
GRANT EXECUTE ON FUNCTION darkpool_watcher.context() TO "${r.context}";
${rollbackProbe ? "SELECT 1/0;" : ""}
COMMIT;`;
}
export function postgresConfiguration(layout, dataDirectory) {
  validateLayout(layout);
  if (typeof dataDirectory !== "string" || /[\r\n']/u.test(dataDirectory))
    rejectBootstrap();
  return `listen_addresses='127.0.0.1'\nport=${layout.port}\nmax_connections=12\nshared_buffers='16MB'\nwal_level=minimal\nmax_wal_senders=0\nmin_wal_size='2MB'\nmax_wal_size='16MB'\nfsync=on\nsynchronous_commit=on\nfull_page_writes=on\ntimezone='UTC'\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_error_verbosity='terse'\nlog_connections=''\nlog_disconnections=off\n`;
}
export function hbaConfiguration(layout) {
  validateLayout(layout);
  return `host postgres ${layout.roles.maintenance} 127.0.0.1/32 scram-sha-256\nhost ${layout.database} ${layout.roles.maintenance},${layout.roles.context} 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n`;
}

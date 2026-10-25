// Windows adapter contracts. No caller-supplied provider can enable production.
import { isDeepStrictEqual } from "node:util";
import { proposal, proposalDigest, reviewPrincipalBindings } from "../plan.mjs";
import { accountProvisioningPlan, freeze, sha256 } from "./bootstrap-plan.mjs";
import { assertDisposable } from "./policy.mjs";

const fail = () => {
  throw Error("WINDOWS_SECURITY_REJECTED");
};
const roles = Object.keys(proposal().os_principals);
const sidPattern = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const sameSet = (a, b) =>
  Array.isArray(a) &&
  new Set(a).size === a.length &&
  isDeepStrictEqual([...a].sort(), [...b].sort());
export function windowsSecurityPlan() {
  return freeze({
    profile: "OBSERVATION_V1_WINDOWS_SECURITY_V1",
    descriptor_sha256: proposalDigest(proposal()),
    accounts: accountProvisioningPlan().accounts,
    account_creation: "DISABLED",
    service_installation: "DISABLED",
    service_start: "DISABLED",
    native_disposable_backend: "scripts/dev/observation-native-windows.ps1",
    native_persistent_backend: "DISABLED_UNCONDITIONALLY",
    elevated_execution_proof: "REQUIRES_REAL_DISPOSABLE_RESULT",
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    password_policy: "OPERATOR_ROTATION_AND_EXPIRY_DECISION_REQUIRED",
    credential_channel: "PRIVATE_PIPE_OR_NATIVE_SCM_MEMORY_NEVER_ARGV_OR_ENV",
    service_host: {
      process_model: "ONE_PURPOSE_ONE_SID_NO_SHARED_HOST",
      postgres: "SCM_SERVICE_LOGON_TYPE_5",
      viewer_controller: "SCM_SERVICE_LOGON_TYPE_5",
      web: "SCM_SERVICE_LOGON_TYPE_5",
      signer: "EXPLICIT_ON_DEMAND_BATCH_LOGON_TYPE_4_DISABLED",
      backup_operator: "EXPLICIT_ON_DEMAND_BATCH_LOGON_TYPE_4_DISABLED",
      failure_action: "STOP_AND_QUARANTINE_NO_AUTO_RESTART",
      profile: "ACTUAL_USER_PROFILE_REQUIRED_FOR_CURRENT_USER_DPAPI",
      executable:
        "NATIVE_ONE_SHOT_SYNTHETIC_HOST_IMPLEMENTED_PERSISTENT_INSTALL_DISABLED",
    },
  });
}
export function persistentWindowsOperation() {
  // Deliberately unconditional, before provider access, paths, SCM, LSA or accounts.
  throw Error("PERSISTENT_WINDOWS_EXECUTION_DISABLED");
}
export function toolAccessPlan() {
  const p = proposal();
  return freeze({
    source: "C:\\ZcashTools\\PostgreSQL\\18.6-5",
    source_acl_policy: "UNCHANGED_ADMIN_SYSTEM_OPERATOR_ONLY",
    source_service_grants: [],
    archive_sha256:
      "e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2",
    inventory_sha256:
      "16a59b60f7b18e8eddc8c95a935081a08d8419c760e9838c1a1fd173369ac2db",
    runtime_copy: p.root + "\\postgres\\runtime-18.6-5",
    layout: [
      "bin",
      "lib",
      "share",
      "server_license.txt",
      "commandlinetools_3rd_party_licenses.txt",
    ],
    source_and_destination_verification:
      "FULL_PINNED_INVENTORY_NO_REPARSE_OR_HARDLINKS",
    owner: "BUILTIN_ADMINISTRATORS",
    writers: ["SYSTEM", "BUILTIN_ADMINISTRATORS"],
    readers: ["postgres", "backup_operator"],
    denied_purposes: ["viewer_controller", "web", "signer"],
    receipt: "CREATE_ONLY_FULL_INVENTORY_AND_SID_BINDING",
    partial_state: "QUARANTINE_NO_ADOPTION_OR_AUTO_RETRY",
    activation: "SEPARATE_APPROVAL_REQUIRED_NOT_COPIED",
    resolution: "EXPLICIT_RUNTIME_PATH_NO_PATH_OR_ONEDRIVE_FALLBACK",
  });
}
export function validateWindowsBindings(
  records,
  expectedSids,
  { enabled = false } = {},
) {
  reviewPrincipalBindings(expectedSids);
  if (
    typeof enabled !== "boolean" ||
    !Array.isArray(records) ||
    records.length !== 5
  )
    fail();
  const seen = new Set();
  for (const a of accountProvisioningPlan(expectedSids).accounts) {
    const matches = records.filter((r) => r?.purpose === a.purpose);
    if (matches.length !== 1) fail();
    const r = matches[0];
    if (
      Object.keys(r).sort().join() !==
        "allow,deny,enabled,groups,local,name,purpose,sid" ||
      r.name !== a.name ||
      r.sid !== a.sid ||
      !sidPattern.test(r.sid) ||
      seen.has(r.sid) ||
      r.local !== true ||
      r.enabled !== enabled ||
      !sameSet(r.groups, []) ||
      !sameSet(r.allow, a.allow) ||
      !sameSet(r.deny, a.deny)
    )
      fail();
    seen.add(r.sid);
  }
  return freeze({
    status: "ACCOUNT_POLICY_VERIFIED",
    activation: "NOT_AUTHORIZED",
  });
}
// Shared adapter sequence exercised only through an unforgeable TEST capability.
// Test providers are models, not proof of account creation or Windows logon.
const sessions = new WeakMap();
export function createWindowsFixtureAdapter(provider) {
  assertDisposable();
  if (
    !provider ||
    [
      "createAttempt",
      "assertNamesAbsent",
      "createDisabledAccount",
      "setRights",
      "inspectAccounts",
      "record",
      "inspectHost",
    ].some((k) => typeof provider[k] !== "function")
  )
    fail();
  const cap = Object.freeze({ scope: "WINDOWS_ADAPTER_MODEL_ONLY" });
  sessions.set(cap, { provider, attempted: false, complete: false });
  return cap;
}
export async function prepareWindowsFixtureAccounts(cap) {
  assertDisposable();
  const s = sessions.get(cap);
  if (!s || s.attempted) fail();
  s.attempted = true; // Concurrent calls fail before any awaited provider operation.
  const p = s.provider;
  await p.createAttempt(windowsSecurityPlan().descriptor_sha256);
  await p.assertNamesAbsent([...roles]);
  const sids = {};
  for (const a of accountProvisioningPlan().accounts) {
    const result = await p.createDisabledAccount(a);
    if (
      !result ||
      Object.keys(result).sort().join() !== "created,sid" ||
      result.created !== true ||
      !sidPattern.test(result.sid) ||
      Object.values(sids).includes(result.sid)
    )
      fail();
    sids[a.purpose] = result.sid;
    // Retain the exact new SID before subsequent mutations; never adopt by name.
    await p.record({
      phase: "ACCOUNT_CREATED_DISABLED",
      purpose: a.purpose,
      sid: result.sid,
    });
    await p.setRights(a.purpose, result.sid, a.allow, a.deny);
  }
  validateWindowsBindings(await p.inspectAccounts(), sids);
  s.sids = freeze(sids);
  await p.record({
    phase: "POLICY_VERIFIED_DISABLED",
    descriptor_sha256: proposalDigest(proposal()),
  });
  s.complete = true;
  return freeze({
    status: "FIXTURE_ACCOUNT_ADAPTER_COMPLETE",
    evidence: "MODEL_ONLY_NOT_WINDOWS_LOGON",
    sids,
    financial_authorization: "NOT_GRANTED",
  });
}
export function validateHostEvidence(purpose, sids, value) {
  reviewPrincipalBindings(sids);
  if (
    !roles.includes(purpose) ||
    !value ||
    Object.keys(value).sort().join() !==
      "cross_user_unprotect_denied,dpapi_roundtrip,enabled,evidence,groups,logon_type,other_private_paths_denied,profile_loaded,purpose,sid,token_privileges"
  )
    fail();
  const batch = ["signer", "backup_operator"].includes(purpose);
  if (
    value.evidence !== "REAL_WINDOWS_LOGON_TOKEN" ||
    value.purpose !== purpose ||
    value.sid !== sids[purpose] ||
    value.logon_type !== (batch ? 4 : 5) ||
    value.enabled !== true ||
    !sameSet(value.groups, []) ||
    !sameSet(value.token_privileges, []) ||
    value.profile_loaded !== true ||
    value.dpapi_roundtrip !== true ||
    value.cross_user_unprotect_denied !== true ||
    value.other_private_paths_denied !== true
  )
    fail();
  // This validates a privileged adapter report, not a self-authenticating receipt.
  // Reports must be obtained from the reviewed OS host, never a web request.
  return freeze({
    status: "HOST_EVIDENCE_STRUCTURALLY_VALID",
    financial_authorization: "NOT_GRANTED",
    launch: "DISABLED",
  });
}
export async function reviewFixtureHost(cap, purpose) {
  assertDisposable();
  const s = sessions.get(cap);
  if (!s?.complete) fail();
  const v = await s.provider.inspectHost(purpose);
  return validateHostEvidence(purpose, s.sids, v);
}
// Synthetic runtime-copy verifier shares integrity/ACL invariants with the future
// service-runtime adapter. No executable is launched and no stage ACL is changed.
export function verifyRuntimeInventory(expected, actual, sids) {
  reviewPrincipalBindings(sids);
  const root = toolAccessPlan();
  if (
    !expected ||
    expected.scope !== "SYNTHETIC_RUNTIME_ONLY" ||
    !Array.isArray(expected.files) ||
    !expected.files.length ||
    !actual ||
    actual.scope !== expected.scope ||
    actual.reparse !== false ||
    actual.hardlinks !== false ||
    actual.complete !== true ||
    actual.owner !== "S-1-5-32-544" ||
    !actual.protected_dacl ||
    !isDeepStrictEqual(actual.files, expected.files)
  )
    fail();
  const seen = new Set();
  for (const f of expected.files) {
    if (
      Object.keys(f).sort().join() !== "path,sha256,size" ||
      !/^(?:bin|lib|share)\/[A-Za-z0-9_.-]+$|^(?:server_license|commandlinetools_3rd_party_licenses)\.txt$/.test(
        f.path,
      ) ||
      seen.has(f.path.toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.size) ||
      f.size < 1
    )
      fail();
    seen.add(f.path.toLowerCase());
  }
  if (
    !root.layout.every((d) =>
      expected.files.some((f) => f.path === d || f.path.startsWith(d + "/")),
    )
  )
    fail();
  const acl = [
    { sid: "S-1-5-18", rights: "FullControl" },
    { sid: "S-1-5-32-544", rights: "FullControl" },
    { sid: sids.postgres, rights: "ReadAndExecute" },
    { sid: sids.backup_operator, rights: "ReadAndExecute" },
  ];
  if (!isDeepStrictEqual(actual.acl, acl)) fail();
  return freeze({
    status: "SYNTHETIC_RUNTIME_COPY_VERIFIED",
    inventory_sha256: sha256(Buffer.from(JSON.stringify(expected))),
    execution: "DISABLED",
  });
}

// Inactive proposal validation only. No filesystem, credential, SQL or network APIs.
import proposed from "./target.proposed.json" with { type: "json" };
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
const fail = () => {
  throw new Error("UNFUNDED_PLAN_REJECTED");
};
function freeze(v) {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
freeze(proposed);
export const proposal = () => structuredClone(proposed);
export function validateProposal(value) {
  if (!isDeepStrictEqual(value, proposed)) fail();
  return freeze(structuredClone(proposed));
}
export const proposalDigest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(validateProposal(value)))
    .digest("hex");
export function canonicalWindowsPath(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length > 240 ||
    !/^[a-z]:[\\/]/i.test(value) ||
    /[\u0000-\u001f\u007f%<>"|?*]/u.test(value) ||
    value.slice(2).includes(":")
  )
    fail();
  const normalized = value.replaceAll("/", "\\");
  const tail = normalized.slice(3);
  if (
    !tail ||
    tail
      .split("\\")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    fail();
  return win32.normalize(normalized).toLowerCase();
}
export function pathsOverlap(a, b) {
  a = canonicalWindowsPath(a);
  b = canonicalWindowsPath(b);
  return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\");
}
export function reviewIsolation(
  value,
  { localAppData, workspace, additionalProtectedRoots = [] } = {},
) {
  const p = validateProposal(value);
  canonicalWindowsPath(localAppData);
  canonicalWindowsPath(workspace);
  if (
    !Array.isArray(additionalProtectedRoots) ||
    additionalProtectedRoots.length > 64
  )
    fail();
  const protectedRoots = [
    workspace,
    win32.join(localAppData, "ZcashDarkPoolDev"),
    win32.join(localAppData, "ZcashDarkPoolCommitmentWitness"),
    win32.join(localAppData, "ZcashDarkPoolPublication"),
    ...additionalProtectedRoots,
  ];
  protectedRoots.forEach(canonicalWindowsPath);
  const roots = [p.root, p.signer_root, p.off_device_proposal.root];
  for (const root of roots)
    for (const reserved of protectedRoots)
      if (pathsOverlap(root, reserved)) fail();
  for (let i = 0; i < roots.length; i++)
    for (let j = 0; j < i; j++) if (pathsOverlap(roots[i], roots[j])) fail();
  for (const path of Object.values(p.paths)) {
    if (
      !canonicalWindowsPath(path).startsWith(
        canonicalWindowsPath(p.root) + "\\",
      )
    )
      fail();
    for (const reserved of protectedRoots)
      if (pathsOverlap(path, reserved)) fail();
  }
  if ([5432, 55432, 55433, 55434, 55435].includes(p.port)) fail();
  return freeze({
    profile: p.profile,
    proposal_sha256: proposalDigest(p),
    isolation: "LEXICAL_MODEL_PASS",
    physical_preflight: "NOT_RUN",
    port_availability: "NOT_CHECKED",
    backup_custody: "NOT_CONFIGURED",
    approval: "PROPOSED_NOT_APPROVED",
    resource_creation: false,
    real_process_launch_enabled: false,
    financial_authorization: "NOT_GRANTED",
  });
}
export function reviewPrincipalBindings(value) {
  const expected = Object.keys(proposed.os_principals).sort();
  if (!value || Object.keys(value).sort().join() !== expected.join()) fail();
  const sids = Object.values(value);
  if (
    sids.some(
      (v) =>
        typeof v !== "string" ||
        !/^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(v),
    ) ||
    new Set(sids).size !== sids.length
  )
    fail();
  return freeze({
    principal_separation: "DECLARED_SIDS_DISTINCT",
    actual_accounts_and_memberships: "NOT_VERIFIED",
    acl_application: "NOT_PERFORMED",
    financial_authorization: "NOT_GRANTED",
  });
}
const purposes = freeze({
  allocation: {
    command: "serve-allocation",
    operations: ["allocate"],
    database_role: null,
    wallet_access: "READ_WRITE_ADDRESS_JOURNAL_AND_MAINTAINED_SCHEMA",
    extra_environment: [
      "ALLOCATION_MARKET_ID",
      "ALLOCATION_VAULT_CONTEXT",
      "ALLOCATION_AUTH",
      "ALLOCATION_PORT",
    ],
  },
  scan: {
    command: "serve-watcher",
    operations: ["observe", "sync"],
    database_role: "darkpool_obs_v1_context",
    wallet_access: "READ_WRITE_SYNC_SCAN_CHECKPOINT_AND_REORG",
    extra_environment: ["CHAIN_ENDPOINT"],
  },
  observation: {
    command: "serve-watcher",
    operations: ["observe"],
    database_role: "darkpool_obs_v1_context",
    wallet_access: "READ_WRITE_VALIDATION_HANDLE_AND_SQLITE_SIDECARS",
    extra_environment: ["CHAIN_ENDPOINT"],
  },
});
export function planPurpose(value, purpose, context) {
  const review = reviewIsolation(value, context);
  if (!Object.hasOwn(purposes, purpose)) fail();
  const p = validateProposal(value),
    selected = purposes[purpose];
  return freeze({
    profile: p.profile,
    proposal_sha256: review.proposal_sha256,
    purpose,
    executable: win32.join(p.paths.runtime_bin, "darkpool-zcash.exe"),
    arguments: [selected.command],
    allowed_operations: [...selected.operations],
    wallet_path: p.paths.viewer_database,
    wallet_access: selected.wallet_access,
    database_role: selected.database_role,
    child_environment_keys: [
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "ZCASH_NETWORK",
      "DARKPOOL_PG_ENV",
      "DARKPOOL_LIVE_INSTANCE",
      "LOCALAPPDATA",
      "WALLET_DB_PATH",
      ...selected.extra_environment,
    ],
    controller_database_access: selected.database_role
      ? "CONTEXT_FUNCTION_ONLY"
      : "NONE",
    writer_schedule: "EXCLUSIVE_CONTROLLER_LEASE_NO_STALE_LOCK_REMOVAL",
    executable_pin: "REQUIRED_NOT_CONFIGURED",
    identity_pins: "REQUIRED_NOT_CONFIGURED",
    enabled: false,
    approval: "PROPOSED_NOT_APPROVED",
    resource_creation: false,
    financial_authorization: "NOT_GRANTED",
    spending_enabled: false,
  });
}

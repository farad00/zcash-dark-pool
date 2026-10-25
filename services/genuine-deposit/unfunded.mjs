// Purpose-specific manual approval. Never accepted by the deposit/scanner gate.
import { createHash } from "node:crypto";
import { readFile, open } from "node:fs/promises";
import { win32 } from "node:path";
import { proposedTarget, validateTarget, reject } from "./target.mjs";
import {
  markerText,
  validateIdentityProfile,
} from "../../db/environment-identity.mjs";
export const scope = "ONE_UNFUNDED_RECEIVER_V1";
export const sha256 = (v) => createHash("sha256").update(v).digest("hex");
export const layout = () => {
  const t = proposedTarget();
  return {
    ...t,
    data: win32.join(t.root, "postgres", "data"),
    profile: win32.join(t.root, "deposit-profile.json"),
    marker: win32.join(t.root, "cluster-marker.json"),
    approval: win32.join(t.root, "unfunded-approval.json"),
    receipt: win32.join(t.root, "intake-installed.json"),
  };
};
const exact = (v, keys) =>
  v && !Array.isArray(v) && Object.keys(v).sort().join() === keys.sort().join();
export function validateApproval(
  a,
  target = proposedTarget(),
  now = Date.now(),
) {
  validateTarget(target);
  if (
    !exact(a, [
      "version",
      "scope",
      "target",
      "approval_id",
      "expires_at",
      "operator_sid",
      "web_sid",
      "viewer_sid",
      "native_sha256",
      "migrations_sha256",
      "financial_authorization",
      "production_trust",
      "acceptance_enabled",
    ]) ||
    a.version !== 1 ||
    a.scope !== scope ||
    JSON.stringify(validateTarget(a.target)) !==
      JSON.stringify(validateTarget(target)) ||
    !/^[a-f0-9]{32}$/.test(a.approval_id) ||
    ![a.native_sha256, a.migrations_sha256].every((h) =>
      /^[a-f0-9]{64}$/.test(h),
    ) ||
    ![a.operator_sid, a.web_sid, a.viewer_sid].every((s) =>
      /^S-1-5-21-(\d+-){3}\d+$/.test(s),
    ) ||
    new Set([a.operator_sid, a.web_sid, a.viewer_sid]).size !== 3 ||
    !Number.isFinite(Date.parse(a.expires_at)) ||
    Date.parse(a.expires_at) <= now ||
    Date.parse(a.expires_at) - now > 2 * 3600000 ||
    a.financial_authorization !== "NOT_GRANTED" ||
    a.production_trust !== "UNAVAILABLE" ||
    a.acceptance_enabled !== false
  )
    reject();
  return a;
}
export function assertUnfundedLaunch(
  { approval, profile, receipt, completion, actorSid, purpose },
  now = Date.now(),
) {
  validateApproval(approval, proposedTarget(), now);
  validateIdentityProfile(
    profile,
    {
      ...layout(),
      reserved_system_identifiers: [
        "7698884242696928048",
        "7697706083887339692",
        "7697541254856017064",
      ],
    },
    "TESTNET_OBSERVATION",
  );
  if (
    !["issuer", "allocator"].includes(purpose) ||
    actorSid !== approval[purpose === "issuer" ? "web_sid" : "viewer_sid"] ||
    profile?.kind !== "TESTNET_OBSERVATION" ||
    profile.instance !== approval.target.instance ||
    profile.host !== "127.0.0.1" ||
    profile.port !== 55436 ||
    profile.database !== approval.target.database ||
    profile.data_directory !== layout().data ||
    profile.financial_authorization !== "NOT_GRANTED" ||
    receipt?.scope !== scope ||
    receipt.status !== "INTAKE_INSTALLED_NO_MARKET" ||
    receipt.approval_sha256 !== sha256(JSON.stringify(approval)) ||
    receipt.migrations_sha256 !== approval.migrations_sha256 ||
    receipt.marker !== markerText(profile) ||
    completion?.scope !== scope ||
    completion.status !== "PHYSICAL_BOOTSTRAP_COMPLETED" ||
    completion.receipt_sha256 !== sha256(JSON.stringify(receipt))
  )
    reject();
  return true;
}
// Durable create-only writes; failed/partial files are retained for review.
export async function durableNew(path, value) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(value);
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function readJson(path) {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
}

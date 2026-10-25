// Fixed, inactive Observation V1 binding. No credential, wallet or SQL access.
import { win32 } from "node:path";
import {
  proposal,
  canonicalWindowsPath,
} from "../rehearsal-preparation/plan.mjs";
import { launchPersistent } from "../rehearsal-preparation/observation-v1/policy.mjs";
export const reject = () => {
  throw Error("DEPOSIT_OBSERVATION_UNAVAILABLE");
};
export const purposes = Object.freeze(["issue", "watch", "status", "read"]);
export function validateTarget(value) {
  const p = proposal();
  const expected = {
    instance: p.instance,
    network: "testnet",
    host: p.host,
    port: p.port,
    database: p.database,
    root: p.root,
    wallet_path: p.paths.viewer_database,
    signer_root: p.signer_root,
    chain_endpoint: p.chain_endpoint,
  };
  if (
    !value ||
    Object.keys(value).sort().join() !== Object.keys(expected).sort().join()
  )
    reject();
  for (const [key, wanted] of Object.entries(expected)) {
    if (["root", "wallet_path", "signer_root"].includes(key)) {
      if (canonicalWindowsPath(value[key]) !== canonicalWindowsPath(wanted))
        reject();
    } else if (value[key] !== wanted) reject();
  }
  return Object.freeze(expected);
}
export function proposedTarget() {
  const p = proposal();
  return validateTarget({
    instance: p.instance,
    network: p.network,
    host: p.host,
    port: p.port,
    database: p.database,
    root: p.root,
    wallet_path: p.paths.viewer_database,
    signer_root: p.signer_root,
    chain_endpoint: p.chain_endpoint,
  });
}
export function validateConnection(env, purpose) {
  const t = proposedTarget();
  if (
    !purposes.includes(purpose) ||
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.DARKPOOL_PG_ENV !== "TESTNET_OBSERVATION" ||
    env.DARKPOOL_OBSERVATION_INSTANCE !== t.instance ||
    env.PGHOST !== t.host ||
    env.PGPORT !== String(t.port) ||
    env.PGDATABASE !== t.database ||
    env.PGUSER !== `darkpool_obs_v1_${purpose}` ||
    !env.PGPASSWORD ||
    env.FINANCIAL_AUTHORIZATION !== "NOT_GRANTED" ||
    [
      "DARKPOOL_TEST_ONLY",
      "DARKPOOL_LIVE_INSTANCE",
      "PGOPTIONS",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGHOSTADDR",
      "DATABASE_URL",
      "PGPASSFILE",
      "WALLET_DB_PATH",
    ].some((k) => env[k] !== undefined)
  )
    reject();
  return t;
}
export function nativeEnvironment(target, purpose, extra = {}) {
  const t = validateTarget(target);
  if (!["allocation", "scan"].includes(purpose)) reject();
  const allowed =
    purpose === "allocation"
      ? [
          "ALLOCATION_MARKET_ID",
          "ALLOCATION_VAULT_CONTEXT",
          "ALLOCATION_AUTH",
          "ALLOCATION_PORT",
        ]
      : [];
  if (Object.keys(extra).sort().join() !== allowed.sort().join()) reject();
  if (
    purpose === "allocation" &&
    (!/^[a-f0-9]{64}$/.test(extra.ALLOCATION_AUTH) ||
      !/^[1-9][0-9]{0,4}$/.test(extra.ALLOCATION_PORT) ||
      +extra.ALLOCATION_PORT > 65535 ||
      [5432, 55432, 55433, 55434, 55435, 55436].includes(
        +extra.ALLOCATION_PORT,
      ) ||
      ![extra.ALLOCATION_MARKET_ID, extra.ALLOCATION_VAULT_CONTEXT].every(
        (v) =>
          typeof v === "string" &&
          v.isWellFormed() &&
          v.length > 0 &&
          Buffer.byteLength(v) <= 8192 &&
          !/[\u0000-\u001f\u007f]/u.test(v),
      ))
  )
    reject();
  return Object.freeze({
    ZCASH_NETWORK: "testnet",
    DARKPOOL_PG_ENV: "TESTNET_OBSERVATION",
    DARKPOOL_OBSERVATION_INSTANCE: t.instance,
    FINANCIAL_AUTHORIZATION: "NOT_GRANTED",
    WALLET_DB_PATH: t.wallet_path,
    CHAIN_ENDPOINT: t.chain_endpoint,
    ...extra,
  });
}
export function reviewTarget(target = proposedTarget()) {
  const t = validateTarget(target);
  return Object.freeze({
    ...t,
    native_launch: "BLOCKED_BY_EXISTING_APPROVAL_GATE",
    profile_path: win32.join(t.root, "deposit-profile.json"),
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    spending_enabled: false,
  });
}
export function assertNativeActivation(target) {
  validateTarget(target);
  // Never infer activation from a caller flag, synthetic fixture or config file.
  // Existing persistent approval boundary intentionally still rejects.
  return launchPersistent();
}

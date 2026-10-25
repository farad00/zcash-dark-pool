// Private target management. Public readers import only inert identity data.
import identities from "./target-identities.json" with { type: "json" };
import { resolve, join, dirname, parse, isAbsolute, basename } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import {
  rejectTarget,
  samePath,
  freezeIdentityData,
} from "./environment-identity.mjs";
freezeIdentityData(identities);

export const environmentClasses = Object.freeze([
  "HISTORICAL",
  "TEST",
  "LIVE_EVIDENCE",
]);
export const liveInstances = Object.freeze(
  Object.keys(identities.LIVE_EVIDENCE),
);
export function approvedTarget(kind, base, instance) {
  if (
    typeof base !== "string" ||
    !isAbsolute(base) ||
    !["TEST", "LIVE_EVIDENCE"].includes(kind)
  )
    rejectTarget();
  if (kind === "TEST" && instance !== undefined) rejectTarget();
  if (kind === "LIVE_EVIDENCE" && typeof instance !== "string") rejectTarget();
  const entry =
    kind === "TEST"
      ? identities.TEST
      : Object.hasOwn(identities.LIVE_EVIDENCE, instance ?? "")
        ? identities.LIVE_EVIDENCE[instance]
        : undefined;
  if (!entry) rejectTarget();
  const root =
    kind === "TEST"
      ? resolve(base, "ZcashDarkPoolDev", entry.directory)
      : resolve(
          base,
          "ZcashDarkPoolDev",
          "postgres-live-evidence",
          entry.directory,
        );
  const roles = Object.freeze(
    Object.fromEntries(
      ["maintenance", "owner", "admin", "watch", "issue", "read"].map(
        (role) => [role, entry.role_prefix + role],
      ),
    ),
  );
  const protectedRoot =
    kind === "LIVE_EVIDENCE"
      ? resolve(base, "ZcashDarkPoolDev", ...entry.protected_parts)
      : undefined;
  return Object.freeze({
    kind,
    instance,
    root,
    data: join(root, "data"),
    profile: join(root, "profile.json"),
    marker: join(root, "cluster-marker.json"),
    expected_system_identifier: entry.system_identifier,
    expected_cluster_id: entry.cluster_id,
    reserved_system_identifiers: Object.freeze([
      ...(entry.reserved_system_identifiers ?? []),
    ]),
    reserved_cluster_ids: Object.freeze([
      ...(entry.reserved_cluster_ids ?? []),
    ]),
    port: entry.port,
    database: entry.database,
    maintenance: roles.maintenance,
    roles,
    preserved: entry.preserved === true,
    protected_root: protectedRoot,
    signer: protectedRoot && join(protectedRoot, "signer"),
    watcher: protectedRoot && join(protectedRoot, entry.watcher_directory),
    evidence:
      protectedRoot &&
      (entry.preserved ? protectedRoot : join(protectedRoot, "evidence")),
  });
}
export function configuredTarget(env) {
  return approvedTarget(
    env.DARKPOOL_PG_ENV,
    env.LOCALAPPDATA,
    env.DARKPOOL_LIVE_INSTANCE,
  );
}
export function assertLiveComponent(env, role) {
  if (env.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE") return;
  const target = configuredTarget(env);
  if (
    target.preserved ||
    env.DARKPOOL_TEST_ONLY !== undefined ||
    !Object.hasOwn(target.roles, role) ||
    env.PGUSER !== target.roles[role] ||
    env.PGDATABASE !== target.database ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== String(target.port)
  )
    rejectTarget();
  return target;
}
export function assertMutableTarget(env = process.env) {
  if (env.DARKPOOL_PG_ENV === "HISTORICAL") rejectTarget();
  if (
    env.DARKPOOL_PG_ENV === "LIVE_EVIDENCE" &&
    configuredTarget(env).preserved
  )
    rejectTarget();
}
export function assertProvisionTarget(role, purpose, env = process.env) {
  assertMutableTarget(env);
  if (env.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE") return;
  const target = configuredTarget(env);
  if (
    role !== target.roles[purpose] ||
    ![target.roles.owner, target.roles.maintenance].includes(env.PGUSER) ||
    env.PGDATABASE !== target.database
  )
    rejectTarget();
}
export function liveWalletPath(env, purpose) {
  if (
    env.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE" ||
    !["signer", "watcher"].includes(purpose)
  )
    rejectTarget();
  const target = configuredTarget(env);
  if (target.preserved) rejectTarget();
  return join(target[purpose], "data.sqlite");
}
export function assertWalletTarget(env, purpose = "watcher") {
  if (env.DARKPOOL_PG_ENV === "HISTORICAL") rejectTarget();
  if (env.DARKPOOL_PG_ENV === "TEST") {
    if (env.DARKPOOL_LIVE_INSTANCE !== undefined) rejectTarget();
    if (env.LOCALAPPDATA && env.WALLET_DB_PATH) {
      const path = resolve(env.WALLET_DB_PATH)
        .replaceAll("\\", "/")
        .toLowerCase();
      for (const instance of liveInstances) {
        const target = approvedTarget(
          "LIVE_EVIDENCE",
          env.LOCALAPPDATA,
          instance,
        );
        if (
          path.startsWith(
            target.protected_root.replaceAll("\\", "/").toLowerCase() + "/",
          )
        )
          rejectTarget();
      }
    }
  }
  if (
    env.DARKPOOL_PG_ENV === "LIVE_EVIDENCE" &&
    (env.DARKPOOL_TEST_ONLY !== undefined ||
      !samePath(
        resolve(env.WALLET_DB_PATH || ""),
        liveWalletPath(env, purpose),
      ))
  )
    rejectTarget();
}
export function assertLiveInvocation(executable, args, env) {
  if (env.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE") return;
  const target = configuredTarget(env);
  if (target.preserved) rejectTarget();
  const old = approvedTarget(
    "LIVE_EVIDENCE",
    env.LOCALAPPDATA,
    "phase9_payment_v1",
  );
  const normalize = (value) =>
    String(value).replaceAll("\\", "/").toLowerCase();
  if (
    args.some((arg) =>
      [old.root, old.protected_root].some((path) =>
        normalize(arg).includes(normalize(path)),
      ),
    )
  )
    rejectTarget();
  const name = basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "zcash-devtool") {
    const expected = [
      "wallet",
      "--wallet-dir",
      target.signer,
      "init",
      "--name",
      "phase9-live-payment-v2",
      "--identity",
      join(target.signer, "identity.txt"),
      "-n",
      "test",
      "-s",
      "zecrocks",
      "--connection",
      "direct",
    ];
    if (
      args.length !== expected.length ||
      args.some((value, index) =>
        [2, 7].includes(index)
          ? !samePath(resolve(value), expected[index])
          : value !== expected[index],
      )
    )
      rejectTarget();
  }
  if (
    name === "phase1_view_import" &&
    (args.length !== 2 ||
      !samePath(resolve(args[0]), join(target.signer, "data.sqlite")) ||
      !samePath(resolve(args[1]), target.watcher))
  )
    rejectTarget();
  if (
    name === "age-keygen" &&
    (args.length !== 2 ||
      args[0] !== "-o" ||
      !samePath(resolve(args[1]), join(target.signer, "identity.txt")))
  )
    rejectTarget();
  if (env.WALLET_DB_PATH)
    assertWalletTarget(env, name === "zcash-devtool" ? "signer" : "watcher");
}
export function assertChildTarget(parent, child) {
  if (parent.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE" || !child) return;
  const target = configuredTarget(parent);
  if (
    (child.DARKPOOL_PG_ENV && child.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE") ||
    (child.DARKPOOL_LIVE_INSTANCE &&
      child.DARKPOOL_LIVE_INSTANCE !== target.instance)
  )
    rejectTarget();
  for (const [key, expected] of [
    ["PGHOST", "127.0.0.1"],
    ["PGPORT", String(target.port)],
    ["PGDATABASE", target.database],
  ])
    if (child[key] !== undefined && child[key] !== expected) rejectTarget();
  if (
    child.PGUSER !== undefined &&
    !Object.values(target.roles).includes(child.PGUSER)
  )
    rejectTarget();
  if (child.WALLET_DB_PATH !== undefined)
    assertWalletTarget({ ...parent, WALLET_DB_PATH: child.WALLET_DB_PATH });
}
export async function rejectRedirects(path) {
  for (let item = resolve(path); ; item = dirname(item)) {
    try {
      if (
        (await lstat(item)).isSymbolicLink() ||
        !samePath(await realpath(item), item)
      )
        rejectTarget();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (item === parse(item).root) break;
  }
}
export async function assertEvidenceTarget(directory, env) {
  if (env.DARKPOOL_PG_ENV === "HISTORICAL") rejectTarget();
  if (env.DARKPOOL_PG_ENV === "TEST" && env.LOCALAPPDATA) {
    const path = resolve(directory).replaceAll("\\", "/").toLowerCase();
    const prohibited = [
      resolve(env.LOCALAPPDATA, "ZcashDarkPoolDev", "postgres"),
    ];
    for (const instance of liveInstances) {
      const target = approvedTarget(
        "LIVE_EVIDENCE",
        env.LOCALAPPDATA,
        instance,
      );
      prohibited.push(target.root, target.protected_root);
    }
    if (
      prohibited.some(
        (root) =>
          path === root.replaceAll("\\", "/").toLowerCase() ||
          path.startsWith(root.replaceAll("\\", "/").toLowerCase() + "/"),
      )
    )
      rejectTarget();
  }
  if (env.DARKPOOL_PG_ENV !== "LIVE_EVIDENCE") return;
  const target = configuredTarget(env);
  const normalized = resolve(directory).replaceAll("\\", "/").toLowerCase();
  if (
    target.preserved ||
    !normalized.startsWith(
      target.evidence.replaceAll("\\", "/").toLowerCase() + "/",
    )
  )
    rejectTarget();
  await rejectRedirects(directory);
}
export function initializerPlan(kind, base, instance) {
  const target = approvedTarget(kind, base, instance);
  return Object.freeze({
    environment: kind,
    instance: instance ?? null,
    host: "127.0.0.1",
    port: target.port,
    database: target.database,
    root: target.root,
    data_directory: target.data,
    profile: target.profile,
    marker: target.marker,
    maintenance_user: target.maintenance,
    maintenance_credential: join(target.root, "maintenance.xml"),
    roles: target.roles,
    protected_root: target.protected_root ?? null,
    signer: target.signer ?? null,
    watcher: target.watcher ?? null,
    evidence: target.evidence ?? null,
    preserved: target.preserved,
    resource_creation: false,
  });
}

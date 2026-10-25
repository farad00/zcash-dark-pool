// Local PostgreSQL target isolation. This prevents target mistakes, not a malicious OS/database owner.
import {
  rejectTarget as deny,
  samePath as same,
  markerText,
  assertClusterIdentity,
  readClusterProfile,
  guardSql,
  guardedSql,
} from "./environment-identity.mjs";
import {
  testDatabase,
  assertFixtureSql,
  validateTestTarget,
} from "./environment-test.mjs";
export {
  markerText,
  assertClusterIdentity,
  guardSql,
  guardedSql,
  testDatabase,
  assertFixtureSql,
};
import { resolve, join } from "node:path";
import { approvedTarget } from "./target-registry.mjs";

export const isolationKeys = [
  "LOCALAPPDATA",
  "DARKPOOL_PG_ENV",
  "DARKPOOL_PG_PROFILE",
  "DARKPOOL_LIVE_INSTANCE",
  "DARKPOOL_TEST_ONLY",
];
export function environmentLayout(
  kind,
  base = process.env.LOCALAPPDATA,
  instance,
) {
  return approvedTarget(kind, base, instance);
}
export function validateEnvironment(
  profile,
  env,
  { database = env.PGDATABASE, requireKind } = {},
) {
  if (!profile || profile.version !== 1 || profile.kind === "HISTORICAL")
    deny();
  const layout = environmentLayout(
    profile.kind,
    env.LOCALAPPDATA,
    env.DARKPOOL_LIVE_INSTANCE,
  );
  if (
    env.DARKPOOL_PG_ENV !== profile.kind ||
    (requireKind && profile.kind !== requireKind) ||
    env.PGHOST !== "127.0.0.1" ||
    String(env.PGPORT) !== String(layout.port) ||
    profile.port !== layout.port ||
    profile.host !== "127.0.0.1" ||
    !same(resolve(profile.data_directory || ""), layout.data) ||
    !same(resolve(env.DARKPOOL_PG_PROFILE || ""), layout.profile) ||
    !/^[0-9]{16,20}$/.test(profile.system_identifier || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      profile.cluster_id || "",
    ) ||
    !profile.directory_identity ||
    !/^[0-9]+$/.test(profile.directory_identity.dev || "") ||
    !/^[0-9]+$/.test(profile.directory_identity.ino || "") ||
    profile.maintenance_user !== layout.maintenance ||
    (profile.instance !== undefined && profile.instance !== layout.instance) ||
    (layout.instance === "phase9_payment_v2" &&
      profile.instance !== layout.instance) ||
    (layout.expected_system_identifier &&
      profile.system_identifier !== layout.expected_system_identifier) ||
    (layout.expected_cluster_id &&
      profile.cluster_id !== layout.expected_cluster_id) ||
    layout.reserved_system_identifiers.includes(profile.system_identifier) ||
    layout.reserved_cluster_ids.includes(profile.cluster_id) ||
    !/^[A-Za-z0-9_]+$/.test(env.PGUSER || "") ||
    env.PGOPTIONS ||
    env.PGSERVICE ||
    env.PGSERVICEFILE ||
    env.PGHOSTADDR ||
    env.DATABASE_URL
  )
    deny();
  if (profile.kind === "TEST") {
    validateTestTarget(env, database, layout.maintenance);
  } else {
    if (
      env.DARKPOOL_TEST_ONLY ||
      (database !== "postgres" && database !== layout.database) ||
      !Object.values(layout.roles).includes(env.PGUSER) ||
      (env.PGPASSFILE &&
        !Object.entries(layout.roles).some(
          ([role, name]) =>
            name === env.PGUSER &&
            same(resolve(env.PGPASSFILE), join(layout.root, role + ".pgpass")),
        ))
    )
      deny();
  }
  return layout;
}
export async function loadEnvironmentGuard(env = process.env, options = {}) {
  const kind = env.DARKPOOL_PG_ENV;
  const layout = environmentLayout(
    kind,
    env.LOCALAPPDATA,
    env.DARKPOOL_LIVE_INSTANCE,
  );
  if (
    !env.DARKPOOL_PG_PROFILE ||
    !same(resolve(env.DARKPOOL_PG_PROFILE), layout.profile)
  )
    deny();
  const profile = await readClusterProfile(layout, (profile) =>
    validateEnvironment(profile, env, {
      ...options,
      requireKind:
        options.requireKind ||
        (process.env.NODE_TEST_CONTEXT ? "TEST" : undefined),
    }),
  );
  return {
    profile,
    prefix: guardSql(profile, options.database || env.PGDATABASE),
  };
}

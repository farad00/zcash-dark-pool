// Privileged disposable-fixture policy. Never reachable from the public reader.
import { rejectTarget } from "./environment-identity.mjs";
export const testDatabase = (name) =>
  /^darkpool_phase(?:3|4|5|7|9)_(?:open_|boundary_)?[a-f0-9]{16}$/.test(name);
const testRole = (name) => /^darkpool_[a-z0-9_]+_[a-f0-9]{16}$/.test(name);
export function validateTestTarget(env, database, maintenance) {
  if (
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    (env.PGUSER !== maintenance && !testRole(env.PGUSER)) ||
    (database !== "postgres" && !testDatabase(database))
  )
    rejectTarget();
}
export function assertFixtureSql(sql) {
  // Trusted fixed fixture statements, not an adversarial SQL sandbox.
  for (const m of sql.matchAll(
    /\b(CREATE|DROP)\s+(DATABASE|ROLE)\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
  )) {
    const name = m[3] || m[4];
    if (
      m[2].toUpperCase() === "DATABASE" ? !testDatabase(name) : !testRole(name)
    )
      rejectTarget();
  }
}

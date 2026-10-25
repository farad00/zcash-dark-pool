// Dedicated purpose transport; existing TEST/LIVE environment fences stay unchanged.
import { win32 } from "node:path";
import {
  readClusterProfile,
  validateIdentityProfile,
  guardSql,
  guardedSql,
} from "../../db/environment-identity.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { issuancePrivilegeCheck } from "../../db/issuance-runtime.mjs";
import { watcherPrivilegeCheck } from "../watcher/db.mjs";
import {
  publicPrivilegeCheck,
  publicMarketQuery,
} from "../../db/public-read.mjs";
import { statusPrivileges } from "./status.mjs";
import { validateConnection, reject } from "./target.mjs";
import { resolvePostgresTool } from "../rehearsal-preparation/postgresql-tools/resolver.mjs";
export { publicMarketQuery };
export function createGenuineQuery(
  env,
  purpose,
  resolveTool = resolvePostgresTool,
) {
  env = { ...env };
  const target = validateConnection(env, purpose);
  const layout = {
    root: target.root,
    data: win32.join(target.root, "postgres", "data"),
    profile: win32.join(target.root, "deposit-profile.json"),
    marker: win32.join(target.root, "cluster-marker.json"),
    instance: target.instance,
    port: target.port,
    reserved_system_identifiers: [
      "7698884242696928048",
      "7697706083887339692",
      "7697541254856017064",
    ],
  };
  const check = {
    issue: issuancePrivilegeCheck,
    watch: watcherPrivilegeCheck,
    status: statusPrivileges,
    read: publicPrivilegeCheck,
  }[purpose];
  const clean = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
  ])
    if (env[key] !== undefined) clean[key] = env[key];
  Object.assign(clean, {
    PGCONNECT_TIMEOUT: "3",
    PGCLIENTENCODING: "UTF8",
    PGAPPNAME: "darkpool-deposit-" + purpose,
  });
  return async (statement) => {
    try {
      if (
        typeof statement !== "string" ||
        Buffer.byteLength(statement) > 5 * 1024 * 1024 ||
        statement.includes("\\")
      )
        reject();
      const profile = await readClusterProfile(layout, (p) => {
        validateIdentityProfile(p, layout, "TESTNET_OBSERVATION");
        if (
          p.instance !== target.instance ||
          p.database !== target.database ||
          p.financial_authorization !== "NOT_GRANTED" ||
          p.maintenance_user !== "darkpool_obs_v1_maintenance"
        )
          reject();
      });
      const sql = `BEGIN ${["status", "read"].includes(purpose) ? "READ ONLY" : ""};
SET LOCAL statement_timeout='5s'; SET LOCAL TIME ZONE 'UTC';
${check} AS permitted \\gset
\\if :permitted
${statement}
COMMIT;
\\else
SELECT 1/0;
\\endif`;
      const tool = await resolveTool("context");
      const result = await runBounded(
        tool.executable,
        [
          "--no-psqlrc",
          "--no-password",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-v",
          "VERBOSITY=sqlstate",
          "-d",
          target.database,
        ],
        {
          env: clean,
          input: guardedSql(
            { prefix: guardSql(profile, target.database) },
            sql,
          ),
          timeoutMs: 10000,
          maxBytes: 8 * 1024 * 1024,
        },
      );
      if (
        boundedExit(result) !== 0 ||
        result.timedOut ||
        result.overflow ||
        result.spawnFailed
      )
        reject();
      return JSON.parse(result.stdout);
    } catch {
      reject();
    }
  };
}

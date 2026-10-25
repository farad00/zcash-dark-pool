// Reader-only startup binding. No fixture, acknowledgement or general runtime policy.
import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import identities from "./target-identities.json" with { type: "json" };
import {
  samePath,
  rejectTarget,
  validateIdentityProfile,
  readClusterProfile,
  markerText,
  guardSql,
  freezeIdentityData,
} from "./environment-identity.mjs";
freezeIdentityData(identities);

export function publicConnectionEnvironment(env) {
  if (
    env.ZCASH_NETWORK !== "testnet" ||
    env.PGHOST !== "127.0.0.1" ||
    !/^[0-9]{1,5}$/.test(env.PGPORT ?? "") ||
    Number(env.PGPORT) < 1 ||
    Number(env.PGPORT) > 65535 ||
    !/^[A-Za-z0-9_]+$/.test(env.PGDATABASE ?? "") ||
    !/^[A-Za-z0-9_]+$/.test(env.PGUSER ?? "") ||
    env.PGOPTIONS ||
    env.PGSERVICE ||
    env.PGSERVICEFILE ||
    env.PGHOSTADDR ||
    env.DATABASE_URL ||
    env.DARKPOOL_ADMIN_INTERNAL ||
    env.DARKPOOL_WATCHER_INTERNAL ||
    env.DARKPOOL_ISSUANCE_INTERNAL ||
    env.WALLET_DB_PATH
  )
    throw new Error("Market unavailable");
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
    "PGDATABASE",
    "PGPASSWORD",
    "PGPASSFILE",
  ])
    if (env[key] !== undefined) clean[key] = env[key];
  return {
    ...clean,
    PGCONNECT_TIMEOUT: "3",
    PGCLIENTENCODING: "UTF8",
    PGAPPNAME: "darkpool-public-read",
  };
}

async function freezeCredential(connection) {
  if (connection.PGPASSWORD) {
    delete connection.PGPASSFILE;
    return;
  }
  // No implicit per-request password-file lookup; retain just this reader credential.
  if (!connection.PGPASSFILE) rejectTarget();
  if (
    (await lstat(connection.PGPASSFILE)).isSymbolicLink() ||
    !samePath(
      await realpath(connection.PGPASSFILE),
      resolve(connection.PGPASSFILE),
    )
  )
    rejectTarget();
  const bytes = await readFile(connection.PGPASSFILE);
  if (bytes.length > 65536) rejectTarget();
  const lines = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length !== 1) rejectTarget();
  const fields = [];
  let field = "",
    escaped = false;
  for (const c of lines[0]) {
    if (escaped) {
      field += c;
      escaped = false;
    } else if (c === "\\") escaped = true;
    else if (c === ":") {
      fields.push(field);
      field = "";
    } else field += c;
  }
  fields.push(field);
  if (escaped || fields.length !== 5 || !fields[4]) rejectTarget();
  for (const [i, key] of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER"].entries())
    if (fields[i] !== "*" && fields[i] !== connection[key]) rejectTarget();
  connection.PGPASSWORD = fields[4];
  delete connection.PGPASSFILE;
}

export async function bindPublicReaderTarget(configuration) {
  // Copy before awaiting: the caller's environment object is never retained.
  const env = { ...configuration };
  const connection = publicConnectionEnvironment(env);
  const kind = env.DARKPOOL_PG_ENV;
  if (
    !env.LOCALAPPDATA ||
    !isAbsolute(env.LOCALAPPDATA) ||
    !["TEST", "LIVE_EVIDENCE"].includes(kind)
  )
    rejectTarget();
  const instance = env.DARKPOOL_LIVE_INSTANCE;
  if (kind === "LIVE_EVIDENCE" && typeof instance !== "string") rejectTarget();
  const entry =
    kind === "TEST"
      ? identities.TEST
      : Object.hasOwn(identities.LIVE_EVIDENCE, instance ?? "")
        ? identities.LIVE_EVIDENCE[instance]
        : undefined;
  if (!entry || (kind === "TEST" && instance !== undefined)) rejectTarget();
  // Inert allowlisted identity data only; no target-management/fixture API.
  const root =
    kind === "TEST"
      ? resolve(env.LOCALAPPDATA, "ZcashDarkPoolDev", "postgres-test")
      : resolve(
          env.LOCALAPPDATA,
          "ZcashDarkPoolDev",
          "postgres-live-evidence",
          entry.directory,
        );
  const layout = {
    root,
    data: join(root, "data"),
    profile: join(root, "profile.json"),
    marker: join(root, "cluster-marker.json"),
    port: entry.port,
    instance,
    expected_system_identifier: entry.system_identifier,
    expected_cluster_id: entry.cluster_id,
    reserved_system_identifiers: entry.reserved_system_identifiers,
    reserved_cluster_ids: entry.reserved_cluster_ids,
  };
  if (
    !env.DARKPOOL_PG_PROFILE ||
    !samePath(resolve(env.DARKPOOL_PG_PROFILE), layout.profile) ||
    Number(connection.PGPORT) !== layout.port ||
    ["postgres", "template0", "template1"].includes(connection.PGDATABASE) ||
    (kind === "LIVE_EVIDENCE" &&
      (connection.PGDATABASE !== entry.database ||
        connection.PGUSER !== entry.role_prefix + "read" ||
        (connection.PGPASSFILE &&
          !samePath(
            resolve(connection.PGPASSFILE),
            join(root, "read.pgpass"),
          ))))
  )
    rejectTarget();
  const validate = (profile) => {
    validateIdentityProfile(profile, layout, kind);
    if (profile.maintenance_user !== entry.role_prefix + "maintenance")
      rejectTarget();
  };
  const profile = await readClusterProfile(layout, validate);
  const identity = markerText(profile);
  await freezeCredential(connection);
  const prefix =
    guardSql(profile, connection.PGDATABASE) +
    `SELECT current_user='${connection.PGUSER}' AND session_user='${connection.PGUSER}' AS darkpool_reader_ok \\gset\n\\if :darkpool_reader_ok\n`;
  return Object.freeze({
    connection: Object.freeze(connection),
    executable: env.PSQL_PATH || "psql",
    prefix,
    async verify() {
      if (markerText(await readClusterProfile(layout, validate)) !== identity)
        rejectTarget();
    },
  });
}

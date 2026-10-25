// Shared identity checks only: no deployment selection, credentials or fixture policy.
import {
  readFile,
  realpath,
  stat,
  lstat,
  open,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";

export const rejectTarget = () => {
  throw new Error("POSTGRES_TARGET_REJECTED");
};
export const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export function freezeIdentityData(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeIdentityData(child);
    Object.freeze(value);
  }
  return value;
}
export function markerText(profile) {
  return JSON.stringify({
    version: 1,
    kind: profile.kind,
    cluster_id: profile.cluster_id,
    system_identifier: profile.system_identifier,
    data_directory: profile.data_directory,
    port: profile.port,
    directory_identity: profile.directory_identity,
    ...(profile.instance === undefined ? {} : { instance: profile.instance }),
  });
}
export function assertClusterIdentity(profile, facts) {
  if (
    String(facts.system_identifier) !== profile.system_identifier ||
    !samePath(
      resolve(facts.data_directory || ""),
      resolve(profile.data_directory),
    ) ||
    Number(facts.port) !== profile.port ||
    facts.marker !== markerText(profile)
  )
    rejectTarget();
}
export function validateIdentityProfile(profile, layout, kind) {
  if (
    !profile ||
    profile.version !== 1 ||
    profile.kind !== kind ||
    (profile.instance !== undefined && profile.instance !== layout.instance) ||
    (layout.instance === "phase9_payment_v2" &&
      profile.instance !== layout.instance) ||
    (layout.expected_system_identifier &&
      profile.system_identifier !== layout.expected_system_identifier) ||
    (layout.expected_cluster_id &&
      profile.cluster_id !== layout.expected_cluster_id) ||
    layout.reserved_system_identifiers?.includes(profile.system_identifier) ||
    layout.reserved_cluster_ids?.includes(profile.cluster_id) ||
    profile.host !== "127.0.0.1" ||
    profile.port !== layout.port ||
    !samePath(resolve(profile.data_directory || ""), layout.data) ||
    !/^[0-9]{16,20}$/.test(profile.system_identifier || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      profile.cluster_id || "",
    ) ||
    !profile.directory_identity ||
    !/^[0-9]+$/.test(profile.directory_identity.dev || "") ||
    !/^[0-9]+$/.test(profile.directory_identity.ino || "")
  )
    rejectTarget();
}
export async function readClusterProfile(layout, validate) {
  if (
    (await lstat(layout.profile)).isSymbolicLink() ||
    (await lstat(layout.marker)).isSymbolicLink()
  )
    rejectTarget();
  const profile = JSON.parse(await readFile(layout.profile, "utf8"));
  validate(profile);
  if (
    !samePath(await realpath(layout.data), layout.data) ||
    !samePath(await realpath(layout.root), layout.root)
  )
    rejectTarget();
  const directory = await stat(layout.data);
  if (
    !directory.isDirectory() ||
    String(directory.dev) !== profile.directory_identity.dev ||
    String(directory.ino) !== profile.directory_identity.ino
  )
    rejectTarget();
  const marker = JSON.parse(await readFile(layout.marker, "utf8"));
  if (JSON.stringify(marker) !== markerText(profile)) rejectTarget();
  // No externally linked WAL or tablespaces in these isolated environments.
  try {
    if ((await readdir(join(layout.data, "pg_tblspc"))).length) rejectTarget();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    if (
      !samePath(
        await realpath(join(layout.data, "pg_wal")),
        join(layout.data, "pg_wal"),
      )
    )
      rejectTarget();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const control = await open(join(layout.data, "global", "pg_control"), "r");
  const bytes = Buffer.alloc(8);
  try {
    if ((await control.read(bytes, 0, 8, 0)).bytesRead !== 8) rejectTarget();
  } finally {
    await control.close();
  }
  if (bytes.readBigUInt64LE().toString() !== profile.system_identifier)
    rejectTarget();
  return profile;
}
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
export function guardSql(profile, database) {
  // The owner-only postgres comment binds the actual server to the local control ID.
  return (
    "SELECT current_database()=" +
    literal(database) +
    " AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=" +
    profile.port +
    " AND shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database')=" +
    literal(markerText(profile)) +
    " AS darkpool_target_ok \\gset\n\\if :darkpool_target_ok\n"
  );
}
export function guardedSql(guard, sql) {
  return guard.prefix + sql + "\n\\else\n\\quit 3\n\\endif\n";
}

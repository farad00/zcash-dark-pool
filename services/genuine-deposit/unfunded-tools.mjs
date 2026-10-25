// Private full-layout copy. Never changes the staged-tool ACL allowlist.
import { readFile, readdir, lstat, mkdir, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, win32 } from "node:path";
import { rejectRedirects } from "../../db/target-registry.mjs";
import { verifyInstalledPostgresTools } from "../rehearsal-preparation/postgresql-tools/resolver.mjs";
import { layout, sha256, durableNew } from "./unfunded.mjs";
const inventoryHash =
  "16a59b60f7b18e8eddc8c95a935081a08d8419c760e9838c1a1fd173369ac2db";
export const mirrorRoot = () =>
  win32.join(layout().root, "postgres", "runtime-18.6-5");
export function validateInventory(bytes) {
  if (sha256(bytes) !== inventoryHash) throw Error("UNFUNDED_TOOLS_REJECTED");
  const m = JSON.parse(bytes);
  if (
    m.files.length !== 1585 ||
    m.directories.length !== 87 ||
    m.files.reduce((s, f) => s + f.size, 0) !== 147931704
  )
    throw Error("UNFUNDED_TOOLS_REJECTED");
  return m;
}
export async function checkTree(root, m) {
  const names = new Set([
    "inventory.json",
    ...m.files.map((f) => f.path),
    ...m.directories,
  ]);
  const walk = async (dir, prefix = "") => {
    await rejectRedirects(dir);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (!names.delete(rel) || e.isSymbolicLink())
        throw Error("UNFUNDED_TOOLS_REJECTED");
      if (e.isDirectory()) await walk(join(dir, e.name), rel + "/");
      else if (!e.isFile()) throw Error("UNFUNDED_TOOLS_REJECTED");
    }
  };
  await walk(root);
  if (names.size) throw Error("UNFUNDED_TOOLS_REJECTED");
  for (const f of m.files) {
    if (!/^[a-zA-Z0-9_./+-]+$/.test(f.path) || f.path.split("/").includes(".."))
      throw Error("UNFUNDED_TOOLS_REJECTED");
    const path = join(root, f.path);
    const s = await lstat(path);
    if (
      !s.isFile() ||
      s.size !== f.size ||
      sha256(await readFile(path)) !== f.sha256
    )
      throw Error("UNFUNDED_TOOLS_REJECTED");
  }
}
export async function createMirror() {
  const verified = await verifyInstalledPostgresTools();
  const bytes = await readFile(
    win32.join(verified.destination, "inventory.json"),
  );
  const manifest = validateInventory(bytes);
  const destination = mirrorRoot();
  await rejectRedirects(destination);
  await mkdir(destination); // Existing/partial copy fails; no adoption or retry.
  for (const d of manifest.directories) await mkdir(win32.join(destination, d));
  for (const f of manifest.files)
    await copyFile(
      win32.join(verified.destination, f.path),
      win32.join(destination, f.path),
      constants.COPYFILE_EXCL,
    );
  await durableNew(win32.join(destination, "inventory.json"), bytes);
  await checkTree(destination, manifest);
}
export async function resolveUnfundedTool(purpose) {
  const name = {
    context: "psql.exe",
    initialize: "initdb.exe",
    control: "pg_ctl.exe",
  }[purpose];
  if (!name) throw Error("UNFUNDED_TOOLS_REJECTED");
  const root = mirrorRoot();
  const manifest = validateInventory(
    await readFile(win32.join(root, "inventory.json")),
  );
  await checkTree(root, manifest);
  return { executable: win32.join(root, "bin", name) };
}

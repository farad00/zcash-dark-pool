// A disposable-only adapter over the tested cold PG + age/X25519 implementation.
// Controller state is sealed into the physical backup before clean shutdown.
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  session,
  controllerInventory,
  durableNew,
  verifyDisposable,
} from "./provisioner.mjs";
import { assertNoActiveOperation } from "./launcher.mjs";
import { decryptPhysical, storage } from "../../backup/physical.mjs";
import { digest } from "../../backup/crypto.mjs";
import { reject } from "./policy.mjs";
const backups = new WeakMap();
const q = (v) => "'" + v.replaceAll("'", "''") + "'";

export async function backupDisposable(cap) {
  const s = await session(cap),
    f = s.f;
  if (backups.has(cap) || f.running !== "source") reject();
  const state = await assertNoActiveOperation(cap);
  const files = await controllerInventory(cap);
  const manifest = {
    profile: "OBSERVATION_V1_DISPOSABLE_COLD_RECOVERY",
    source_nonce: cap.nonce,
    system_identifier: cap.system_identifier,
    database: cap.database,
    descriptor_sha256: cap.descriptor_sha256,
    files,
    quarantined: state.quarantined,
    financial_authorization: "NOT_GRANTED",
    restore_authorization: "QUARANTINED_NO_LAUNCH",
  };
  const payload = JSON.stringify(manifest);
  // The role password material stays inside the existing encrypted capsule only.
  await f.sql(
    "source",
    `BEGIN;CREATE TABLE recovery_probe.controller_recovery(value jsonb NOT NULL);
    INSERT INTO recovery_probe.controller_recovery VALUES(${q(payload)}::jsonb);
    REVOKE ALL ON recovery_probe.controller_recovery FROM PUBLIC;COMMIT;`,
  );
  f.expected = await f.summary("source");
  await f.stop("source");
  // Recheck after fencing all fixture writers. No running-directory copy.
  if (
    s.active ||
    JSON.stringify(await controllerInventory(cap)) !== JSON.stringify(files)
  )
    reject();
  const sealed = await f.backup();
  const receipt = Object.freeze({
    ...sealed.receipt,
    descriptor_sha256: cap.descriptor_sha256,
    controller_sha256: digest(Buffer.from(payload)),
    scope: "DISPOSABLE_TEST_ONLY",
    off_device_retention: "NOT_PROVEN",
    replacement_laptop: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  });
  backups.set(cap, { receipt, manifest, restored: false });
  await durableNew(
    join(f.roots[1], "observation-recovery-receipt.json"),
    Buffer.from(JSON.stringify(receipt)),
  );
  return receipt;
}
export async function checkRecoveryCiphertext(
  cap,
  { altered = false, wrongKey = false } = {},
) {
  const s = await session(cap),
    b = backups.get(cap);
  if (!b || typeof altered !== "boolean" || typeof wrongKey !== "boolean")
    reject();
  const ciphertext = Buffer.from(
    await readFile(join(s.f.roots[1], "cluster.age")),
  );
  if (altered) ciphertext[ciphertext.length - 1] ^= 1;
  const key = wrongKey
    ? "AGE-SECRET-KEY-1INVALID"
    : await readFile(join(s.f.roots[2], "recovery.identity"), "utf8");
  const value = await decryptPhysical(ciphertext, key, b.receipt);
  if (
    value.nonce !== cap.nonce ||
    value.system_identifier !== cap.system_identifier
  )
    reject();
  return {
    status: "AUTHENTICATED_DISPOSABLE_CIPHERTEXT",
    financial_authorization: "NOT_GRANTED",
  };
}
export async function restoreDisposable(cap) {
  const s = await session(cap),
    f = s.f,
    b = backups.get(cap);
  if (!b || b.restored || s.active || f.running || (await f.status("source")))
    reject();
  await checkRecoveryCiphertext(cap);
  await f.restore(); // Fresh separate directory, validated inventory, source stopped.
  await f.start("restored"); // Existing controller refuses concurrent identical source.
  await verifyDisposable(cap, "restored");
  const value = JSON.parse(
    await f.sql(
      "restored",
      "SELECT value FROM recovery_probe.controller_recovery;",
    ),
  );
  // jsonb reorders keys: compare fields and ordered files, not object serialization.
  for (const k of Object.keys(b.manifest)) {
    if (k === "files") continue;
    if (value[k] !== b.manifest[k]) reject();
  }
  if (
    !Array.isArray(value.files) ||
    value.files.length !== b.manifest.files.length
  )
    reject();
  const destination = join(f.root, "restored-controller-quarantine");
  await mkdir(destination); // Never overwrite/adopt any source or previous restore.
  for (let i = 0; i < value.files.length; i++) {
    const record = value.files[i],
      expected = b.manifest.files[i];
    if (
      record.path !== expected.path ||
      record.bytes !== expected.bytes ||
      record.sha256 !== expected.sha256
    )
      reject();
    const data = Buffer.from(record.bytes, "base64");
    if (digest(data) !== record.sha256) reject();
    await durableNew(join(destination, record.path), data);
  }
  await durableNew(
    join(destination, "RESTORE_QUARANTINE.json"),
    Buffer.from(
      JSON.stringify({
        status: "NOT_LAUNCHABLE",
        reason: "RESTORED_IDENTITY_REQUIRES_REVIEW",
        financial_authorization: "NOT_GRANTED",
      }),
    ),
  );
  await storage("check", f.root);
  const summary = await f.summary("restored");
  // Compare retained identity, role verifier and fixture records privately.
  if (JSON.stringify(summary) !== JSON.stringify(f.expected)) reject();
  b.restored = true;
  return Object.freeze({
    status: "DISPOSABLE_PHYSICAL_RESTORE_VERIFIED",
    system_identifier: cap.system_identifier,
    credentials: "SYNTHETIC_CONTEXT_LOGIN_VERIFIED",
    restored_controller: destination,
    controller_files_preserved: true,
    authorization: "QUARANTINED_NO_LAUNCH",
    source_stopped: true,
    off_device_retention: "NOT_PROVEN",
    replacement_laptop: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  });
}

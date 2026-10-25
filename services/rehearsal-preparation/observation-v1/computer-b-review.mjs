// Offline, read-only recovery review. No materialization, launch or authorization.
import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decryptPhysical, physicalOnly } from "../../backup/physical.mjs";
import { verifyRecoveryTransfer } from "./bootstrap-recovery.mjs";
import { sha256 } from "./bootstrap-plan.mjs";
const fail = () => {
  throw Error("SYNTHETIC_RECOVERY_REVIEW_REJECTED");
};
const agePath = fileURLToPath(
  new URL(
    "../../../.tools/backup-target/debug/darkpool-backup-age.exe",
    import.meta.url,
  ),
);
export async function reviewTransferredBackup({
  manifestBytes,
  ciphertext,
  manifestSha256,
  ageSha256,
  key,
}) {
  physicalOnly();
  if (
    !Buffer.isBuffer(manifestBytes) ||
    manifestBytes.length > 8192 ||
    !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(ageSha256 ?? "") ||
    sha256(manifestBytes) !== manifestSha256
  )
    fail();
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  verifyRecoveryTransfer(manifest, ciphertext);
  if (
    Buffer.from(JSON.stringify(manifest)).compare(manifestBytes) !== 0 ||
    [
      "7697706083887339692",
      "7697541254856017064",
      "7698884242696928048",
    ].includes(manifest.system_identifier)
  )
    fail();
  const st = await lstat(agePath);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.size > 64 * 1024 * 1024 ||
    sha256(await readFile(agePath)) !== ageSha256
  )
    fail();
  const common = {
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    operational_restore: "NOT_PROVEN",
    offline_custody: "OPERATOR_CHECK_REQUIRED",
  };
  if (key === undefined)
    return {
      ...common,
      status: "TRANSFER_INTEGRITY_ONLY",
      decryption: "NOT_PROVEN",
    };
  if (
    typeof key !== "string" ||
    !/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(key) ||
    key.length > 128
  )
    fail();
  const value = await decryptPhysical(ciphertext, key, manifest);
  if (
    value.expected?.descriptor_sha256 !== manifest.descriptor_sha256 ||
    value.expected?.journal_sha256 !== manifest.journal_sha256 ||
    value.tree.files.find(
      (f) => f.path === "observation-bootstrap-journal.json",
    )?.sha256 !== manifest.journal_sha256
  )
    fail();
  if (value.credentials.length !== 3) fail();
  for (const purpose of ["admin", "owner", "read"]) {
    const records = value.credentials.filter((c) => c?.purpose === purpose);
    if (
      records.length !== 1 ||
      Object.keys(records[0]).sort().join() !== "login,password,purpose" ||
      records[0].login !==
        `darkpool_physical_${purpose}_${manifest.nonce.slice(0, 16)}` ||
      !/^[a-f0-9]{64}$/.test(records[0].password ?? "")
    )
      fail();
  }
  return {
    ...common,
    status: "SYNTHETIC_BACKUP_DECRYPTION_AND_BINDINGS_VERIFIED",
    decryption: "VERIFIED_IN_MEMORY",
    system_identifier: manifest.system_identifier,
    inventory_sha256: manifest.inventory_sha256,
  };
}

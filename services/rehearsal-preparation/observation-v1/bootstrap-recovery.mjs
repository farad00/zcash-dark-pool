// Public metadata only. A transfer acknowledgement never authorizes creation.
import { proposal, proposalDigest } from "../plan.mjs";
import { freeze, rejectBootstrap, sha256 } from "./bootstrap-plan.mjs";
export function computerBRecoveryPlan() {
  const p = proposal();
  return freeze({
    profile: "OBSERVATION_V1_COMPUTER_B_RECOVERY_V1",
    destination: p.off_device_proposal.root,
    encryption: "AGE_X25519_AUTHENTICATED",
    sender_material: ["COLD_ENCRYPTED_CAPSULE", "PUBLIC_HASH_MANIFEST"],
    excluded: [
      "PLAINTEXT_PASSWORDS",
      "DPAPI_ONLY_RECOVERY",
      "SIGNER_KEYS",
      "WALLET_KEYS",
      "OFFLINE_RECOVERY_PRIVATE_KEY",
    ],
    recovery_key: "INDEPENDENT_OFFLINE_CUSTODY_NOT_CONFIGURED",
    restore: "FRESH_ISOLATED_QUARANTINE_SOURCE_FENCED_NO_AUTOMATIC_LAUNCH",
    actual_retention: "NOT_PROVEN",
    actual_computer_b_restore: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  });
}
export function recoveryTransferManifest(receipt) {
  if (
    !receipt ||
    receipt.scope !== "DISPOSABLE_BOOTSTRAP_ONLY" ||
    receipt.financial_authorization !== "NOT_GRANTED" ||
    receipt.descriptor_sha256 !== proposalDigest(proposal()) ||
    !/^[a-f0-9]{32}$/.test(receipt.nonce ?? "") ||
    !/^[0-9]{16,20}$/.test(receipt.system_identifier ?? "") ||
    ["inventory_sha256", "ciphertext_sha256", "journal_sha256"].some(
      (k) => !/^[a-f0-9]{64}$/.test(receipt[k] ?? ""),
    )
  )
    rejectBootstrap();
  return freeze({
    profile: "OBSERVATION_V1_TEST_RECOVERY_HANDOFF",
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    nonce: receipt.nonce,
    system_identifier: receipt.system_identifier,
    descriptor_sha256: receipt.descriptor_sha256,
    ciphertext_sha256: receipt.ciphertext_sha256,
    inventory_sha256: receipt.inventory_sha256,
    journal_sha256: receipt.journal_sha256,
    financial_authorization: "NOT_GRANTED",
    off_device_retention: "NOT_PROVEN",
  });
}
export function verifyRecoveryTransfer(manifest, ciphertext) {
  if (
    !Buffer.isBuffer(ciphertext) ||
    ciphertext.length === 0 ||
    ciphertext.length > 32 * 1024 * 1024 ||
    manifest?.profile !== "OBSERVATION_V1_TEST_RECOVERY_HANDOFF"
  )
    rejectBootstrap();
  const canonical = recoveryTransferManifest(manifest);
  if (
    Object.keys(manifest).sort().join() !==
      Object.keys(canonical).sort().join() ||
    Object.keys(canonical).some((k) => canonical[k] !== manifest[k]) ||
    sha256(ciphertext) !== manifest.ciphertext_sha256
  )
    rejectBootstrap();
  return {
    status: "CIPHERTEXT_INTEGRITY_ONLY",
    decryption: "NOT_PROVEN",
    off_device_retention: "NOT_PROVEN",
    financial_authorization: "NOT_GRANTED",
  };
}

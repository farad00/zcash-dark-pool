import { createHash } from "node:crypto";
import { canonicalData } from "../resolution/session.mjs";
const deny = () => {
  throw new Error("PAYOUT_CONTRACT_REJECTED");
};
const hex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const exact = (o, keys) => {
  if (
    !o ||
    Object.getPrototypeOf(o) !== Object.prototype ||
    Reflect.ownKeys(o).some(
      (k) =>
        typeof k !== "string" ||
        !Object.getOwnPropertyDescriptor(o, k)?.enumerable ||
        !("value" in Object.getOwnPropertyDescriptor(o, k)),
    ) ||
    Object.keys(o).sort().join(",") !== [...keys].sort().join(",")
  )
    deny();
};
export const PROVISIONAL_POLICY = Object.freeze({
  profile: "phase16-restricted-testnet-review-v1",
  network: "testnet",
  proposed_confirmations: 3,
  single_intent_batch: true,
  signing_enabled: false,
  submission_enabled: false,
  replacement_enabled: false,
});
export function checkDisabledTestnetPolicy(policy) {
  try {
    exact(policy, Object.keys(PROVISIONAL_POLICY));
    if (
      Object.entries(PROVISIONAL_POLICY).some(
        ([key, value]) => policy[key] !== value,
      )
    )
      deny();
    return PROVISIONAL_POLICY;
  } catch {
    deny();
  }
}

/** Byte integrity is NOT Zcash transaction-ID derivation, proof/signature
 * verification, wallet persistence, or a database commit acknowledgement. */
export function checkRetainedBytes(candidate, readback) {
  try {
    for (const a of [candidate, readback]) {
      exact(a, [
        "intent_id",
        "network",
        "transaction_id",
        "bytes_sha256",
        "raw_bytes",
      ]);
      if (
        typeof a.intent_id !== "string" ||
        !/^payout-intent:claim:[0-9a-f-]{36}$/.test(a.intent_id) ||
        a.network !== "testnet" ||
        !hex(a.transaction_id) ||
        !hex(a.bytes_sha256) ||
        !(a.raw_bytes instanceof Uint8Array) ||
        !a.raw_bytes.byteLength ||
        a.raw_bytes.byteLength > 2 * 1024 * 1024
      )
        deny();
      if (
        createHash("sha256").update(a.raw_bytes).digest("hex") !==
        a.bytes_sha256
      )
        deny();
    }
    if (
      candidate.intent_id !== readback.intent_id ||
      candidate.transaction_id !== readback.transaction_id ||
      candidate.bytes_sha256 !== readback.bytes_sha256 ||
      !Buffer.from(candidate.raw_bytes).equals(Buffer.from(readback.raw_bytes))
    )
      deny();
    return Object.freeze({
      kind: "ARTIFACT_BYTE_INTEGRITY_ONLY",
      intent_id: candidate.intent_id,
      transaction_id: candidate.transaction_id,
      bytes_sha256: candidate.bytes_sha256,
      signed_transaction_verified: false,
      durability_verified: false,
      spending_authorized: false,
    });
  } catch {
    deny();
  }
}

/** Read-only sequence assessment; cannot perform or authorize any side effect.
 * Unknown/misordered/contradictory submission history never permits a new TX. */
export function inspectBroadcastContract(journal) {
  try {
    exact(journal, ["intent_id", "execution_class", "artifact", "events"]);
    if (
      typeof journal.intent_id !== "string" ||
      !/^payout-intent:claim:[0-9a-f-]{36}$/.test(journal.intent_id) ||
      !["EXTERNAL", "SYNTHETIC_TEST"].includes(journal.execution_class) ||
      !Array.isArray(journal.events) ||
      journal.events.length > 128
    )
      deny();
    let retained = false,
      started = false,
      reason =
        journal.artifact === null ? "AWAIT_ARTIFACT" : "RETAINED_UNVERIFIED",
      quarantined = false;
    const seen = new Map();
    const allowed = [
      "ARTIFACT_RETAINED",
      "SUBMISSION_STARTED",
      "SUBMISSION_ACCEPTED",
      "SUBMISSION_UNCERTAIN",
      "PROCESS_INTERRUPTED",
      "CHAIN_INCLUSION",
      "CHAIN_REORG",
      "SPEND_CONFLICT",
    ];
    const artifact = journal.artifact;
    if (artifact !== null) {
      exact(artifact, ["transaction_id", "bytes_sha256", "retention_ref"]);
      if (
        !hex(artifact.transaction_id) ||
        !hex(artifact.bytes_sha256) ||
        typeof artifact.retention_ref !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(artifact.retention_ref)
      )
        deny();
    }
    for (const event of journal.events) {
      exact(event, ["event_key", "kind", "transaction_id", "bytes_sha256"]);
      if (
        typeof event.event_key !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(event.event_key) ||
        !allowed.includes(event.kind) ||
        (event.transaction_id !== null && !hex(event.transaction_id)) ||
        (event.bytes_sha256 !== null && !hex(event.bytes_sha256))
      )
        deny();
      const encoding = canonicalData(event);
      if (seen.has(event.event_key)) {
        if (seen.get(event.event_key) !== encoding) deny();
        continue;
      }
      seen.set(event.event_key, encoding);
      const conflict =
        artifact === null ||
        event.transaction_id !== artifact.transaction_id ||
        event.bytes_sha256 !== artifact.bytes_sha256;
      if (conflict) {
        quarantined = true;
        reason = "MISSING_OR_CONFLICTING_IDENTITY";
        continue;
      }
      if (event.kind === "ARTIFACT_RETAINED") {
        if (started) {
          quarantined = true;
          reason = "RETENTION_ORDER_CONFLICT";
        } else retained = true;
      } else if (event.kind === "SUBMISSION_STARTED") {
        if (!retained || started) {
          quarantined = true;
          reason = "MISSING_OR_DUPLICATE_SUBMISSION_MARKER";
        } else started = true;
      } else if (event.kind === "SUBMISSION_ACCEPTED") {
        if (!started) {
          quarantined = true;
          reason = "MISSING_SUBMISSION_MARKER";
        } else if (!quarantined) reason = "AWAIT_CANONICAL_VERIFIER";
      } else if (event.kind === "CHAIN_INCLUSION") {
        if (!started) {
          quarantined = true;
          reason = "MISSING_SUBMISSION_MARKER";
        } else if (!quarantined) reason = "AWAIT_CANONICAL_VERIFIER";
      } else {
        quarantined = true;
        reason = "RECONCILIATION_REQUIRED";
      }
    }
    // A submission-start marker without a retained result is itself uncertain.
    if (started && reason === "RETAINED_UNVERIFIED") {
      quarantined = true;
      reason = "SUBMISSION_RESULT_UNKNOWN";
    }
    return Object.freeze({
      kind: "READ_ONLY_BROADCAST_CONTRACT",
      intent_id: journal.intent_id,
      reason,
      reconciliation_required: quarantined,
      spending_authorized: false,
      signing_enabled: false,
      submission_enabled: false,
      replacement_authorized: false,
      confirmation_authorized: false,
    });
  } catch {
    deny();
  }
}

/** Checks consistency/depth of CLAIMED evidence only; canonical chain validation
 * belongs to a maintained wallet/chain adapter which is presently unavailable. */
export function inspectClaimedChainDepth(e) {
  try {
    exact(e, [
      "network",
      "transaction_id",
      "tip_height",
      "tip_hash",
      "inclusion_height",
      "inclusion_hash",
      "canonical_hash_at_inclusion",
      "synchronized_to_tip_hash",
      "transaction_status",
    ]);
    const height = (s) => {
      if (
        typeof s !== "string" ||
        !/^(0|[1-9][0-9]{0,9})$/.test(s) ||
        BigInt(s) > 4294967295n
      )
        deny();
      return BigInt(s);
    };
    if (
      e.network !== "testnet" ||
      !hex(e.transaction_id) ||
      !hex(e.tip_hash) ||
      !hex(e.synchronized_to_tip_hash) ||
      !["Mined", "NotInMainChain", "TxidNotRecognized"].includes(
        e.transaction_status,
      )
    )
      deny();
    const tip = height(e.tip_height);
    let depth = 0n,
      reconcile =
        e.transaction_status !== "Mined" ||
        e.tip_hash !== e.synchronized_to_tip_hash;
    if (e.transaction_status === "Mined") {
      const mined = height(e.inclusion_height);
      if (!hex(e.inclusion_hash) || !hex(e.canonical_hash_at_inclusion)) deny();
      if (mined > tip || e.inclusion_hash !== e.canonical_hash_at_inclusion)
        reconcile = true;
      else depth = tip - mined + 1n;
    } else if (
      e.inclusion_height !== null ||
      e.inclusion_hash !== null ||
      e.canonical_hash_at_inclusion !== null
    )
      reconcile = true;
    return Object.freeze({
      kind: "UNVERIFIED_CHAIN_DEPTH",
      claimed_confirmations: depth.toString(),
      proposed_threshold: 3,
      depth_sufficient: !reconcile && depth >= 3n,
      reconciliation_required: reconcile,
      canonical_evidence_verified: false,
      confirmation_authorized: false,
    });
  } catch {
    deny();
  }
}

// Missing adapters are explicit dependencies, not caller-supplied verified flags.
export function unavailableExecutionDependencies() {
  return Object.freeze({
    fee_reserve: "UNAVAILABLE",
    signed_artifact_verifier: "UNAVAILABLE",
    durable_wallet_association: "UNAVAILABLE",
    exclusive_signer_control: "UNAVAILABLE",
    canonical_chain_verifier: "UNAVAILABLE",
    settlement_plan_profile: "UNAVAILABLE",
  });
}

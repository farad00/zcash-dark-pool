import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  PROVISIONAL_POLICY,
  checkDisabledTestnetPolicy,
  checkRetainedBytes,
  inspectBroadcastContract,
  inspectClaimedChainDepth,
  unavailableExecutionDependencies,
} from "../contracts.mjs";
import { previewPayoutAuthorization } from "../review.mjs";
const id = (n) => n.toString(16).padStart(64, "0");
const intent = "payout-intent:claim:00000000-0000-4000-8000-000000000001";
const bytes = () => new Uint8Array([0, 1, 2, 3]); // NOT a signed or valid Zcash transaction.
const digest = createHash("sha256").update(bytes()).digest("hex");
const artifact = () => ({
  intent_id: intent,
  network: "testnet",
  transaction_id: id(9),
  bytes_sha256: digest,
  raw_bytes: bytes(),
});
const retained = () => ({
  transaction_id: id(9),
  bytes_sha256: digest,
  retention_ref: "synthetic_commit_reference",
});
const event = (kind, key = kind) => ({
  event_key: key,
  kind,
  transaction_id: id(9),
  bytes_sha256: digest,
});
const journal = (events) => ({
  intent_id: intent,
  execution_class: "SYNTHETIC_TEST",
  artifact: retained(),
  events,
});
const rejected = (fn) =>
  assert.throws(fn, (e) => e.message === "PAYOUT_CONTRACT_REJECTED");
const disabled = (result) => {
  for (const key of [
    "spending_authorized",
    "signing_enabled",
    "submission_enabled",
    "replacement_authorized",
    "confirmation_authorized",
  ])
    if (key in result) assert.equal(result[key], false);
};
const chain = (tip = "102") => ({
  network: "testnet",
  transaction_id: id(9),
  tip_height: tip,
  tip_hash: id(102),
  inclusion_height: "100",
  inclusion_hash: id(100),
  canonical_hash_at_inclusion: id(100),
  synchronized_to_tip_hash: id(102),
  transaction_status: "Mined",
});

test("testnet provisional policy cannot enable signing, submission, replacement or another threshold", () => {
  assert.equal(
    checkDisabledTestnetPolicy({ ...PROVISIONAL_POLICY }),
    PROVISIONAL_POLICY,
  );
  for (const patch of [
    { network: "mainnet" },
    { proposed_confirmations: 0 },
    { proposed_confirmations: 2 },
    { proposed_confirmations: 10 },
    { proposed_confirmations: "3" },
    { signing_enabled: true },
    { submission_enabled: true },
    { replacement_enabled: true },
    { fee_verified: true },
    { single_intent_batch: false },
  ])
    rejected(() =>
      checkDisabledTestnetPolicy({ ...PROVISIONAL_POLICY, ...patch }),
    );
  const cyclic = {};
  cyclic.self = cyclic;
  rejected(() =>
    checkDisabledTestnetPolicy({ ...PROVISIONAL_POLICY, network: cyclic }),
  );
});

test("production, wrong-network and missing internal transport authority fail before operator SQL", async () => {
  for (const env of [
    {
      APP_ENV: "production",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
    },
    {
      APP_ENV: "development",
      ZCASH_NETWORK: "mainnet",
      DARKPOOL_LOCK_INTERNAL: "1",
    },
    { APP_ENV: "development", ZCASH_NETWORK: "testnet" },
  ])
    await assert.rejects(
      previewPayoutAuthorization(intent, env),
      (e) => e.message === "PAYOUT_REVIEW_REJECTED",
    );
});
test("matching byte readback proves neither signatures, native TXID nor durable commit", () => {
  const result = checkRetainedBytes(artifact(), artifact());
  assert.equal(result.signed_transaction_verified, false);
  assert.equal(result.durability_verified, false);
  disabled(result);
  assert.equal("raw_bytes" in result, false);
});
test("modified/truncated bytes, digest, transaction identity or intent cannot pass retention check", () => {
  for (const patch of [
    { raw_bytes: new Uint8Array([0, 1]) },
    { bytes_sha256: id(6) },
    { transaction_id: id(7) },
    { intent_id: intent.replace(/1$/, "2") },
    { network: "mainnet" },
    { raw_bytes: new Uint8Array() },
    { raw_bytes: new Uint8Array(2 * 1024 * 1024 + 1) },
  ])
    rejected(() => checkRetainedBytes(artifact(), { ...artifact(), ...patch }));
});
test("booleans cannot claim a signed or durably committed artifact", () => {
  for (const key of [
    "verified",
    "signed",
    "commit_acknowledged",
    "spending_authorized",
  ])
    rejected(() =>
      checkRetainedBytes({ ...artifact(), [key]: true }, artifact()),
    );
});
test("no artifact means no permission to submit or reconstruct", () => {
  const result = inspectBroadcastContract({ ...journal([]), artifact: null });
  assert.equal(result.reason, "AWAIT_ARTIFACT");
  disabled(result);
});
test("retained unverified bytes are not a broadcast authorization", () => {
  const result = inspectBroadcastContract(
    journal([event("ARTIFACT_RETAINED")]),
  );
  assert.equal(result.reason, "RETAINED_UNVERIFIED");
  disabled(result);
});
test("submission requires retained identity and a preceding marker in its contract", () => {
  for (const events of [
    [event("SUBMISSION_STARTED")],
    [event("SUBMISSION_ACCEPTED")],
    [event("CHAIN_INCLUSION")],
    [event("SUBMISSION_STARTED"), event("ARTIFACT_RETAINED")],
  ]) {
    const result = inspectBroadcastContract(journal(events));
    assert.equal(result.reconciliation_required, true);
    disabled(result);
  }
});
test("crash after submission marker is ambiguous without an accepted result", () => {
  const result = inspectBroadcastContract(
    journal([event("ARTIFACT_RETAINED"), event("SUBMISSION_STARTED")]),
  );
  assert.equal(result.reason, "SUBMISSION_RESULT_UNKNOWN");
  assert.equal(result.reconciliation_required, true);
  disabled(result);
});
test("accepted submission and inclusion still cannot confirm payment", () => {
  const result = inspectBroadcastContract(
    journal([
      event("ARTIFACT_RETAINED"),
      event("SUBMISSION_STARTED"),
      event("SUBMISSION_ACCEPTED"),
      event("CHAIN_INCLUSION"),
    ]),
  );
  assert.equal(result.reason, "AWAIT_CANONICAL_VERIFIER");
  disabled(result);
});
test("uncertainty, process interruption, reorg or conflicting spend cannot be cleared by later acceptance", () => {
  for (const kind of [
    "SUBMISSION_UNCERTAIN",
    "PROCESS_INTERRUPTED",
    "CHAIN_REORG",
    "SPEND_CONFLICT",
  ]) {
    const result = inspectBroadcastContract(
      journal([
        event("ARTIFACT_RETAINED"),
        event("SUBMISSION_STARTED"),
        event(kind),
        event("SUBMISSION_ACCEPTED"),
      ]),
    );
    assert.equal(result.reconciliation_required, true);
    disabled(result);
  }
});
test("a different transaction, different bytes or unknown identity always quarantines", () => {
  for (const patch of [
    { transaction_id: id(8) },
    { bytes_sha256: id(8) },
    { transaction_id: null },
    { bytes_sha256: null },
  ]) {
    const result = inspectBroadcastContract(
      journal([
        event("ARTIFACT_RETAINED"),
        { ...event("SUBMISSION_STARTED"), ...patch },
      ]),
    );
    assert.equal(result.reconciliation_required, true);
    disabled(result);
  }
});
test("identical event retries are idempotent; conflicting event reuse or a second submission marker rejects", () => {
  const e = event("ARTIFACT_RETAINED");
  assert.deepEqual(
    inspectBroadcastContract(journal([e, e])),
    inspectBroadcastContract(journal([e])),
  );
  rejected(() =>
    inspectBroadcastContract(
      journal([e, { ...e, kind: "SUBMISSION_STARTED" }]),
    ),
  );
  const result = inspectBroadcastContract(
    journal([
      e,
      event("SUBMISSION_STARTED"),
      event("SUBMISSION_STARTED", "again"),
    ]),
  );
  assert.equal(result.reconciliation_required, true);
  disabled(result);
});
test("inclusive candidate depths zero/one/two/three mirror the native wallet convention", () => {
  for (const [tip, depth, enough] of [
    ["100", "1", false],
    ["101", "2", false],
    ["102", "3", true],
    ["103", "4", true],
  ]) {
    const result = inspectClaimedChainDepth(chain(tip));
    assert.equal(result.claimed_confirmations, depth);
    assert.equal(result.depth_sufficient, enough);
    assert.equal(result.canonical_evidence_verified, false);
    disabled(result);
  }
});
test("stale sync, wrong canonical hash or future inclusion requires reconciliation", () => {
  for (const patch of [
    { synchronized_to_tip_hash: id(999) },
    { canonical_hash_at_inclusion: id(999) },
    { inclusion_height: "103" },
  ]) {
    const result = inspectClaimedChainDepth({ ...chain(), ...patch });
    assert.equal(result.reconciliation_required, true);
    assert.equal(result.depth_sufficient, false);
    disabled(result);
  }
});
test("unmined/reorged/not-recognized status is not proof that replacement is safe", () => {
  for (const status of ["NotInMainChain", "TxidNotRecognized"]) {
    const result = inspectClaimedChainDepth({
      ...chain(),
      transaction_status: status,
      inclusion_height: null,
      inclusion_hash: null,
      canonical_hash_at_inclusion: null,
    });
    assert.equal(result.claimed_confirmations, "0");
    assert.equal(result.reconciliation_required, true);
    disabled(result);
  }
});
test("chain candidates reject malformed heights, wrong networks, bypass flags and unbounded/ambiguous data", () => {
  for (const patch of [
    { tip_height: 102 },
    { tip_height: "0102" },
    { tip_height: "4294967296" },
    { tip_height: "1.5" },
    { network: "mainnet" },
    { verified: true },
    { transaction_status: "CONFIRMED" },
    { transaction_id: "secret" },
  ])
    rejected(() => inspectClaimedChainDepth({ ...chain(), ...patch }));
  rejected(() => inspectBroadcastContract({ ...journal([]), verified: true }));
  rejected(() =>
    inspectBroadcastContract(
      journal(Array.from({ length: 129 }, () => event("ARTIFACT_RETAINED"))),
    ),
  );
});
test("EXTERNAL labels and forged receipts do not provide missing verification adapters", () => {
  const result = inspectBroadcastContract({
    ...journal([
      event("ARTIFACT_RETAINED"),
      event("SUBMISSION_STARTED"),
      event("SUBMISSION_ACCEPTED"),
    ]),
    execution_class: "EXTERNAL",
  });
  disabled(result);
  assert.ok(
    Object.values(unavailableExecutionDependencies()).every(
      (v) => v === "UNAVAILABLE",
    ),
  );
});
test("closed byte schemas reject accessors without evaluating them or exposing their contents", () => {
  const candidate = artifact();
  let accessed = false;
  Object.defineProperty(candidate, "raw_bytes", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error("private_fixture");
    },
  });
  rejected(() => checkRetainedBytes(candidate, artifact()));
  assert.equal(accessed, false);
});

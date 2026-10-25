import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  createBootstrapRehearsal,
  runBootstrapRehearsal,
  inspectBootstrap,
  disposeBootstrapRehearsal,
  bootstrapDenialProbe,
  backupBootstrap,
  verifyBootstrapCiphertext,
  restoreBootstrap,
  exportBootstrapRecoveryFixture,
} from "../bootstrap.mjs";
import { recoveryTransferManifest } from "../bootstrap-recovery.mjs";
import { sha256 } from "../bootstrap-plan.mjs";
import {
  createComputerBRehearsal,
  receiveComputerBFixture,
  reviewComputerBFixture,
  disposeComputerBRehearsal,
} from "../computer-b-recovery.mjs";
import { copiedComputerBReview } from "./computer-b-copy-fixture.mjs";
const caps = [];
let cap, receipt;
const fresh = async () => {
  const c = await createBootstrapRehearsal();
  caps.push(c);
  return c;
};
before(async () => {
  cap = await fresh();
});
after(async () => {
  const failures = [];
  for (const c of caps.reverse()) {
    let result;
    try {
      result = await disposeBootstrapRehearsal(c);
    } catch {
      result = { cleaned: false };
    }
    console.log(
      "BOOTSTRAP_FIXTURE_CLEANUP " +
        JSON.stringify({ root: c.root, ...result }),
    );
    if (result.cleaned) await assert.rejects(lstat(c.root));
    else failures.push(c.root);
  }
  assert.deepEqual(
    failures,
    [],
    "Uncertain fixture identities must be preserved for review",
  );
});
test("attempt is absent before initialization; cloned capability cannot initialize", async () => {
  assert.equal((await inspectBootstrap(cap)).status, "NOT_ATTEMPTED");
  await assert.rejects(runBootstrapRehearsal({ ...cap }));
});
test("real disposable PG bootstraps status-only schema, seals identity and stops", async () => {
  const r = await runBootstrapRehearsal(cap);
  assert.equal(r.status, "STOPPED_SEALED");
  assert.equal(r.entries.length, 6);
  assert.match(r.system_identifier, /^[0-9]{16,20}$/);
  assert.equal(r.financial_authorization, "NOT_GRANTED");
});
test("replay cannot change sealed journals or generate another cluster", async () => {
  const prior = await inspectBootstrap(cap);
  await assert.rejects(runBootstrapRehearsal(cap));
  assert.deepEqual(await inspectBootstrap(cap), prior);
});
test("retained event tampering is rejected without replacing the original attempt", async () => {
  const path = join(cap.root, "02-SCHEMA_COMMITTED.json"),
    original = await readFile(path);
  const changed = JSON.parse(original);
  changed.previous_sha256 = "0".repeat(64);
  try {
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(inspectBootstrap(cap));
  } finally {
    await writeFile(path, original);
  }
  assert.equal((await inspectBootstrap(cap)).status, "STOPPED_SEALED");
});
test("cold age backup retains credentials and immutable bootstrap journal without claiming off-device recovery", async () => {
  receipt = await backupBootstrap(cap);
  assert.equal(receipt.off_device_retention, "NOT_PROVEN");
  assert.match(receipt.ciphertext_sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    (await verifyBootstrapCiphertext(cap)).status,
    "AUTHENTICATED_COLD_BACKUP",
  );
  await assert.rejects(backupBootstrap(cap));
});
test("altered ciphertext and wrong recovery key are rejected", async () => {
  await assert.rejects(verifyBootstrapCiphertext(cap, { wrongKey: true }));
  await assert.rejects(verifyBootstrapCiphertext(cap, { altered: true }));
});
test("Computer B fixture decrypts a real cold TEST cluster and retains its identity/journal in quarantine", async () => {
  const bundle = await exportBootstrapRecoveryFixture(cap),
    b = await createComputerBRehearsal();
  try {
    const manifest = recoveryTransferManifest(bundle.receipt);
    const verified = await copiedComputerBReview({
      manifest,
      ciphertext: bundle.ciphertext,
      manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
      key: bundle.syntheticKey,
    });
    assert.equal(verified.decryption, "VERIFIED_IN_MEMORY");
    await receiveComputerBFixture(
      b,
      manifest,
      bundle.ciphertext,
      sha256(Buffer.from(JSON.stringify(manifest))),
    );
    const result = await reviewComputerBFixture(b, bundle.syntheticKey, {
      sourceFenced: true,
    });
    assert.equal(result.authorization, "QUARANTINED_NO_LAUNCH");
    const report = JSON.parse(
      await readFile(join(b.root, "restore-readiness.json")),
    );
    assert.equal(report.system_identifier, receipt.system_identifier);
    assert.equal(report.inventory_sha256, receipt.inventory_sha256);
    assert.equal(report.offline_custody, "NOT_PROVEN");
  } finally {
    assert.deepEqual(await disposeComputerBRehearsal(b), { cleaned: true });
    console.log(
      "COMPUTER_B_FIXTURE_CLEANUP " +
        JSON.stringify({ root: b.root, cleaned: true }),
    );
  }
});
test("physical restore retains identity with bootstrap login disabled and remains quarantined", async () => {
  const r = await restoreBootstrap(cap);
  assert.equal(r.system_identifier, receipt.system_identifier);
  assert.equal(r.status, "RESTORED_QUARANTINED_NO_LAUNCH");
  await assert.rejects(restoreBootstrap(cap));
});
for (const fault of [
  "after_attempt",
  "after_initialization",
  "schema_transaction",
  "after_schema",
  "before_completion",
]) {
  test(
    "interruption preserves durable attempt and refuses automatic recovery: " +
      fault,
    async () => {
      const c = await fresh();
      await assert.rejects(
        runBootstrapRehearsal(c, { fault }),
        (e) => fault !== "schema_transaction" || e.rollback_verified === true,
      );
      const prior = await inspectBootstrap(c);
      assert.equal(prior.status, "QUARANTINED_NO_RETRY");
      await assert.rejects(runBootstrapRehearsal(c));
      assert.deepEqual(await inspectBootstrap(c), prior);
      if (fault === "after_schema") {
        for (const name of [
          "table",
          "create",
          "mutate",
          "owner",
          "acceptance",
          "payout",
          "other_database",
        ])
          await assert.rejects(bootstrapDenialProbe(c, name));
      }
    },
  );
}
test("concurrent submissions produce one exclusive attempt and one initialized cluster", async () => {
  const c = await fresh();
  const r = await Promise.allSettled([
    runBootstrapRehearsal(c),
    runBootstrapRehearsal(c),
  ]);
  assert.equal(
    r.filter((v) => v.status === "fulfilled").length,
    1,
    JSON.stringify({
      journal: await inspectBootstrap(c),
      failures: r
        .filter((v) => v.status === "rejected")
        .map((v) => ({
          code: v.reason.code ?? "NONE",
          exit_code: v.reason.exitCode ?? null,
        })),
    }),
  );
  assert.equal(r.filter((v) => v.status === "rejected").length, 1);
  assert.equal((await inspectBootstrap(c)).entries.length, 6);
});
test("malformed attempt is not overwritten or interpreted as permission to retry", async () => {
  const c = await fresh(),
    path = join(c.root, "00-attempt.json");
  await writeFile(path, "PARTIAL_SYNTHETIC_ATTEMPT", { flag: "wx" });
  await assert.rejects(runBootstrapRehearsal(c));
  assert.equal(await readFile(path, "utf8"), "PARTIAL_SYNTHETIC_ATTEMPT");
  await assert.rejects(inspectBootstrap(c));
});

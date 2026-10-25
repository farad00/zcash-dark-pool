import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, lstat, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  provisionDisposable,
  verifyDisposable,
  denialProbe,
  disposeDisposable,
  session,
  controllerInventory,
} from "../provisioner.mjs";
import { launchFixture, inspectController } from "../launcher.mjs";
import {
  backupDisposable,
  restoreDisposable,
  checkRecoveryCiphertext,
} from "../recovery.mjs";
import { storage } from "../../../backup/physical.mjs";
let cap, receipt;
const created = [];
const fresh = async () => {
  const c = await provisionDisposable();
  created.push(c);
  return c;
};
before(async () => {
  cap = await fresh();
});
after(async () => {
  for (const c of created.reverse()) {
    const result = await disposeDisposable(c);
    process.stdout.write(
      "OBSERVATION_V1_FIXTURE_CLEANUP " +
        JSON.stringify({
          root: c.root,
          port: c.port,
          database: c.database,
          system_identifier: c.system_identifier,
          ...result,
        }) +
        "\n",
    );
    assert.equal(
      result.cleaned,
      true,
      "Uncertain resources must remain stopped for review",
    );
    await assert.rejects(lstat(c.root));
  }
});
test("fresh cluster is ephemeral, identity bound and outside every protected port", async () => {
  assert.ok(cap.port >= 49152 && cap.port <= 65535);
  assert.equal(
    [55432, 55433, 55434, 55435, 55436, 5432].includes(cap.port),
    false,
  );
  assert.match(cap.system_identifier, /^[0-9]{16,20}$/);
  assert.equal(
    (await verifyDisposable(cap)).runtime_access,
    "CONTEXT_FUNCTION_ONLY",
  );
});
test("owner NOLOGIN; context login has no table, create, membership or finance authority", async () => {
  for (const name of [
    "table",
    "create",
    "mutation",
    "owner",
    "acceptance",
    "payout",
    "other_database",
  ])
    await assert.rejects(denialProbe(cap, name));
  assert.equal(
    (await verifyDisposable(cap)).financial_authorization,
    "NOT_GRANTED",
  );
});
test("forged scopes and protected-root substitutions fail before launch/cleanup", async () => {
  await assert.rejects(launchFixture({ ...cap }, "scan"));
  await assert.rejects(
    disposeDisposable({
      ...cap,
      root: "C:\\ProgramData\\ZcashDarkPoolRehearsal\\testnet_observation_v1",
    }),
  );
});
test("protected and persistent ports fail before any cluster start", async () => {
  const s = await session(cap),
    original = s.f.port;
  try {
    for (const port of [5432, 55432, 55433, 55434, 55435, 55436]) {
      s.f.port = port;
      await assert.rejects(s.f.start("source"), /OBSERVATION_V1_REJECTED/);
    }
  } finally {
    s.f.port = original;
  }
  await verifyDisposable(cap);
});
test("prohibited operation names and arbitrary executable options never spawn", async () => {
  for (const name of [
    "issuer",
    "sync-all",
    "reconcile",
    "sign",
    "broadcast",
    "payout",
  ])
    await assert.rejects(launchFixture(cap, name));
  await assert.rejects(launchFixture(cap, "scan", { fault: "execute-wallet" }));
  await assert.rejects(
    launchFixture(cap, "scan", { executable: process.execPath }),
  );
  await assert.rejects(provisionDisposable({ root: cap.root }));
  assert.equal((await inspectController(cap, "scan")).status, "NOT_ATTEMPTED");
});
test("purpose-bound child is stateless and cannot inherit PG/wallet/GitHub credentials", async () => {
  process.env.DARKPOOL_GITHUB_TOKEN = "SYNTHETIC_SENTINEL_NOT_A_TOKEN";
  process.env.WALLET_DB_PATH = "SYNTHETIC_NOT_A_PATH";
  try {
    assert.equal(
      (await launchFixture(cap, "allocation")).status,
      "COMPLETED_SYNTHETIC_ONLY",
    );
  } finally {
    delete process.env.DARKPOOL_GITHUB_TOKEN;
    delete process.env.WALLET_DB_PATH;
  }
  const files = await controllerInventory(cap);
  assert.equal(JSON.stringify(files).includes("SYNTHETIC_SENTINEL"), false);
});
test("identical successful retry retains exact journal and creates no new child", async () => {
  const before = await controllerInventory(cap);
  assert.equal(
    (await launchFixture(cap, "allocation")).status,
    "COMPLETED_SYNTHETIC_ONLY",
  );
  assert.deepEqual(await controllerInventory(cap), before);
});
test("concurrent same-purpose calls retain one child and attempt, including a completion replay", async () => {
  const results = await Promise.allSettled([
    launchFixture(cap, "scan"),
    launchFixture(cap, "scan"),
  ]);
  // Preconditions include asynchronous database/ACL checks. The second caller
  // may reach the completion guard after the first has finished: that is the
  // established idempotent retry, not a second launch. Assert durable identities.
  const completed = results.filter((r) => r.status === "fulfilled");
  assert.ok(completed.length >= 1 && completed.length <= 2);
  for (const r of completed) {
    assert.equal(r.value.status, "COMPLETED_SYNTHETIC_ONLY");
    assert.equal(r.value.financial_authorization, "NOT_GRANTED");
    assert.equal(r.value.native_launch, false);
  }
  const files = await controllerInventory(cap);
  for (const name of [
    "scan-attempt.json",
    "scan-child.json",
    "scan-completed.json",
  ])
    assert.equal(files.filter((f) => f.path === name).length, 1);
  const attempt = files.find((f) => f.path === "scan-attempt.json");
  const child = JSON.parse(
    Buffer.from(
      files.find((f) => f.path === "scan-child.json").bytes,
      "base64",
    ),
  );
  const done = JSON.parse(
    Buffer.from(
      files.find((f) => f.path === "scan-completed.json").bytes,
      "base64",
    ),
  );
  assert.equal(child.attempt_sha256, attempt.sha256);
  assert.equal(child.nonce, cap.nonce);
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  assert.equal(done.attempt_sha256, attempt.sha256);
  assert.equal(done.financial_authorization, "NOT_GRANTED");
  await launchFixture(cap, "scan");
  assert.deepEqual(await controllerInventory(cap), files);
  assert.equal(
    (await inspectController(cap, "scan")).status,
    "COMPLETED_SYNTHETIC_ONLY",
  );
});
test("clean completion releases only owned lease and permits a different approved purpose", async () => {
  assert.equal(
    (await launchFixture(cap, "observation")).status,
    "COMPLETED_SYNTHETIC_ONLY",
  );
  await assert.rejects(lstat(join(cap.control, "controller.lease")));
});
test("schema failure rolls back and cleans only new identity-verified fixture", async () => {
  await assert.rejects(
    provisionDisposable({ fault: "schema_transaction" }),
    (e) => e.cleanup?.cleaned === true && e.rollback_verified === true,
  );
});
test("post-storage failure leaves no adopted target or reused credential", async () => {
  await assert.rejects(
    provisionDisposable({ fault: "after_storage" }),
    (e) => e.cleanup?.cleaned === true,
  );
});
test("crash after lease preserves quarantine and prohibits automatic restart", async () => {
  const c = await fresh();
  await assert.rejects(launchFixture(c, "scan", { fault: "after_lease" }));
  const before = await controllerInventory(c);
  assert.equal(
    (await inspectController(c, "scan")).status,
    "RECONCILIATION_REQUIRED",
  );
  await assert.rejects(launchFixture(c, "scan"));
  await assert.rejects(launchFixture(c, "allocation"));
  assert.deepEqual(await controllerInventory(c), before);
});
test("crash after durable attempt cannot regenerate operation identity", async () => {
  const c = await fresh();
  await assert.rejects(
    launchFixture(c, "observation", { fault: "after_attempt" }),
  );
  const before = await controllerInventory(c);
  await assert.rejects(launchFixture(c, "observation"));
  assert.deepEqual(await controllerInventory(c), before);
});
test("child failure retains exact PID receipt, attempt and lease; no replay", async () => {
  const c = await fresh();
  await assert.rejects(launchFixture(c, "scan", { fault: "child_failure" }));
  const before = await controllerInventory(c);
  assert.ok(before.some((r) => r.path === "scan-child.json"));
  await assert.rejects(launchFixture(c, "scan"));
  assert.deepEqual(await controllerInventory(c), before);
});
test("unsafe Windows ACL blocks launch without discarding evidence", async () => {
  const s = await session(cap),
    probe = join(s.f.root, "unsafe-probe");
  await mkdir(probe);
  await storage("unsafe", s.f.root);
  try {
    await assert.rejects(storage("check", s.f.root));
    await assert.rejects(launchFixture(cap, "allocation"));
  } finally {
    await storage("repair", s.f.root);
  }
  await storage("check", s.f.root);
});
test("cold encrypted backup retains controller journals and synthetic recovery credentials", async () => {
  receipt = await backupDisposable(cap);
  assert.match(receipt.ciphertext_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.off_device_retention, "NOT_PROVEN");
  assert.equal(receipt.financial_authorization, "NOT_GRANTED");
});
test("backup is create-only and refuses second generation or launching stopped source", async () => {
  await assert.rejects(backupDisposable(cap));
  await assert.rejects(launchFixture(cap, "observation"));
});
test("ciphertext tampering and wrong recovery key fail closed", async () => {
  await assert.rejects(checkRecoveryCiphertext(cap, { altered: true }));
  await assert.rejects(checkRecoveryCiphertext(cap, { wrongKey: true }));
  assert.equal(
    (await checkRecoveryCiphertext(cap)).status,
    "AUTHENTICATED_DISPOSABLE_CIPHERTEXT",
  );
});
test("missing backup file fails without inventing replacement evidence", async () => {
  const s = await session(cap),
    path = join(s.f.roots[1], "cluster.age"),
    held = join(s.f.roots[1], "cluster.age.held");
  await rename(path, held);
  try {
    await assert.rejects(checkRecoveryCiphertext(cap));
  } finally {
    await rename(held, path);
  }
});
test("restore preserves physical identities, permissions and login, but remains quarantined", async () => {
  const result = await restoreDisposable(cap);
  assert.equal(result.system_identifier, cap.system_identifier);
  assert.equal(result.controller_files_preserved, true);
  assert.equal(result.authorization, "QUARANTINED_NO_LAUNCH");
  assert.equal(result.credentials, "SYNTHETIC_CONTEXT_LOGIN_VERIFIED");
  const original = await controllerInventory(cap);
  for (const file of original)
    assert.equal(
      (await readFile(join(result.restored_controller, file.path))).toString(
        "base64",
      ),
      file.bytes,
    );
});
test("identity-identical source cannot restart alongside restored cluster", async () => {
  const s = await session(cap);
  await assert.rejects(s.f.start("source"));
  await assert.rejects(restoreDisposable(cap));
});

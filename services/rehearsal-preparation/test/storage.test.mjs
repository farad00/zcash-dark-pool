import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  createDisposableScope,
  createOnly,
  reserveFixtureAttempt,
  inspectFixtureAttempt,
  cleanupDisposableScope,
} from "../fixture.mjs";
import { proposal, proposalDigest } from "../plan.mjs";
import { privateProcess } from "../../backup/crypto.mjs";
import { fileURLToPath } from "node:url";
const digest = () => proposalDigest(proposal());
async function scoped(work) {
  const scope = await createDisposableScope();
  try {
    await work(scope);
  } finally {
    await cleanupDisposableScope(scope);
    await assert.rejects(lstat(scope.root));
  }
}
const storage = (scope, action) =>
  privateProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(
        new URL(
          "../../../scripts/dev/unfunded-storage-probe.ps1",
          import.meta.url,
        ),
      ),
      "-Action",
      action,
      "-FixtureRoot",
      scope.root,
    ],
    Buffer.alloc(0),
    4096,
    { DARKPOOL_UNFUNDED_PREPARATION_TEST_ONLY: "1" },
  );
test("actual disposable Windows ACL check and unsafe-permission rejection; no real credentials or wallets", async () => {
  await scoped(async (scope) => {
    assert.equal(
      (await storage(scope, "configure")).toString().trim(),
      "UNFUNDED_FIXTURE_STORAGE_PASS",
    );
    await createOnly(
      scope,
      "synthetic.json",
      Buffer.from('{"scope":"DISPOSABLE_TEST_ONLY","nonfinancial":true}'),
    );
    assert.equal(
      (await storage(scope, "check")).toString().trim(),
      "UNFUNDED_FIXTURE_STORAGE_PASS",
    );
    const preserved = await readFile(join(scope.root, "synthetic.json"));
    await storage(scope, "unsafe-fixture-acl");
    await assert.rejects(storage(scope, "check"));
    assert.deepEqual(
      await readFile(join(scope.root, "synthetic.json")),
      preserved,
    );
  });
});
test("exclusive concurrent attempts create one nonexecutable marker, never a second obligation", async () => {
  await scoped(async (scope) => {
    const results = await Promise.allSettled([
      reserveFixtureAttempt(scope, "scan", digest()),
      reserveFixtureAttempt(scope, "scan", digest()),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const bytes = await readFile(join(scope.root, "scan-attempt.json"));
    assert.equal(
      (await inspectFixtureAttempt(scope, "scan", digest())).status,
      "RETAINED_NONEXECUTABLE",
    );
    await assert.rejects(reserveFixtureAttempt(scope, "scan", digest()));
    assert.deepEqual(
      await readFile(join(scope.root, "scan-attempt.json")),
      bytes,
    );
  });
});
test("interruption after exclusive create preserves partial file and refuses marker regeneration", async () => {
  await scoped(async (scope) => {
    await assert.rejects(
      reserveFixtureAttempt(scope, "allocation", digest(), {
        interruptAfterCreate: true,
      }),
      /SYNTHETIC_INTERRUPTION/,
    );
    const marker = join(scope.root, "allocation-attempt.json");
    assert.equal((await lstat(marker)).size, 0);
    assert.equal(
      (await inspectFixtureAttempt(scope, "allocation", digest())).status,
      "RECONCILIATION_REQUIRED",
    );
    await assert.rejects(reserveFixtureAttempt(scope, "allocation", digest()));
    assert.equal((await lstat(marker)).size, 0);
  });
});
test("scope cloning, unsafe filenames and real-target substitution fail before mutation", async () => {
  await scoped(async (scope) => {
    await assert.rejects(
      createOnly({ ...scope }, "synthetic.json", Buffer.from("x")),
      /UNFUNDED_FIXTURE_REJECTED/,
    );
    for (const name of [
      "../outside",
      "data.sqlite",
      "maintenance.xml",
      "seed.txt",
      "C:\\ProgramData\\file",
    ])
      await assert.rejects(
        createOnly(scope, name, Buffer.from("x")),
        /UNFUNDED_FIXTURE_REJECTED/,
      );
    await assert.rejects(
      cleanupDisposableScope({ ...scope, root: proposal().root }),
      /UNFUNDED_FIXTURE_REJECTED/,
    );
  });
});
test("changed digest and cloned recovery marker require reconciliation without rewriting evidence", async () => {
  await scoped(async (original) => {
    await reserveFixtureAttempt(original, "observation", digest());
    const bytes = await readFile(
      join(original.root, "observation-attempt.json"),
    );
    assert.equal(
      (await inspectFixtureAttempt(original, "observation", "ff".repeat(32)))
        .status,
      "RECONCILIATION_REQUIRED",
    );
    await scoped(async (restored) => {
      await createOnly(restored, "observation-attempt.json", bytes);
      assert.equal(
        (await inspectFixtureAttempt(restored, "observation", digest())).status,
        "RECONCILIATION_REQUIRED",
      );
      assert.deepEqual(
        await readFile(join(restored.root, "observation-attempt.json")),
        bytes,
      );
    });
    assert.deepEqual(
      await readFile(join(original.root, "observation-attempt.json")),
      bytes,
    );
  });
});

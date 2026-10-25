import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateProcess } from "../../../backup/crypto.mjs";
import { rejectRedirects } from "../../../../db/target-registry.mjs";
import { postgresToolPlan, validateToolVerification } from "../resolver.mjs";
const fixtures = new WeakMap();
async function create() {
  if (
    !process.env.NODE_TEST_CONTEXT ||
    process.env.DARKPOOL_PG_STAGE_TEST_ONLY !== "1"
  )
    throw Error("TEST_ONLY");
  const root = join(
    tmpdir(),
    "darkpool-pg-stage-" + randomBytes(16).toString("hex"),
  );
  await rejectRedirects(dirname(root));
  await mkdir(root);
  const scope = Object.freeze({
    root,
    nonce: randomBytes(16).toString("hex"),
    scope: "DISPOSABLE_SYNTHETIC_STAGE_ONLY",
  });
  const st = await lstat(root);
  fixtures.set(scope, { dev: st.dev, ino: st.ino });
  await writeFile(join(root, "fixture-scope.json"), JSON.stringify(scope), {
    flag: "wx",
  });
  return scope;
}
async function cleanup(scope) {
  const expected = fixtures.get(scope),
    st = await lstat(scope.root);
  if (
    !expected ||
    st.dev !== expected.dev ||
    st.ino !== expected.ino ||
    dirname(resolve(scope.root)) !== resolve(tmpdir()) ||
    !/^darkpool-pg-stage-[a-f0-9]{32}$/.test(basename(scope.root)) ||
    (await readFile(join(scope.root, "fixture-scope.json"), "utf8")) !==
      JSON.stringify(scope)
  )
    throw Error("CLEANUP_IDENTITY_UNCERTAIN");
  async function check(path) {
    await rejectRedirects(path);
    const s = await lstat(path);
    if (s.isSymbolicLink() || (s.nlink > 1 && !s.isDirectory()))
      throw Error("CLEANUP_ALIAS");
    if (s.isDirectory())
      for (const n of await readdir(path)) await check(join(path, n));
  }
  await check(scope.root);
  await rm(scope.root, { recursive: true, force: false });
  await assert.rejects(lstat(scope.root));
}
for (const scenario of [
  "success",
  "retry",
  "archive-hash",
  "inventory-hash",
  "traversal",
  "duplicate",
  "case-alias",
  "parent-alias",
  "reserved-name",
  "ads",
  "symlink-entry",
  "unsafe-acl",
  "unsafe-parent",
  "after_attempt",
  "after_file",
  "before_receipt",
  "tampering",
  "extra-file",
  "missing-file",
  "missing-receipt",
  "receipt-scope",
  "manifest-tampering",
  "wrong-target",
  "vendor-parser",
  "production-guards",
  "retained-archive-inventory",
  "production-acl-policy",
  "reparse-target",
  "directory-collision",
  "vendor-unavailable",
  "attempt-binding",
  "production-manifest-byte-count",
  "production-inventory-rejection",
  "failure-reason-redaction",
  "cli-failure-reason",
]) {
  test("disposable create-only PostgreSQL staging: " + scenario, async () => {
    const scope = await create();
    try {
      const bytes = await privateProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(new URL("./fixture.ps1", import.meta.url)),
          "-Scenario",
          scenario,
          "-FixtureRoot",
          scope.root,
        ],
        Buffer.alloc(0),
        4096,
        { DARKPOOL_PG_STAGE_TEST_ONLY: "1" },
      );
      const result = JSON.parse(bytes.toString("utf8"));
      assert.equal(result.status, "PASS", JSON.stringify(result));
      assert.equal(result.binary_execution, false);
      assert.equal(result.sql, false);
    } finally {
      await cleanup(scope);
    }
  });
}
test("closed resolver maps only approved purposes to the fixed local destination", () => {
  for (const p of [
    "initialize",
    "control",
    "context",
    "server",
    "identity",
    "checksums",
    "dump",
    "restore",
  ]) {
    const plan = postgresToolPlan(p);
    assert.ok(
      plan.executable.startsWith("C:\\ZcashTools\\PostgreSQL\\18.6-5\\bin\\"),
    );
    assert.equal(plan.execution_authorization, "NOT_GRANTED");
  }
  for (const p of [
    "pg_resetwal",
    "../postgres.exe",
    "C:\\other",
    "initdb.exe",
    "broadcast",
  ])
    assert.throws(() => postgresToolPlan(p));
});
test("synthetic, incomplete or financially relabeled installation reports never authorize the real resolver", () => {
  const base = {
    status: "PINNED_BINARIES_STAGED_ONLY",
    scope: "STAGED_BINARIES_ONLY",
    destination: "C:\\ZcashTools\\PostgreSQL\\18.6-5",
    archive_sha256: postgresToolPlan("control").archive_sha256,
    inventory_sha256: postgresToolPlan("control").inventory_sha256,
    binary_execution: "NOT_AUTHORIZED",
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
  };
  assert.equal(
    validateToolVerification(base).financial_authorization,
    "NOT_GRANTED",
  );
  for (const change of [
    { scope: "DISPOSABLE_SYNTHETIC_STAGE_ONLY" },
    { status: "PARTIAL" },
    { inventory_sha256: "0".repeat(64) },
    { financial_authorization: "GRANTED" },
    { binary_execution: "APPROVED" },
    { production_trust: "READY" },
    { extra: true },
    { destination: "C:\\other" },
  ])
    assert.throws(() => validateToolVerification({ ...base, ...change }));
  assert.throws(() => validateToolVerification(null));
});

// Disposable nonfinancial file probes only. Never a wallet, DB, backup or real launcher.
import { randomBytes } from "node:crypto";
import { mkdir, open, lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { rejectRedirects } from "../../db/target-registry.mjs";
const scopes = new WeakMap();
const fail = () => {
  throw Error("UNFUNDED_FIXTURE_REJECTED");
};
const snapshot = (s) => ({ dev: String(s.dev), ino: String(s.ino) });
const equal = (a, b) => a.dev === b.dev && a.ino === b.ino;
export async function createDisposableScope() {
  if (
    !process.env.NODE_TEST_CONTEXT ||
    process.env.DARKPOOL_UNFUNDED_PREPARATION_TEST_ONLY !== "1"
  )
    fail();
  const root = join(
    tmpdir(),
    "darkpool-unfunded-prep-" + randomBytes(16).toString("hex"),
  );
  await rejectRedirects(dirname(root));
  await mkdir(root); // Not recursive, never adopts an existing directory.
  const scope = Object.freeze({
    root,
    scope_id: randomBytes(16).toString("hex"),
    classification: "DISPOSABLE_TEST_ONLY",
  });
  scopes.set(scope, snapshot(await lstat(root)));
  try {
    await createOnly(
      scope,
      "fixture-scope.json",
      Buffer.from(JSON.stringify(scope)),
    );
    return scope;
  } catch (e) {
    await cleanupDisposableScope(scope);
    throw e;
  }
}
async function assertScope(scope) {
  const bound = scopes.get(scope);
  if (
    !process.env.NODE_TEST_CONTEXT ||
    process.env.DARKPOOL_UNFUNDED_PREPARATION_TEST_ONLY !== "1" ||
    !bound ||
    dirname(resolve(scope.root)) !== resolve(tmpdir()) ||
    !/^darkpool-unfunded-prep-[a-f0-9]{32}$/.test(basename(scope.root))
  )
    fail();
  await rejectRedirects(scope.root);
  const s = await lstat(scope.root);
  if (!s.isDirectory() || s.isSymbolicLink() || !equal(bound, snapshot(s)))
    fail();
}
export async function createOnly(
  scope,
  name,
  bytes,
  { interruptAfterCreate = false } = {},
) {
  await assertScope(scope);
  if (
    !/^(fixture-scope\.json|synthetic\.json|(?:allocation|scan|observation)-attempt\.json)$/.test(
      name,
    ) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length > 16384
  )
    fail();
  const file = await open(join(scope.root, name), "wx", 0o600);
  try {
    if (interruptAfterCreate) throw Error("SYNTHETIC_INTERRUPTION");
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function reserveFixtureAttempt(
  scope,
  purpose,
  proposal_sha256,
  options,
) {
  if (
    !["allocation", "scan", "observation"].includes(purpose) ||
    !/^[a-f0-9]{64}$/.test(proposal_sha256)
  )
    fail();
  const data = {
    scope: "DISPOSABLE_TEST_ONLY",
    operation: "NONEXECUTABLE_FIXTURE_INTENT",
    scope_id: scope.scope_id,
    purpose,
    proposal_sha256,
    financial_authorization: "NOT_GRANTED",
  };
  await createOnly(
    scope,
    purpose + "-attempt.json",
    Buffer.from(JSON.stringify(data)),
    options,
  );
}
export async function inspectFixtureAttempt(scope, purpose, expectedDigest) {
  await assertScope(scope);
  if (
    !["allocation", "scan", "observation"].includes(purpose) ||
    !/^[a-f0-9]{64}$/.test(expectedDigest ?? "")
  )
    fail();
  const path = join(scope.root, purpose + "-attempt.json");
  await rejectRedirects(path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 16384) fail();
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (
      Object.keys(data).sort().join() !==
        "financial_authorization,operation,proposal_sha256,purpose,scope,scope_id" ||
      data.scope !== "DISPOSABLE_TEST_ONLY" ||
      data.operation !== "NONEXECUTABLE_FIXTURE_INTENT" ||
      data.scope_id !== scope.scope_id ||
      data.purpose !== purpose ||
      data.financial_authorization !== "NOT_GRANTED" ||
      data.proposal_sha256 !== expectedDigest
    )
      fail();
    return Object.freeze({
      status: "RETAINED_NONEXECUTABLE",
      financial_authorization: "NOT_GRANTED",
    });
  } catch {
    return Object.freeze({
      status: "RECONCILIATION_REQUIRED",
      financial_authorization: "NOT_GRANTED",
    });
  }
}
export async function cleanupDisposableScope(scope) {
  await assertScope(scope); // Identity uncertainty leaves files for review, never repairs/deletes another root.
  const path = resolve(scope.root);
  if (
    dirname(path) !== resolve(tmpdir()) ||
    !/^darkpool-unfunded-prep-[a-f0-9]{32}$/.test(basename(path))
  )
    fail();
  await rm(path, { recursive: true, force: false });
  scopes.delete(scope);
}

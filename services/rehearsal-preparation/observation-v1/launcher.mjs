// No native-wallet execution path. The sole executable is Node + the pinned,
// stateless fixture child. Persistent launch always fails in policy.mjs.
import { spawn } from "node:child_process";
import { readFile, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { digest } from "../../backup/crypto.mjs";
import { storage } from "../../backup/physical.mjs";
import {
  session,
  durableNew,
  verifyDisposable,
  controllerInventory,
} from "./provisioner.mjs";
import { reject } from "./policy.mjs";

const childPath = fileURLToPath(
  new URL("./fixture-child.mjs", import.meta.url),
);
const reviewedChildHash = digest(await readFile(childPath));
const reviewedNodeHash = digest(await readFile(process.execPath));
const purposes = ["allocation", "scan", "observation"];
const bytes = (value) => Buffer.from(JSON.stringify(value));
const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return false;
  }
};
const parse = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function inspectController(cap, purpose) {
  const s = await session(cap);
  if (!purposes.includes(purpose)) reject();
  const files = await controllerInventory(cap);
  const attemptFile = files.find((f) => f.path === purpose + "-attempt.json");
  let status = "NOT_ATTEMPTED";
  if (files.some((f) => f.path === "controller.lease"))
    status = "RECONCILIATION_REQUIRED";
  else if (attemptFile) {
    try {
      const a = JSON.parse(
        Buffer.from(attemptFile.bytes, "base64").toString("utf8"),
      );
      const done = await parse(join(s.control, purpose + "-completed.json"));
      if (
        a.scope !== "DISPOSABLE_TEST_ONLY" ||
        a.nonce !== cap.nonce ||
        a.purpose !== purpose ||
        a.descriptor_sha256 !== cap.descriptor_sha256 ||
        a.child_sha256 !== reviewedChildHash ||
        a.node_sha256 !== reviewedNodeHash ||
        a.system_identifier !== cap.system_identifier ||
        done.attempt_sha256 !== attemptFile.sha256 ||
        done.financial_authorization !== "NOT_GRANTED"
      )
        reject();
      status = "COMPLETED_SYNTHETIC_ONLY";
    } catch {
      status = "RECONCILIATION_REQUIRED";
    }
  }
  return Object.freeze({
    status,
    financial_authorization: "NOT_GRANTED",
    native_launch: false,
  });
}

export async function launchFixture(cap, purpose, options = {}) {
  if (!options || Object.keys(options).some((k) => k !== "fault")) reject();
  const { fault = null } = options;
  const s = await session(cap);
  if (
    !purposes.includes(purpose) ||
    ![null, "after_lease", "after_attempt", "child_failure"].includes(fault) ||
    s.active
  )
    reject();
  await verifyDisposable(cap);
  await storage("check", s.f.root);
  if (
    digest(await readFile(childPath)) !== reviewedChildHash ||
    digest(await readFile(process.execPath)) !== reviewedNodeHash
  )
    reject();
  const previous = await inspectController(cap, purpose);
  if (previous.status === "COMPLETED_SYNTHETIC_ONLY") return previous;
  if (previous.status !== "NOT_ATTEMPTED") reject();
  const leasePath = join(s.control, "controller.lease");
  const lease = bytes({
    scope: "DISPOSABLE_TEST_ONLY",
    purpose,
    nonce: cap.nonce,
    lease_id: randomBytes(16).toString("hex"),
  });
  await durableNew(leasePath, lease); // Cross-process exclusive, before attempt/spawn.
  const leaseIdentity = await lstat(leasePath);
  s.active = true;
  try {
    if (fault === "after_lease")
      throw Error("OBSERVATION_V1_SYNTHETIC_INTERRUPTION");
    const attempt = bytes({
      scope: "DISPOSABLE_TEST_ONLY",
      purpose,
      nonce: cap.nonce,
      descriptor_sha256: cap.descriptor_sha256,
      system_identifier: cap.system_identifier,
      child_sha256: reviewedChildHash,
      node_sha256: reviewedNodeHash,
      financial_authorization: "NOT_GRANTED",
    });
    await durableNew(join(s.control, purpose + "-attempt.json"), attempt);
    if (fault === "after_attempt")
      throw Error("OBSERVATION_V1_SYNTHETIC_INTERRUPTION");
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        /^(SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k),
      ),
    );
    const child = spawn(
      process.execPath,
      [childPath, purpose, fault === "child_failure" ? "failure" : "ok"],
      {
        windowsHide: true,
        env: { ...clean, DARKPOOL_OBSERVATION_CHILD: "SYNTHETIC_ONLY" },
        stdio: ["pipe", "pipe", "pipe"],
        cwd: s.control,
      },
    );
    const chunks = [];
    let size = 0,
      failed = false;
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const result = new Promise((resolve, rejectResult) => {
      const timer = setTimeout(() => {
        failed = true;
        child.kill();
      }, 10000);
      child.on("error", () => {
        failed = true;
      });
      child.stdout.on("data", (b) => {
        size += b.length;
        if (size > 4096) {
          failed = true;
          child.kill();
        } else chunks.push(b);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0)
          rejectResult(Error("OBSERVATION_V1_CHILD_UNCERTAIN"));
        else resolve(Buffer.concat(chunks));
      });
    });
    // Attach rejection immediately, including if durable child-receipt writing fails.
    result.catch(() => {});
    try {
      await durableNew(
        join(s.control, purpose + "-child.json"),
        bytes({
          scope: "DISPOSABLE_TEST_ONLY",
          pid: child.pid,
          nonce: cap.nonce,
          attempt_sha256: digest(attempt),
          authorization: "NO_WALLET_NO_NETWORK",
        }),
      );
      // Child waits on EOF. No synthetic operation begins until identity is durable.
      child.stdin.end(
        bytes({ scope: "DISPOSABLE_TEST_ONLY", nonce: cap.nonce, purpose }),
      );
    } catch {
      child.kill();
      await result.catch(() => {});
      reject();
    }
    const returned = JSON.parse((await result).toString("utf8"));
    if (
      returned.scope !== "DISPOSABLE_TEST_ONLY" ||
      returned.nonce !== cap.nonce ||
      returned.purpose !== purpose ||
      returned.pid !== child.pid ||
      returned.financial_authorization !== "NOT_GRANTED" ||
      JSON.stringify(returned.observations) !== "[]"
    )
      reject();
    await durableNew(
      join(s.control, purpose + "-completed.json"),
      bytes({
        scope: "DISPOSABLE_TEST_ONLY",
        attempt_sha256: digest(attempt),
        financial_authorization: "NOT_GRANTED",
        native_launch: false,
      }),
    );
    // Only a verified clean exit + durable completion can release this owned lease.
    // Never remove a stale/failed lease or act on a retained PID after restart.
    const now = await lstat(leasePath);
    if (
      now.dev !== leaseIdentity.dev ||
      now.ino !== leaseIdentity.ino ||
      !Buffer.from(await readFile(leasePath)).equals(lease)
    )
      reject();
    await unlink(leasePath);
    return inspectController(cap, purpose);
  } finally {
    s.active = false;
  }
}
export async function assertNoActiveOperation(cap) {
  const s = await session(cap);
  if (s.active) reject();
  // A retained lease is backed up as quarantined evidence, not cleared or resumed.
  return { quarantined: await exists(join(s.control, "controller.lease")) };
}

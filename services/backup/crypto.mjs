// TEST-only bounded recovery capsule. Standard age encryption, no wallet access.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const LIMIT = 64 * 1024 * 1024;
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const reject = () => {
  throw new Error("BACKUP_REJECTED");
};
export function assertSynthetic(env = process.env) {
  if (
    env.DARKPOOL_BACKUP_TEST_ONLY !== "1" ||
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.DARKPOOL_LIVE_INSTANCE !== undefined
  )
    reject();
}
export async function privateProcess(
  executable,
  args,
  input,
  max = LIMIT,
  env = {},
) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k),
    ),
  );
  return new Promise((resolve, rejectResult) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      env: { ...clean, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0,
      failed = false;
    const deadline = setTimeout(() => {
      failed = true;
      child.kill();
    }, 30000);
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > max) {
        failed = true;
        child.kill();
      } else chunks.push(b);
    });
    child.stderr.resume(); // Never serialize crypto, SQL or credential diagnostics.
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (failed || code !== 0) {
        const error = new Error("BACKUP_REJECTED");
        error.exitCode = code;
        rejectResult(error);
      } else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
const executable = fileURLToPath(
  new URL(
    "../../.tools/backup-target/debug/darkpool-backup-age.exe",
    import.meta.url,
  ),
);
async function age(args, input) {
  assertSynthetic();
  return privateProcess(executable, args, input, LIMIT, {
    DARKPOOL_BACKUP_SYNTHETIC: "1",
  });
}
export async function syntheticKeyPair() {
  const values = (await age(["keygen"], Buffer.alloc(0)))
    .toString("utf8")
    .trim()
    .split("\n");
  if (
    values.length !== 2 ||
    !values[0].startsWith("age1") ||
    !values[1].startsWith("AGE-SECRET-KEY-1")
  )
    reject();
  return { recipient: values[0], identity: values[1] };
}
export function validateCapsule(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      [
        "version",
        "scope",
        "kind",
        "database",
        "identity_bindings",
        "credentials",
        "dump",
        "dump_sha256",
      ]
        .sort()
        .join() ||
    value.version !== 1 ||
    value.scope !== "SYNTHETIC_TEST" ||
    value.kind !== "LOGICAL_QUARANTINE" ||
    !/^darkpool_phase9_[a-f0-9]{16}$/.test(value.database) ||
    !Array.isArray(value.credentials) ||
    !value.credentials.length ||
    value.credentials.length > 16 ||
    !value.identity_bindings ||
    typeof value.dump !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.dump_sha256)
  )
    reject();
  const names = new Set(),
    purposes = new Set();
  for (const record of value.credentials) {
    if (
      !record ||
      Object.keys(record).sort().join() !== "login,password,purpose" ||
      !/^[a-z]+$/.test(record.purpose) ||
      !/^darkpool_[a-z0-9_]+_[a-f0-9]{16}$/.test(record.login) ||
      !record.login.endsWith("_" + value.database.slice(-16)) ||
      ![
        "owner",
        "admin",
        "watch",
        "issue",
        "read",
        "oracle",
        "coordinator",
        "lock",
      ].includes(record.purpose) ||
      !/^[a-f0-9]{64}$/.test(record.password) ||
      names.has(record.login) ||
      purposes.has(record.purpose)
    )
      reject();
    names.add(record.login);
    purposes.add(record.purpose);
  }
  const dump = Buffer.from(value.dump, "base64");
  if (
    dump.subarray(0, 5).toString() !== "PGDMP" ||
    dump.length > LIMIT / 2 ||
    dump.toString("base64") !== value.dump ||
    digest(dump) !== value.dump_sha256
  )
    reject();
  return value;
}
export async function sealCapsule(value, recipient) {
  const bytes = Buffer.from(JSON.stringify(validateCapsule(value)), "utf8");
  if (bytes.length > LIMIT / 2) reject();
  const ciphertext = await age(["encrypt", recipient], bytes);
  return {
    ciphertext,
    receipt: {
      profile: "SYNTHETIC_LOGICAL_BACKUP_V1",
      database: value.database,
      ciphertext_sha256: digest(ciphertext),
    },
  };
}
export async function openCapsule(ciphertext, identity, receipt) {
  assertSynthetic();
  // Recipient encryption does not authenticate the author or prevent rollback.
  // This digest must come from independent trusted custody, NOT the archive.
  if (
    !receipt ||
    receipt.profile !== "SYNTHETIC_LOGICAL_BACKUP_V1" ||
    digest(ciphertext) !== receipt.ciphertext_sha256 ||
    ciphertext.length > LIMIT
  )
    reject();
  const key = Buffer.from(identity, "utf8");
  if (!key.length || key.length > 128) reject();
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(key.length);
  const plaintext = await age(
    ["decrypt"],
    Buffer.concat([prefix, key, ciphertext]),
  );
  let value;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    reject();
  }
  validateCapsule(value);
  if (value.database !== receipt.database) reject();
  return value;
}

import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reviewTransferredBackup } from "./computer-b-review.mjs";
let stage = "INPUTS";
try {
  const [action, directory, manifestSha256, ageSha256, ...extra] =
    process.argv.slice(2);
  if (
    extra.length ||
    !["check", "verify"].includes(action) ||
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    Number(process.versions.node.split(".")[0]) !== 24 ||
    Number(process.versions.node.split(".")[1]) < 21 ||
    !directory ||
    resolve(directory) !== directory
  )
    throw Error();
  // Child-process-local TEST flags only. No financial runtime is imported/called.
  for (const k of Object.keys(process.env))
    if (/^PG|^DARKPOOL_|^DATABASE_URL$|^WALLET_/i.test(k))
      delete process.env[k];
  Object.assign(process.env, {
    DARKPOOL_BACKUP_TEST_ONLY: "1",
    DARKPOOL_PHYSICAL_REHEARSAL: "1",
    DARKPOOL_PG_ENV: "TEST",
    DARKPOOL_TEST_ONLY: "TEST_ONLY",
  });
  async function bytes(name, max) {
    const path = join(directory, name),
      st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > max)
      throw Error();
    return readFile(path);
  }
  const input = {
    manifestBytes: await bytes("manifest.json", 8192),
    ciphertext: await bytes("cluster.age", 32 * 1024 * 1024),
    manifestSha256,
    ageSha256,
  };
  stage = "PUBLIC_INTEGRITY";
  const preflight = await reviewTransferredBackup(input);
  if (action === "check") console.log(JSON.stringify(preflight));
  else {
    stage = "PRIVATE_RECOVERY_INPUT";
    const parts = [];
    let size = 0;
    for await (const b of process.stdin) {
      size += b.length;
      if (size > 132) throw Error();
      parts.push(b);
    }
    const keyBytes = Buffer.concat(parts);
    try {
      const key = keyBytes.toString("ascii").replace(/\r?\n$/, "");
      stage = "AUTHENTICATED_DECRYPTION";
      console.log(
        JSON.stringify(await reviewTransferredBackup({ ...input, key })),
      );
    } finally {
      keyBytes.fill(0);
      for (const p of parts) p.fill(0);
    }
  }
} catch {
  console.log(
    JSON.stringify({
      status: "RECOVERY_REVIEW_FAILED",
      stage,
      financial_authorization: "NOT_GRANTED",
      production_trust: "UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
}

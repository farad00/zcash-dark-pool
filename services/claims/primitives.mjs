// Server-only, stateless primitives. Never inherit wallet/PG authority in decoder.
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveClaimCommitment } from "../../packages/protocol/src/claim-commitment.ts";

export function matchesCredential(market_id, ticket_id, secret, expected) {
  if (
    !(secret instanceof Uint8Array) ||
    secret.length !== 32 ||
    typeof expected !== "string" ||
    !/^[0-9a-f]{64}$/.test(expected)
  )
    return false;
  const owned = new Uint8Array(secret);
  let digest;
  try {
    digest = Buffer.from(
      deriveClaimCommitment({
        version: 1,
        market_id,
        ticket_id,
        claim_secret: owned,
      }),
      "hex",
    );
    return timingSafeEqual(digest, Buffer.from(expected, "hex"));
  } catch {
    return false;
  } finally {
    owned.fill(0);
    digest?.fill(0);
  }
}

export function validateDestination(ua) {
  if (typeof ua !== "string" || !ua.length || Buffer.byteLength(ua) > 1024)
    return Promise.reject(new Error("CLAIM_REJECTED"));
  const executable = fileURLToPath(
    new URL(
      `../../target/debug/examples/phase13-destination${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  const bytes = Buffer.from(ua, "utf8"),
    size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const env = { ZCASH_NETWORK: "testnet" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP"])
    if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve, reject) => {
    let done = false,
      output = Buffer.alloc(0);
    const child = spawn(executable, [], { env, windowsHide: true });
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error("CLAIM_REJECTED"));
    };
    const timer = setTimeout(fail, 5000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", fail);
    child.stdout.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 43) fail();
    });
    child.on("close", (code) => {
      if (done) return;
      if (code !== 0 || output.length !== 43) return fail();
      done = true;
      clearTimeout(timer);
      resolve(
        Object.freeze({
          payout_ua: ua,
          orchard_receiver_hex: output.toString("hex"),
        }),
      );
    });
    child.stdin.end(Buffer.concat([size, bytes]));
  });
}

// Strict inspection of our SHA-256, nonce-bearing RFC3161 request subset only.
// OpenSSL generates the request and independently verifies its response.
import { sha256 } from "../../services/publication/profile.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
const execute = promisify(execFile);
export async function generateArtifactQuery(executable, dataPath) {
  if (!isAbsolute(executable) || !isAbsolute(dataPath))
    throw Error("ARTIFACT_QUERY_REJECTED");
  try {
    const result = await execute(
      executable,
      [
        "ts",
        "-query",
        "-data",
        dataPath,
        "-sha256",
        "-cert",
        "-tspolicy",
        "1.2.3.4.1",
      ],
      {
        encoding: "buffer",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          LC_ALL: "C",
          LANG: "C",
        },
      },
    );
    if (
      !Buffer.isBuffer(result.stdout) ||
      !result.stdout.length ||
      result.stdout.length > 65536
    )
      throw Error();
    return result.stdout;
  } catch {
    throw Error("ARTIFACT_QUERY_REJECTED");
  }
}
export function artifactQueryBinding(input, data) {
  const fail = () => {
    throw Error("ARTIFACT_QUERY_REJECTED");
  };
  if (
    !Buffer.isBuffer(input) ||
    !input.length ||
    input.length > 65536 ||
    !Buffer.isBuffer(data)
  )
    fail();
  const bytes = Buffer.from(input);
  function item(start, limit, tag) {
    let p = start;
    if (p + 2 > limit || bytes[p++] !== tag) fail();
    let size = bytes[p++];
    if (size & 128) {
      const width = size & 127;
      if (!width || width > 3 || p + width > limit || !bytes[p]) fail();
      size = 0;
      for (let i = 0; i < width; i++) size = size * 256 + bytes[p++];
      if (size < 128) fail();
    }
    if (p + size > limit) fail();
    return { start: p, end: p + size, value: bytes.subarray(p, p + size) };
  }
  const root = item(0, bytes.length, 48);
  if (root.end !== bytes.length) fail();
  const version = item(root.start, root.end, 2);
  if (!version.value.equals(Buffer.from([1]))) fail();
  const imprint = item(version.end, root.end, 48),
    algorithm = item(imprint.start, imprint.end, 48);
  const oid = item(algorithm.start, algorithm.end, 6);
  if (oid.value.toString("hex") !== "608648016503040201") fail();
  if (oid.end !== algorithm.end) {
    const nil = item(oid.end, algorithm.end, 5);
    if (nil.value.length || nil.end !== algorithm.end) fail();
  }
  const digest = item(algorithm.end, imprint.end, 4);
  if (
    digest.value.length !== 32 ||
    digest.end !== imprint.end ||
    digest.value.toString("hex") !== sha256(data)
  )
    fail();
  const policy = item(imprint.end, root.end, 6);
  if (policy.value.toString("hex") !== "2a030401") fail();
  const nonce = item(policy.end, root.end, 2);
  if (
    !nonce.value.length ||
    nonce.value.length > 33 ||
    nonce.value[0] & 128 ||
    (nonce.value.length > 1 && nonce.value[0] === 0 && !(nonce.value[1] & 128))
  )
    fail();
  const n = BigInt("0x" + nonce.value.toString("hex"));
  if (n === 0n) fail();
  const cert = item(nonce.end, root.end, 1);
  if (cert.end !== root.end || !cert.value.equals(Buffer.from([255]))) fail();
  return {
    query_sha256: sha256(bytes),
    acknowledgement_sha256: sha256(data),
    nonce_hex: n.toString(16),
    policy_oid: "1.2.3.4.1",
  };
}

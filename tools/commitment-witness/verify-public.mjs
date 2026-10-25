// Verification on A or B from public evidence only. No private key or witness storage access.
import { readFile, lstat } from "node:fs/promises";
import { settings, checkBundle, fail, MODE } from "./core.mjs";
import { operationalEvidence } from "./operational.mjs";
import {
  operationalDestination,
  requireSyntheticEnvelope,
  SYNTHETIC_SCOPE,
} from "./synthetic.mjs";
async function json(path) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1048576) fail();
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
  );
}
try {
  if (process.argv.length !== 8) fail();
  const [config, bundle, envelope] = await Promise.all(
    process.argv.slice(2, 5).map(json),
  );
  settings(config);
  const scope = operationalDestination(config);
  if (scope === SYNTHETIC_SCOPE) requireSyntheticEnvelope(envelope);
  const runtime = operationalEvidence(
    process.argv[5],
    process.argv[6],
    process.argv[7],
  );
  await checkBundle(
    config,
    { request: { envelope } },
    bundle,
    await runtime.verification(),
  );
  process.stdout.write(
    JSON.stringify({
      status: "PUBLIC_EVIDENCE_CRYPTOGRAPHICALLY_VERIFIED",
      scope,
      mode: MODE,
      third_party_independence: false,
      financial_authorization: false,
    }) + "\n",
  );
} catch {
  process.stderr.write("Public witness evidence unavailable or invalid\n");
  process.exitCode = 1;
}

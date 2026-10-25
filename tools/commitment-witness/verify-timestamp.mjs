// Offline TSA diagnostic only. Never generates a query, signs, submits, retrieves,
// persists a publication receipt or approves a financial lifecycle transition.
import { readFile, lstat, writeFile } from "node:fs/promises";
import { exact, decode64 } from "../../services/publication/profile.mjs";
import { verifyRfc3161 } from "../../services/publication/rfc3161.mjs";

async function json(path) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1048576) throw Error();
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
  );
}
try {
  if (process.argv.length !== 5) throw Error();
  const [policyFile, inputFile, outputFile] = process.argv.slice(2);
  const [p, input] = await Promise.all([json(policyFile), json(inputFile)]);
  if (
    p.version !== 1 ||
    p.status !== "PROPOSED_NOT_APPROVED" ||
    p.scope !== "TESTNET_ONLY_COMMON_CONTROL" ||
    p.financial_authorization !== "NOT_GRANTED" ||
    p.tsa_policy_oid !== "1.2.3.4.1"
  )
    throw Error();
  exact(input, [
    "query",
    "reply",
    "data",
    "observed_at",
    "locked_at",
    "clock_checks",
  ]);
  // Never execute a path supplied by a public evidence bundle.
  const local = await json(
    new URL("../../services/publication/witness-public.json", import.meta.url),
  );
  if (!Array.isArray(input.clock_checks) || input.clock_checks.length !== 2)
    throw Error();
  const verified = await verifyRfc3161({
    query: decode64(input.query, 65536),
    reply: decode64(input.reply),
    data: decode64(input.data, 65536),
    policy: p.tsa_verification,
    policy_oid: p.tsa_policy_oid,
    ca_bundle: p.ca_bundle,
    clock_skew_seconds: p.max_clock_skew_seconds,
    witness_lag_seconds: p.max_witness_lag_seconds,
    clock_checks: input.clock_checks,
    observed_at: input.observed_at,
    locked_at: input.locked_at,
    executable: local.openssl,
  });
  const audit = {
    status: "RFC3161_ONLY_NOT_PUBLICATION_VERIFICATION",
    policy_status: p.status,
    scope: p.scope,
    financial_authorization: false,
    third_party_independence: false,
    verified,
  };
  await writeFile(outputFile, JSON.stringify(audit, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    "RFC3161 diagnostic verified; no publication or financial authorization granted\n",
  );
} catch {
  process.stderr.write(
    "Timestamp diagnostic unavailable or invalid; no authorization granted\n",
  );
  process.exitCode = 1;
}

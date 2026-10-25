// Test-only anonymous GitHub simulation. Not included in the standalone package.
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { syntheticPlan } from "../synthetic.mjs";
import { envelopeBytes } from "../../../services/publication/profile.mjs";
import { gitBlobSha1 } from "../../../services/publication/github.mjs";

export const commit = "90e83e50bcc9bdf54f1f2963d988be18a94262e4";
export function mockGitHub({ requests = [], alter = {} } = {}) {
  const plan = syntheticPlan(),
    bytes = envelopeBytes(plan.envelope);
  const base =
    "https://api.github.com/repos/farad00/zcash-dark-pool-commitments";
  return async (url, options) => {
    if (
      options.method !== "GET" ||
      options.headers.Authorization ||
      options.body
    )
      throw Error("TEST_WRITE_OR_CREDENTIAL_REJECTED");
    requests.push(url);
    const reply = (v) => new Response(JSON.stringify(v));
    if (url === base + "/branches/main")
      return reply({ name: "main", commit: { sha: alter.commit ?? commit } });
    if (url === base)
      return reply({
        id: alter.id ?? 1427973036,
        private: false,
        visibility: "public",
        archived: false,
        full_name: "farad00/zcash-dark-pool-commitments",
      });
    if (url === base + "/git/commits/" + commit)
      return reply({ sha: commit, tree: { sha: "33".repeat(20) } });
    if (url === base + "/git/trees/" + "33".repeat(20) + "?recursive=1")
      return reply({
        sha: "33".repeat(20),
        truncated: false,
        tree: [
          {
            path: alter.path ?? plan.destination.path,
            mode: "100644",
            type: "blob",
            sha: gitBlobSha1(bytes),
          },
        ],
      });
    if (url === base + "/git/blobs/" + gitBlobSha1(bytes)) {
      const body = alter.bytes ?? bytes;
      return reply({
        sha: gitBlobSha1(bytes),
        encoding: "base64",
        size: body.length,
        content: body.toString("base64"),
      });
    }
    throw Error("TEST_UNKNOWN_NETWORK_DESTINATION");
  };
}

// Explicit preload only for a disposable CLI subprocess. No production imports.
if (process.env.DARKPOOL_SYNTHETIC_CAPTURE_TEST === "1") {
  if (!process.env.NODE_TEST_CONTEXT) throw Error("TEST_CONTEXT_REQUIRED");
  const configFile = process.argv[3];
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (config.trust.status !== "UNAVAILABLE") throw Error("TEST_TRUST_REQUIRED");
  const requests = [],
    fetcher = mockGitHub({ requests });
  globalThis.fetch = async (url, options) => {
    appendFileSync(
      join(dirname(configFile), "network.jsonl"),
      JSON.stringify({ method: options.method, url }) + "\n",
    );
    return fetcher(url, options);
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  createGitHubPublisher,
  githubConfiguration,
  prepareGitHubPublication,
  checkPublicRepository,
  retrieveGitHubEnvelope,
  gitBlobSha1,
} from "../github.mjs";
import { publicRequest } from "../http.mjs";
import { githubFixture } from "./github-fixtures.mjs";
import { verifyRepositoryReadOnly } from "../../../scripts/dev/publication-repository-readonly.mjs";

globalThis.fetch = async () => {
  throw new Error("TEST_NETWORK_DISABLED");
};
const destination = JSON.parse(
  await readFile(
    new URL("../github-destination.json", import.meta.url),
    "utf8",
  ),
);
const base = "https://api.github.com/repos/farad00/zcash-dark-pool-commitments";
const envelope = {
  market_id: "synthetic-config-check",
  ledger_version: 1,
  accepted_ticket_count: "1",
  merkle_root: "ab".repeat(32),
  locked_at: "2026-10-01T00:00:00Z",
};
const response = (value) =>
  new Response(JSON.stringify(value), { status: 200 });
const metadata = () => ({
  id: 1427973036,
  private: false,
  visibility: "public",
  archived: false,
  owner: { login: "farad00" },
  name: "zcash-dark-pool-commitments",
  full_name: "farad00/zcash-dark-pool-commitments",
  default_branch: "main",
});
function fixture() {
  const f = githubFixture(envelope),
    requests = [];
  const fetcher = async (url, options) => {
    assert(url === base || url.startsWith(base + "/"));
    requests.push({ url, ...options });
    if (url === base) return response(metadata());
    return f.fetch(
      url.replace(
        base,
        "https://api.github.com/repos/synthetic-fixture/ledger",
      ),
      options,
    );
  };
  const plan = prepareGitHubPublication(envelope, destination);
  return {
    ...f,
    requests,
    plan,
    fetch: fetcher,
    publish: createGitHubPublisher(destination, {
      fetch: fetcher,
      authorize: async () => true,
      credentials: async () => {
        throw new Error(
          "No credential access permitted in this rejection test",
        );
      },
    }),
  };
}
test("configured destination pins exact public repository ID, main and approved envelope path", () => {
  assert.deepEqual(githubConfiguration(destination), {
    repository: "https://github.com/farad00/zcash-dark-pool-commitments",
    repository_id: "1427973036",
    branch: "main",
    path: "testnet/ledger-v1.json",
  });
  assert.deepEqual(
    prepareGitHubPublication(envelope, destination).destination,
    destination,
  );
});
test("different immutable repository identity fails before any write", async () => {
  const f = fixture();
  await assert.rejects(
    checkPublicRepository(
      { ...destination, repository_id: "1427973037" },
      f.fetch,
    ),
    /PUBLICATION_UNAVAILABLE/,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
});
test("request-selected repository, unexpected branch or unauthorized path cannot replace pinned preparation", async () => {
  const f = fixture();
  for (const change of [
    { repository: "https://github.com/other/ledger" },
    { branch: "other" },
    { path: "testnet/unauthorized.json" },
  ])
    await assert.rejects(
      f.publish({ ...f.plan, destination: { ...destination, ...change } }),
      /PUBLICATION_REJECTED/,
    );
  assert.equal(f.requests.length, 0);
});
test("unexpected remote branch reference fails before credential access or PUT", async () => {
  const f = fixture();
  const fetcher = async (url, options) =>
    url.endsWith("/git/ref/heads/main")
      ? response({
          ref: "refs/heads/unexpected",
          object: { type: "commit", sha: "12".repeat(20) },
        })
      : f.fetch(url, options);
  await assert.rejects(
    createGitHubPublisher(destination, {
      fetch: fetcher,
      authorize: async () => true,
      credentials: async () => {
        throw new Error("not reached");
      },
    })(f.plan),
    /PUBLICATION_UNAVAILABLE/,
  );
  assert(f.requests.every((r) => r.method === "GET"));
});
test("changed existing envelope content is rejected under actual destination binding", async () => {
  const f = fixture();
  f.install({ ...envelope, merkle_root: "cd".repeat(32) });
  await assert.rejects(f.publish(f.plan), /PUBLICATION_CONFLICT/);
  assert(f.requests.every((r) => r.method === "GET"));
});
test("README and other paths never become accepted commitment-envelope paths", async () => {
  const f = fixture();
  for (const path of ["README.md", "testnet/unauthorized.json"])
    await assert.rejects(
      retrieveGitHubEnvelope(
        destination,
        { repository: destination.repository, commit: "12".repeat(20), path },
        { fetch: f.fetch },
      ),
      /PUBLICATION_REJECTED/,
    );
  assert.equal(f.requests.length, 0);
});
test("HTTP requests pin identity encoding; unexpected compressed responses still fail closed", async () => {
  let headers;
  const r = await publicRequest(async (_url, options) => {
    headers = options.headers;
    return new Response("plain", { headers: { "Content-Length": "5" } });
  }, base);
  assert.equal(headers["Accept-Encoding"], "identity");
  assert.equal(r.bytes.toString(), "plain");
  await assert.rejects(
    publicRequest(
      async () =>
        new Response("decoded text", {
          headers: { "Content-Encoding": "gzip", "Content-Length": "12" },
        }),
      base,
    ),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("README diagnostic uses only anonymous GETs; default-branch changes and altered bytes reject", async () => {
  const bytes = Buffer.from("Public synthetic README\n"),
    commit = "12".repeat(20),
    tree = "34".repeat(20),
    blob = gitBlobSha1(bytes);
  let changed = false,
    wrongBranch = false,
    count = 0;
  const fetcher = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, undefined);
    count++;
    const suffix = url.slice(base.length);
    if (url === base)
      return response({
        ...metadata(),
        default_branch: wrongBranch ? "other" : "main",
      });
    if (suffix === "/branches/main")
      return response({ name: "main", commit: { sha: commit } });
    if (suffix === "/git/ref/heads/main")
      return response({
        ref: "refs/heads/main",
        object: { type: "commit", sha: commit },
      });
    if (suffix === "/git/commits/" + commit)
      return response({ sha: commit, tree: { sha: tree } });
    if (suffix === "/git/trees/" + tree + "?recursive=1")
      return response({
        sha: tree,
        truncated: false,
        tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob }],
      });
    if (
      suffix === "/git/blobs/" + blob ||
      suffix === "/contents/README.md?ref=" + commit
    )
      return response({
        sha: blob,
        encoding: "base64",
        content: (changed ? Buffer.from("changed") : bytes).toString("base64"),
        size: bytes.length,
        type: "file",
        path: "README.md",
      });
    if (
      suffix ===
      "/commits?sha=" + commit + "&path=testnet%2Fledger-v1.json&per_page=2"
    )
      return response([]);
    throw new Error("MOCK_ENDPOINT_REJECTED");
  };
  const r = await verifyRepositoryReadOnly(destination, { fetch: fetcher });
  assert.equal(r.anonymous_get_requests, 10);
  assert.equal(count, 10);
  assert.equal(r.financial_authorization, false);
  assert.equal(r.publication, "NOT_PUBLISHED");
  wrongBranch = true;
  await assert.rejects(
    verifyRepositoryReadOnly(destination, { fetch: fetcher }),
  );
  wrongBranch = false;
  changed = true;
  await assert.rejects(
    verifyRepositoryReadOnly(destination, { fetch: fetcher }),
  );
});

// Public-envelope transport only. No filesystem, database, wallet or Git executable.
import { createHash } from "node:crypto";
import {
  canonical,
  exact,
  hex,
  envelopeBytes,
  sha256,
  reject,
  utc,
} from "./profile.mjs";
import { githubJson, unavailable } from "./http.mjs";
const conflict = () => {
  throw new Error("PUBLICATION_CONFLICT");
};
export const gitBlobSha1 = (bytes) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
export function githubConfiguration(input) {
  exact(input, ["repository", "repository_id", "path", "branch"]);
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(
      input.repository,
    ) ||
    input.repository.endsWith(".git") ||
    [".", ".."].includes(input.repository.split("/").at(-1)) ||
    typeof input.repository_id !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(input.repository_id) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(input.branch) ||
    typeof input.path !== "string" ||
    input.path.length > 1024 ||
    !/^testnet\/(?:[A-Za-z0-9_-]+\/){0,6}[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(
      input.path,
    )
  )
    reject();
  return Object.freeze(JSON.parse(canonical(input)));
}
export function prepareGitHubPublication(envelope, configuration) {
  const destination = githubConfiguration(configuration),
    bytes = envelopeBytes(envelope);
  return Object.freeze({
    profile: "DARKPOOL_GITHUB_CREATE_ONLY_V1",
    destination,
    envelope: JSON.parse(bytes.toString("utf8")),
    content_sha256: sha256(bytes),
    git_blob_sha1: gitBlobSha1(bytes),
  });
}
export const preparationDigest = (plan) => sha256(Buffer.from(canonical(plan)));
const api = (c) =>
  "https://api.github.com/repos/" +
  c.repository.slice("https://github.com/".length);
export async function checkPublicRepository(c, fetcher, signal) {
  const r = await githubJson(fetcher, api(c), { signal }),
    v = r.value;
  if (
    r.status !== 200 ||
    !v ||
    v.private !== false ||
    v.visibility !== "public" ||
    !Number.isSafeInteger(v.id) ||
    String(v.id) !== c.repository_id ||
    typeof v.full_name !== "string" ||
    v.full_name.toLowerCase() !== c.repository.slice(19).toLowerCase() ||
    v.archived !== false
  )
    unavailable();
}
// GET only and never authenticated. GitHub/TLS supplies commit-to-tree association;
// independently recompute the file's Git blob ID and exact SHA-256/content below.
async function fileAt(c, commit, fetcher, signal) {
  hex(commit, 20);
  const got = await githubJson(fetcher, api(c) + "/git/commits/" + commit, {
      signal,
    }),
    v = got.value;
  if (got.status !== 200 || v?.sha !== commit || !v.tree) unavailable();
  hex(v.tree.sha, 20);
  const tr = await githubJson(
    fetcher,
    api(c) + "/git/trees/" + v.tree.sha + "?recursive=1",
    { signal },
  );
  if (
    tr.status !== 200 ||
    tr.value?.sha !== v.tree.sha ||
    tr.value.truncated !== false ||
    !Array.isArray(tr.value.tree)
  )
    unavailable();
  const entries = tr.value.tree.filter((e) => e.path === c.path);
  if (!entries.length) return null;
  if (
    entries.length !== 1 ||
    entries[0].type !== "blob" ||
    entries[0].mode !== "100644"
  )
    reject();
  const blob = entries[0];
  hex(blob.sha, 20);
  const br = await githubJson(fetcher, api(c) + "/git/blobs/" + blob.sha, {
      signal,
    }),
    b = br.value;
  if (
    br.status !== 200 ||
    b?.sha !== blob.sha ||
    b.encoding !== "base64" ||
    typeof b.content !== "string" ||
    !Number.isSafeInteger(b.size) ||
    b.size < 1 ||
    b.size > 65536
  )
    reject();
  const text = b.content.replaceAll("\n", "");
  const bytes = Buffer.from(text, "base64");
  if (
    bytes.toString("base64") !== text ||
    bytes.length !== b.size ||
    gitBlobSha1(bytes) !== blob.sha
  )
    reject();
  return { bytes, git_blob_sha1: blob.sha };
}
export async function retrieveGitHubEnvelope(
  configuration,
  binding,
  { fetch: fetcher = globalThis.fetch, signal } = {},
) {
  const c = githubConfiguration(configuration);
  exact(binding, ["repository", "commit", "path"]);
  if (binding.repository !== c.repository || binding.path !== c.path) reject();
  hex(binding.commit, 20);
  await checkPublicRepository(c, fetcher, signal);
  const file = await fileAt(c, binding.commit, fetcher, signal);
  if (!file) unavailable();
  let envelope;
  try {
    envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
    );
  } catch {
    reject();
  }
  if (!envelopeBytes(envelope).equals(file.bytes)) reject();
  return Object.freeze({
    ...binding,
    content_sha256: sha256(file.bytes),
    git_blob_sha1: file.git_blob_sha1,
    envelope: JSON.parse(canonical(envelope)),
    envelope_base64: file.bytes.toString("base64"),
  });
}
async function existing(c, expected, fetcher) {
  await checkPublicRepository(c, fetcher);
  const r = await githubJson(
    fetcher,
    api(c) + "/git/ref/heads/" + encodeURIComponent(c.branch),
  );
  if (
    r.status !== 200 ||
    r.value?.ref !== "refs/heads/" + c.branch ||
    r.value.object?.type !== "commit"
  )
    unavailable();
  const head = hex(r.value.object.sha, 20);
  const present = await fileAt(c, head, fetcher);
  const history = await githubJson(
    fetcher,
    api(c) +
      "/commits?sha=" +
      head +
      "&path=" +
      encodeURIComponent(c.path) +
      "&per_page=2",
  );
  if (history.status !== 200 || !Array.isArray(history.value)) unavailable();
  if (!present) {
    if (history.value.length) conflict();
    return null;
  }
  if (!present.bytes.equals(expected) || history.value.length !== 1) conflict();
  const commit = hex(history.value[0].sha, 20),
    original = await fileAt(c, commit, fetcher);
  if (!original || !original.bytes.equals(expected)) conflict();
  return { commit, git_blob_sha1: present.git_blob_sha1 };
}
export function createGitHubPublisher(
  configuration,
  { fetch: fetcher = globalThis.fetch, credentials, authorize } = {},
) {
  const c = githubConfiguration(configuration);
  return async (input) => {
    // Snapshot before awaiting any approval/HTTP. No request-driven credentials or URLs.
    const plan = prepareGitHubPublication(input?.envelope, c);
    if (canonical(input) !== canonical(plan)) reject();
    if (
      typeof authorize !== "function" ||
      typeof credentials !== "function" ||
      (await authorize(preparationDigest(plan))) !== true
    )
      unavailable();
    const bytes = envelopeBytes(plan.envelope);
    const result = (found) =>
      Object.freeze({
        delivery: "COMMIT_RETRIEVED",
        publication: "UNVERIFIED",
        repository: c.repository,
        repository_id: c.repository_id,
        path: c.path,
        commit: found.commit,
        content_sha256: plan.content_sha256,
        git_blob_sha1: found.git_blob_sha1,
      });
    let found = await existing(c, bytes, fetcher);
    if (found) return result(found);
    const credential = await credentials();
    exact(credential, ["token", "expires_at"]);
    if (
      typeof credential.token !== "string" ||
      !/^[A-Za-z0-9_]{20,512}$/.test(credential.token) ||
      utc(credential.expires_at) <= Date.now() + 30000
    )
      unavailable();
    let write;
    try {
      write = await githubJson(fetcher, api(c) + "/contents/" + c.path, {
        method: "PUT",
        token: credential.token,
        body: {
          message: "Publish accepted ledger " + plan.content_sha256,
          content: bytes.toString("base64"),
          branch: c.branch,
        },
      });
    } catch {
      // One read-only reconciliation, never a second write in this invocation.
      try {
        found = await existing(c, bytes, fetcher);
      } catch (e) {
        if (e.message === "PUBLICATION_CONFLICT") throw e;
      }
      if (found) return result(found);
      throw new Error("PUBLICATION_DELIVERY_UNCONFIRMED");
    }
    if (
      write.status !== 201 ||
      write.value?.content?.sha !== plan.git_blob_sha1
    )
      reject();
    const commit = hex(write.value?.commit?.sha, 20);
    const retrieved = await retrieveGitHubEnvelope(
      c,
      { repository: c.repository, commit, path: c.path },
      { fetch: fetcher },
    );
    if (
      retrieved.content_sha256 !== plan.content_sha256 ||
      retrieved.envelope_base64 !== bytes.toString("base64")
    )
      reject();
    found = await existing(c, bytes, fetcher);
    if (!found || found.commit !== commit) conflict();
    return result(found);
  };
}

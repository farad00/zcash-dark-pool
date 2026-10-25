// Repeatable public GET diagnostic only; not a publisher, receipt or financial session.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  checkPublicRepository,
  githubConfiguration,
  gitBlobSha1,
} from "../../services/publication/github.mjs";
import { githubJson } from "../../services/publication/http.mjs";
import { hex, sha256 } from "../../services/publication/profile.mjs";
const fail = () => {
  throw new Error("READONLY_REPOSITORY_CHECK_FAILED");
};
export async function verifyRepositoryReadOnly(
  configuration,
  { fetch: fetcher = globalThis.fetch } = {},
) {
  const c = githubConfiguration(configuration);
  const fullName = c.repository.slice("https://github.com/".length),
    base = "https://api.github.com/repos/" + fullName;
  let requests = 0;
  const onlyGet = async (url, options) => {
    if (
      (url !== base && !url.startsWith(base + "/")) ||
      options.method !== "GET" ||
      options.body !== undefined ||
      options.headers.Authorization !== undefined
    )
      fail();
    requests++;
    return fetcher(url, options);
  };
  const get = async (suffix) => {
    const r = await githubJson(onlyGet, base + suffix);
    if (r.status !== 200) fail();
    return r.value;
  };
  await checkPublicRepository(c, onlyGet);
  const metadata = await get("");
  if (
    metadata.default_branch !== c.branch ||
    metadata.owner?.login !== fullName.split("/")[0] ||
    metadata.name !== fullName.split("/")[1]
  )
    fail();
  const branch = await get("/branches/" + c.branch);
  if (branch.name !== c.branch) fail();
  const commit = hex(branch.commit?.sha, 20);
  const ref = await get("/git/ref/heads/" + c.branch);
  if (
    ref.ref !== "refs/heads/" + c.branch ||
    ref.object?.type !== "commit" ||
    ref.object.sha !== commit
  )
    fail();
  const object = await get("/git/commits/" + commit);
  if (object.sha !== commit) fail();
  const treeSha = hex(object.tree?.sha, 20);
  const tree = await get("/git/trees/" + treeSha + "?recursive=1");
  if (
    tree.sha !== treeSha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.length !== 1
  )
    fail();
  const entry = tree.tree[0];
  if (
    entry.path !== "README.md" ||
    entry.type !== "blob" ||
    entry.mode !== "100644"
  )
    fail();
  hex(entry.sha, 20);
  const decode = (value) => {
    if (
      value?.encoding !== "base64" ||
      typeof value.content !== "string" ||
      value.sha !== entry.sha ||
      !Number.isSafeInteger(value.size) ||
      value.size < 1 ||
      value.size > 65536
    )
      fail();
    const text = value.content.replaceAll("\n", "");
    const bytes = Buffer.from(text, "base64");
    if (
      bytes.toString("base64") !== text ||
      bytes.length !== value.size ||
      gitBlobSha1(bytes) !== entry.sha
    )
      fail();
    return bytes;
  };
  const bytes = decode(await get("/git/blobs/" + entry.sha));
  const content = await get("/contents/README.md?ref=" + commit);
  if (
    content.type !== "file" ||
    content.path !== "README.md" ||
    !decode(content).equals(bytes)
  )
    fail();
  const history = await get(
    "/commits?sha=" +
      commit +
      "&path=" +
      encodeURIComponent(c.path) +
      "&per_page=2",
  );
  if (!Array.isArray(history) || history.length !== 0) fail();
  const after = await get("/git/ref/heads/" + c.branch);
  if (
    after.ref !== ref.ref ||
    after.object?.type !== "commit" ||
    after.object.sha !== commit
  )
    fail();
  return Object.freeze({
    status: "READONLY_VERIFIED",
    checked_at: new Date().toISOString(),
    repository: c.repository,
    repository_id: c.repository_id,
    owner: metadata.owner.login,
    name: metadata.name,
    default_branch: metadata.default_branch,
    commit,
    tree_sha1: treeSha,
    readme: {
      path: "README.md",
      bytes: bytes.length,
      git_blob_sha1: entry.sha,
      content_sha256: sha256(bytes),
      two_commit_pinned_routes_match: true,
    },
    public_commitment_path: c.path,
    commitment_path_absent: true,
    commitment_path_history_empty: true,
    head_unchanged: true,
    anonymous_get_requests: requests,
    publication: "NOT_PUBLISHED",
    financial_authorization: false,
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--public-get-only")
      fail();
    const c = JSON.parse(
      await readFile(
        new URL(
          "../../services/publication/github-destination.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    process.stdout.write(
      JSON.stringify(await verifyRepositoryReadOnly(c), null, 2) + "\n",
    );
  } catch {
    process.stderr.write("Read-only repository check unavailable or failed\n");
    process.exitCode = 1;
  }
}

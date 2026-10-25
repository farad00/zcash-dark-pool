// In-memory GitHub/independent archive simulation. Unknown destinations never hit a network.
import { gitBlobSha1 } from "../github.mjs";
import { envelopeBytes } from "../profile.mjs";
export const configuration = () => ({
  repository: "https://github.com/synthetic-fixture/ledger",
  repository_id: "123",
  path: "testnet/ledger-v1.json",
  branch: "main",
});
export const credential = async () => ({
  token: "synthetic_token_never_real_123456789",
  expires_at: new Date(Date.now() + 3600000).toISOString(),
});
const response = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export function githubFixture(envelope) {
  const c = configuration(),
    requests = [];
  const state = {
    head: "11".repeat(20),
    commit: "12".repeat(20),
    history: [],
    bytes: null,
    private: false,
    id: 123,
    visibility: "public",
    archived: false,
    truncated: false,
    mode: "100644",
    tamperBlob: false,
    archive: null,
    failWrite: false,
    loseWriteReply: false,
    readFailure: false,
    historyFailure: false,
    beforeWrite: null,
  };
  function install(value = envelope) {
    state.bytes = envelopeBytes(value);
    state.head = state.commit;
    state.history = [{ sha: state.commit }];
    state.archive = state.bytes;
  }
  async function fetcher(url, options = {}) {
    requests.push({ url, ...options });
    const u = new URL(url),
      method = options.method ?? "GET";
    if (u.origin === "https://synthetic-witness.invalid") {
      if (!state.archive) return response({}, 404);
      return new Response(state.archive, { status: 200 });
    }
    const prefix = "/repos/synthetic-fixture/ledger";
    if (u.origin !== "https://api.github.com" || !u.pathname.startsWith(prefix))
      throw new Error("MOCK_DESTINATION_REJECTED");
    const path = u.pathname.slice(prefix.length);
    if (state.readFailure && method === "GET") return response({}, 503);
    if (path === "")
      return response({
        id: state.id,
        private: state.private,
        visibility: state.visibility,
        archived: state.archived,
        full_name: "synthetic-fixture/ledger",
      });
    if (path === "/git/ref/heads/main")
      return response({
        ref: "refs/heads/main",
        object: { type: "commit", sha: state.head },
      });
    if (path.startsWith("/git/commits/"))
      return response({
        sha: path.split("/").at(-1),
        tree: { sha: "33".repeat(20) },
      });
    if (path.startsWith("/git/trees/"))
      return response({
        sha: "33".repeat(20),
        truncated: state.truncated,
        tree: state.bytes
          ? [
              {
                path: c.path,
                mode: state.mode,
                type: "blob",
                sha: gitBlobSha1(state.bytes),
              },
            ]
          : [],
      });
    if (path.startsWith("/git/blobs/")) {
      const bytes = state.tamperBlob ? Buffer.from("tampered") : state.bytes;
      return response({
        sha: path.split("/").at(-1),
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
      });
    }
    if (path === "/commits")
      return state.historyFailure ? response({}, 503) : response(state.history);
    if (path === "/contents/" + c.path && method === "PUT") {
      if (state.beforeWrite) await state.beforeWrite();
      if (state.failWrite)
        return response({ message: "synthetic confidential diagnostic" }, 403);
      if (state.bytes) return response({}, 422);
      const body = JSON.parse(options.body);
      state.bytes = Buffer.from(body.content, "base64");
      state.head = state.commit;
      state.history = [{ sha: state.commit }];
      state.archive = state.bytes;
      if (state.loseWriteReply) throw new Error("synthetic secret diagnostic");
      return response(
        {
          content: { sha: gitBlobSha1(state.bytes) },
          commit: { sha: state.commit },
        },
        201,
      );
    }
    throw new Error("MOCK_ENDPOINT_REJECTED");
  }
  return { c, state, requests, install, fetch: fetcher };
}

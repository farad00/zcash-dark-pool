// Witness/TSA authority stays in the unchanged verifier. No signing or TSA submission.
import { trustProfile, exact, reject, decode64 } from "./profile.mjs";
import { verifyPublication } from "./verify.mjs";
import { githubConfiguration, retrieveGitHubEnvelope } from "./github.mjs";
import { publicRequest, unavailable } from "./http.mjs";

export function createPublicRetrieval(
  configuration,
  configuredTrust,
  { fetch: fetcher = globalThis.fetch } = {},
) {
  const c = githubConfiguration(configuration),
    trust = trustProfile(configuredTrust);
  if (c.repository !== trust.repository || c.path !== trust.path) reject();
  return async (binding, { signal } = {}) => {
    exact(binding, ["repository", "commit", "path", "archive_url"]);
    if (
      binding.repository !== c.repository ||
      binding.path !== c.path ||
      typeof binding.archive_url !== "string" ||
      binding.archive_url.length > 2048 ||
      /[\u0000-\u0020\\%]/.test(binding.archive_url)
    )
      reject();
    const url = new URL(binding.archive_url);
    if (
      url.origin !== trust.archive_origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname === "/"
    )
      reject();
    const [file, archive] = await Promise.all([
      retrieveGitHubEnvelope(
        c,
        {
          repository: binding.repository,
          path: binding.path,
          commit: binding.commit,
        },
        { fetch: fetcher, signal },
      ),
      publicRequest(fetcher, url.href, { signal }),
    ]);
    if (archive.status !== 200 || archive.bytes.length > 65536) unavailable();
    if (!archive.bytes.equals(decode64(file.envelope_base64, 65536))) reject();
    return Object.freeze({
      ...binding,
      repository_bytes: file.envelope_base64,
      archive_bytes: archive.bytes.toString("base64"),
    });
  };
}
export async function verifyGitHubPublication(
  envelope,
  evidence,
  {
    configuration,
    trust,
    executable,
    fetch: fetcher = globalThis.fetch,
    now = Date.now(),
    clock_checks,
    recordClockAudit,
  },
) {
  const retrieve = createPublicRetrieval(configuration, trust, {
    fetch: fetcher,
  });
  return verifyPublication(
    envelope,
    evidence,
    trust,
    executable,
    retrieve,
    now,
    { clock_checks, recordClockAudit },
  );
}

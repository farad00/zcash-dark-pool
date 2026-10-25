// Fixed synthetic publication child. No database, wallet, witness or TSA access.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syntheticPlan } from "../../tools/commitment-witness/synthetic.mjs";
import { durableWrite } from "../../tools/commitment-witness/operational.mjs";
import { canonical, envelopeBytes, utc, hex } from "./profile.mjs";
import { githubJson } from "./http.mjs";
import {
  createGitHubPublisher,
  preparationDigest,
  retrieveGitHubEnvelope,
} from "./github.mjs";

export async function publishSyntheticOnce({
  environment,
  directory,
  fetch: transport = globalThis.fetch,
}) {
  const plan = syntheticPlan(),
    approved =
      "bffc49f876bf71c34384c4df81253ddc7021030c55f31bf2d764f8b6dc60574f";
  if (
    environment.DARKPOOL_SYNTHETIC_APPROVED_PLAN !== approved ||
    preparationDigest(plan) !== approved ||
    !/^[A-Za-z0-9_]{20,512}$/.test(environment.DARKPOOL_GITHUB_TOKEN ?? "") ||
    utc(environment.DARKPOOL_GITHUB_TOKEN_EXPIRES_AT) <= Date.now() + 30000
  )
    throw Error("PUBLICATION_UNAVAILABLE");
  const base =
    "https://api.github.com/repos/farad00/zcash-dark-pool-commitments";
  let stopped = false,
    puts = 0;
  const bounded = async (url, options) => {
    if (
      stopped ||
      typeof url !== "string" ||
      (!url.startsWith(base + "/") && url !== base)
    )
      throw Error("PUBLICATION_UNAVAILABLE");
    try {
      if (options.method === "PUT") {
        if (
          puts ||
          url !== base + "/contents/" + plan.destination.path ||
          !options.headers.Authorization
        )
          throw Error();
        const body = JSON.parse(options.body);
        if (
          canonical(Object.keys(body).sort()) !==
            canonical(["branch", "content", "message"]) ||
          body.branch !== "main" ||
          body.content !== envelopeBytes(plan.envelope).toString("base64") ||
          body.message !== "Publish accepted ledger " + plan.content_sha256
        )
          throw Error();
        puts++;
        await durableWrite(
          join(directory, "submission-attempt.json"),
          canonical({
            scope: "SYNTHETIC_TEST_ONLY",
            plan_sha256: approved,
            financial_authorization: "NOT_GRANTED",
          }),
        );
      } else if (
        options.method !== "GET" ||
        options.headers.Authorization ||
        options.body !== undefined
      )
        throw Error();
      const response = await transport(url, options);
      if (
        ![200, 201, 404].includes(response.status) ||
        (options.method === "PUT" && response.status !== 201)
      )
        throw Error();
      if (options.method === "PUT") {
        // Validate the one original response through the existing bounded
        // adapter before returning it. The inner fetch merely consumes this
        // response; it cannot send another request. Any malformed/ambiguous
        // write stops the publisher's optional read-reconciliation path.
        const checked = await githubJson(async () => response, url, {
          method: "PUT",
          token: environment.DARKPOOL_GITHUB_TOKEN,
          body: JSON.parse(options.body),
        });
        if (
          checked.status !== 201 ||
          checked.value?.content?.sha !== plan.git_blob_sha1
        )
          throw Error();
        hex(checked.value?.commit?.sha, 20);
        return new Response(checked.bytes, {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return response;
    } catch {
      stopped = true;
      throw Error("PUBLICATION_DELIVERY_UNCONFIRMED");
    }
  };
  // An existing file, even identical, is not permission for this first-create operation.
  const repo = await githubJson(bounded, base);
  if (
    repo.status !== 200 ||
    repo.value?.id !== 1427973036 ||
    repo.value.default_branch !== "main" ||
    repo.value.full_name !== "farad00/zcash-dark-pool-commitments" ||
    repo.value.private !== false
  )
    throw Error("PUBLICATION_UNAVAILABLE");
  const absent = await githubJson(
    bounded,
    base + "/contents/" + plan.destination.path + "?ref=main",
  );
  if (absent.status !== 404) throw Error("PUBLICATION_CONFLICT");
  const publish = createGitHubPublisher(plan.destination, {
    fetch: bounded,
    authorize: async (digest) => digest === approved,
    credentials: async () => ({
      token: environment.DARKPOOL_GITHUB_TOKEN,
      expires_at: environment.DARKPOOL_GITHUB_TOKEN_EXPIRES_AT,
    }),
  });
  const delivery = await publish(plan);
  if (puts !== 1) throw Error("PUBLICATION_CONFLICT");
  await durableWrite(join(directory, "delivery.json"), canonical(delivery));
  const retrieved = await retrieveGitHubEnvelope(
    plan.destination,
    {
      repository: plan.destination.repository,
      commit: delivery.commit,
      path: plan.destination.path,
    },
    { fetch: bounded },
  );
  if (
    retrieved.content_sha256 !== plan.content_sha256 ||
    retrieved.envelope_base64 !==
      envelopeBytes(plan.envelope).toString("base64")
  )
    throw Error("PUBLICATION_REJECTED");
  const public_retrieval_url =
    "https://raw.githubusercontent.com/farad00/zcash-dark-pool-commitments/" +
    delivery.commit +
    "/" +
    plan.destination.path;
  await durableWrite(
    join(directory, "public-handoff.json"),
    canonical({
      commit: delivery.commit,
      content_sha256: plan.content_sha256,
      envelope: plan.envelope,
    }),
  );
  await durableWrite(
    join(directory, "retrieval.json"),
    canonical({
      scope: "SYNTHETIC_TEST_ONLY",
      commit: delivery.commit,
      content_sha256: retrieved.content_sha256,
      public_retrieval_url,
      verification: "ANONYMOUS_COMMIT_TREE_BLOB_RETRIEVAL",
      financial_authorization: "NOT_GRANTED",
    }),
  );
  return {
    scope: "SYNTHETIC_TEST_ONLY",
    status: "GITHUB_FILE_RETRIEVED_NO_RECEIPT",
    repository_id: "1427973036",
    commit: delivery.commit,
    content_sha256: plan.content_sha256,
    financial_authorization: "NOT_GRANTED",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      process.argv.length !== 2 ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_EXTRA_CA_CERTS ||
      !process.env.DARKPOOL_SYNTHETIC_WORKDIR
    )
      throw Error();
    const trust = JSON.parse(
      await readFile(new URL("./witness-public.json", import.meta.url), "utf8"),
    );
    if (trust.trust.status !== "UNAVAILABLE") throw Error();
    const result = await publishSyntheticOnce({
      environment: process.env,
      directory: resolve(process.env.DARKPOOL_SYNTHETIC_WORKDIR),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write("PUBLICATION_NOT_CONFIRMED_RECONCILE_NO_RETRY\n");
    process.exitCode = 1;
  }
}

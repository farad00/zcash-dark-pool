import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { openssl } from "../verify.mjs";
import {
  createGitHubPublisher,
  prepareGitHubPublication,
  preparationDigest,
  retrieveGitHubEnvelope,
  githubConfiguration,
  gitBlobSha1,
} from "../github.mjs";
import {
  createPublicRetrieval,
  verifyGitHubPublication,
} from "../github-receipt.mjs";
import { publicRequest } from "../http.mjs";
import { envelopeBytes, canonical } from "../profile.mjs";
import { authority, envelope, executable } from "./fixtures.mjs";
import {
  githubFixture,
  configuration,
  credential,
} from "./github-fixtures.mjs";

// Any accidentally omitted injected HTTP dependency is a hard failure, never a real request.
globalThis.fetch = async () => {
  throw new Error("TEST_NETWORK_DISABLED");
};

let issuer, ledger, proof;
before(async () => {
  issuer = await authority();
  ledger = envelope();
  proof = await issuer.evidence(ledger);
});
after(async () => {
  await issuer?.close();
});
const setup = () => {
  const f = githubFixture(ledger),
    plan = prepareGitHubPublication(ledger, f.c);
  const publish = createGitHubPublisher(f.c, {
    fetch: f.fetch,
    credentials: credential,
    authorize: async (digest) => digest === preparationDigest(plan),
  });
  return { ...f, plan, publish };
};
const binding = (f) => ({
  repository: f.c.repository,
  path: f.c.path,
  commit: f.state.commit,
});
const verify = (f, evidence = proof, trust = issuer.trust) =>
  verifyGitHubPublication(ledger, evidence, {
    configuration: f.c,
    trust,
    executable,
    fetch: f.fetch,
  });

test("canonical five-field preparation and independent standard Git blob literal", () => {
  const f = setup();
  assert.equal(
    gitBlobSha1(Buffer.from("hello\n")),
    "ce013625030ba8dba906f756967f9e9ca394464a",
  );
  assert.equal(f.plan.content_sha256.length, 64);
  assert.equal(preparationDigest(f.plan).length, 64);
  assert.deepEqual(Object.keys(f.plan.envelope).sort(), [
    "accepted_ticket_count",
    "ledger_version",
    "locked_at",
    "market_id",
    "merkle_root",
  ]);
  const reversed = Object.fromEntries(Object.entries(ledger).reverse());
  assert.deepEqual(prepareGitHubPublication(reversed, f.c), f.plan);
  for (const privateField of [
    "side",
    "stake",
    "record_blinding",
    "claim_secret",
    "receiving_address",
    "viewing_key",
  ])
    assert.throws(() =>
      prepareGitHubPublication(
        { ...ledger, [privateField]: "synthetic private marker" },
        f.c,
      ),
    );
});
test("configuration rejects arbitrary hosts, private paths, wrong IDs and branch injection", () => {
  const c = configuration();
  for (const bad of [
    { repository: "https://evil.invalid/a/b" },
    { repository: "https://github.com/a/.." },
    { repository_id: "0" },
    { repository_id: 123 },
    { path: "../secret" },
    { path: ".github/workflows/job.yml" },
    { path: "testnet/../secret.json" },
    { branch: "main?x=y" },
    { path: "testnet/%2e.json" },
    { token: "not permitted in config" },
  ])
    assert.throws(() => githubConfiguration({ ...c, ...bad }));
});
test("no approval or token source means no network or publication", async () => {
  const f = setup();
  for (const options of [
    {},
    { authorize: async () => true },
    { credentials: credential },
  ])
    await assert.rejects(
      createGitHubPublisher(f.c, { fetch: f.fetch, ...options })(f.plan),
      /PUBLICATION_UNAVAILABLE/,
    );
  assert.equal(f.requests.length, 0);
});
test("approved create-only delivery sends exactly approved public bytes, then reads anonymously", async () => {
  const f = setup(),
    r = await f.publish(f.plan);
  assert.equal(r.delivery, "COMMIT_RETRIEVED");
  assert.equal(r.publication, "UNVERIFIED");
  assert.equal(r.commit, f.state.commit);
  const writes = f.requests.filter((q) => q.method === "PUT");
  assert.equal(writes.length, 1);
  const body = JSON.parse(writes[0].body);
  assert.deepEqual(Object.keys(body).sort(), ["branch", "content", "message"]);
  assert.equal(body.branch, "main");
  assert.equal(body.sha, undefined);
  assert(Buffer.from(body.content, "base64").equals(envelopeBytes(ledger)));
  for (const q of f.requests) {
    assert.equal(q.redirect, "error");
    assert.equal(q.credentials, "omit");
    if (q.method === "GET") assert.equal(q.headers.Authorization, undefined);
  }
  assert.equal(r.token, undefined);
  assert.equal(r.envelope, undefined);
});
test("identical retries recover the original immutable commit without credential retrieval or another write", async () => {
  const f = setup(),
    a = await f.publish(f.plan);
  const retry = createGitHubPublisher(f.c, {
    fetch: f.fetch,
    authorize: async () => true,
    credentials: async () => {
      throw new Error("must not read token");
    },
  });
  assert.deepEqual(await retry(f.plan), a);
  assert.equal(f.requests.filter((q) => q.method === "PUT").length, 1);
});
test("conflicting root, count, lock timestamp or market cannot replace an existing artifact", async () => {
  const f = setup();
  await f.publish(f.plan);
  for (const change of [
    { merkle_root: "cd".repeat(32) },
    { accepted_ticket_count: "3" },
    { market_id: "other" },
    { locked_at: new Date(Date.now() - 10000).toISOString() },
  ]) {
    const p = prepareGitHubPublication({ ...ledger, ...change }, f.c);
    const publisher = createGitHubPublisher(f.c, {
      fetch: f.fetch,
      credentials: credential,
      authorize: async () => true,
    });
    await assert.rejects(publisher(p), /PUBLICATION_CONFLICT/);
  }
  assert.equal(f.requests.filter((q) => q.method === "PUT").length, 1);
});
test("edited history and deletion history fail closed even when current bytes match or are absent", async () => {
  const f = setup();
  f.install();
  f.state.history.push({ sha: "ab".repeat(20) });
  await assert.rejects(f.publish(f.plan), /PUBLICATION_CONFLICT/);
  f.state.bytes = null;
  f.state.history = [{ sha: f.state.commit }];
  await assert.rejects(f.publish(f.plan), /PUBLICATION_CONFLICT/);
  assert.equal(f.requests.filter((q) => q.method === "PUT").length, 0);
});
test("concurrent identical requests create one file and recover one original commit", async () => {
  const f = setup();
  const results = await Promise.all([f.publish(f.plan), f.publish(f.plan)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.state.history.length, 1);
});
test("competing root arriving during create is rejected without overwrite", async () => {
  const f = setup();
  f.state.beforeWrite = async () =>
    f.install({ ...ledger, merkle_root: "ce".repeat(32) });
  await assert.rejects(f.publish(f.plan), /PUBLICATION_CONFLICT/);
  assert.equal(f.requests.filter((q) => q.method === "PUT").length, 1);
});
test("lost successful response reconciles same original bytes and commit without second PUT", async () => {
  const f = setup();
  f.state.loseWriteReply = true;
  const r = await f.publish(f.plan);
  assert.equal(r.commit, f.state.commit);
  assert.equal(r.publication, "UNVERIFIED");
  assert.equal(f.requests.filter((q) => q.method === "PUT").length, 1);
});
test("unknown delivery result stays unconfirmed, never auto-retries a write", async () => {
  const f = setup();
  f.state.failWrite = true;
  await assert.rejects(f.publish(f.plan), /PUBLICATION_DELIVERY_UNCONFIRMED/);
  assert.equal(f.requests.filter((q) => q.method === "PUT").length, 1);
  assert.equal(f.state.bytes, null);
});
test("expired/malformed credentials reject before PUT and are never sent to anonymous readers", async () => {
  for (const credentialValue of [
    {
      token: "synthetic_token_never_real_123456789",
      expires_at: "2000-01-01T00:00:00Z",
    },
    {
      token: "bad\r\nAuthorization",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  ]) {
    const f = setup(),
      publisher = createGitHubPublisher(f.c, {
        fetch: f.fetch,
        authorize: async () => true,
        credentials: async () => credentialValue,
      });
    await assert.rejects(publisher(f.plan));
    assert.equal(f.requests.filter((q) => q.method === "PUT").length, 0);
    assert(f.requests.every((q) => q.headers.Authorization === undefined));
  }
});
test("private, moved/incorrect-ID, archived, missing and unavailable repositories cannot publish", async () => {
  for (const change of [
    { private: true },
    { id: 456 },
    { visibility: "private" },
    { archived: true },
    { readFailure: true },
    { historyFailure: true },
  ]) {
    const f = setup();
    Object.assign(f.state, change);
    await assert.rejects(f.publish(f.plan));
    assert.equal(f.requests.filter((q) => q.method === "PUT").length, 0);
  }
});
test("mutated preparation or wrong destination does not invoke any HTTP", async () => {
  const f = setup();
  for (const p of [
    { ...f.plan, content_sha256: "00".repeat(32) },
    { ...f.plan, claim_secret: "marker" },
    { ...f.plan, destination: { ...f.c, branch: "other" } },
  ])
    await assert.rejects(f.publish(p));
  assert.equal(f.requests.length, 0);
});
test("commit-pinned tree/blob retrieval recomputes both hashes and canonical bytes", async () => {
  const f = setup();
  f.install();
  const r = await retrieveGitHubEnvelope(f.c, binding(f), { fetch: f.fetch });
  assert.equal(r.git_blob_sha1, f.plan.git_blob_sha1);
  assert.equal(r.content_sha256, f.plan.content_sha256);
  assert.equal(r.envelope_base64, envelopeBytes(ledger).toString("base64"));
  assert(
    f.requests.some((q) => q.url.endsWith("/git/commits/" + f.state.commit)),
  );
  assert(
    f.requests.every((q) => q.method === "GET" && !q.headers.Authorization),
  );
  await assert.rejects(
    retrieveGitHubEnvelope(
      f.c,
      { ...binding(f), commit: "main" },
      { fetch: f.fetch },
    ),
  );
  await assert.rejects(
    retrieveGitHubEnvelope(
      f.c,
      { ...binding(f), repository: "https://github.com/other/ledger" },
      { fetch: f.fetch },
    ),
  );
});
test("tampered blob, symlink, incomplete tree, malformed/noncanonical/private envelope reject", async () => {
  for (const change of [
    { tamperBlob: true },
    { mode: "120000" },
    { truncated: true },
    { bytes: Buffer.from([255]) },
    { bytes: Buffer.from(JSON.stringify(ledger, null, 2)) },
    { bytes: Buffer.from(canonical({ ...ledger, side: "YES" })) },
  ]) {
    const f = setup();
    f.install();
    Object.assign(f.state, change);
    await assert.rejects(
      retrieveGitHubEnvelope(f.c, binding(f), { fetch: f.fetch }),
    );
  }
});
test("network helper bounds response bytes, validates UTF8, refuses redirects and suppresses diagnostics", async () => {
  for (const response of [
    new Response("x".repeat(262145)),
    new Response("small", { headers: { "Content-Length": "262145" } }),
    new Response("redirect", { status: 302 }),
    new Response("token=synthetic_sensitive_marker", { status: 401 }),
    new Response("unavailable", { status: 503 }),
  ]) {
    await assert.rejects(
      publicRequest(async () => response, "https://api.github.com/mock"),
      (e) =>
        e.message === "PUBLICATION_UNAVAILABLE" &&
        !e.message.includes("sensitive"),
    );
  }
  await assert.rejects(
    publicRequest(async () => {
      throw new Error("marker");
    }, "http://unsafe.invalid"),
    /PUBLICATION_UNAVAILABLE/,
  );
});
test("independent archive and GitHub reads feed the unchanged cryptographic verifier", async () => {
  const f = setup();
  f.install();
  const result = await verify(f);
  assert.equal(result.evidence_class, "SYNTHETIC_TEST");
  assert.equal(result.content_sha256, f.plan.content_sha256);
  assert.equal(result.merkle_root, ledger.merkle_root);
  assert(
    f.requests.every(
      (q) => q.method === "GET" && q.headers.Authorization === undefined,
    ),
  );
});
test("missing trust, witness or timestamp cannot become verified publication", async () => {
  const f = setup();
  f.install();
  await assert.rejects(verify(f, proof, null), /PUBLICATION_UNAVAILABLE/);
  for (const key of ["signature", "statement", "tsq", "tsr", "envelope"]) {
    const p = structuredClone(proof);
    delete p[key];
    await assert.rejects(verify(f, p));
  }
});
test("forged/changed evidence, synthetic-to-external relabel and stale time ordering fail closed", async () => {
  const f = setup();
  f.install();
  for (const p of [
    { ...proof, signature: Buffer.alloc(64).toString("base64") },
    { ...proof, tsr: Buffer.alloc(80).toString("base64") },
    { ...proof, statement: { ...proof.statement, commit: "ab".repeat(20) } },
  ])
    await assert.rejects(verify(f, p));
  await assert.rejects(
    verify(f, proof, { ...issuer.trust, evidence_class: "EXTERNAL" }),
  );
  const bad = await issuer.evidence(ledger, (s) => {
    s.observed_at = new Date(Date.now() - 10000).toISOString();
  });
  await assert.rejects(
    verify(f, bad, { ...issuer.trust, max_witness_lag_seconds: 0 }),
  );
});
test("wrong repository/path policy, untrusted witness and timestamp chain reject", async () => {
  const f = setup();
  f.install();
  assert.throws(() =>
    createPublicRetrieval(
      f.c,
      { ...issuer.trust, path: "testnet/other.json" },
      { fetch: f.fetch },
    ),
  );
  const other = await authority();
  try {
    await assert.rejects(
      verify(f, proof, {
        ...issuer.trust,
        witness_spki: other.trust.witness_spki,
      }),
    );
    await assert.rejects(
      verify(f, proof, { ...issuer.trust, ca_bundle: other.trust.ca_bundle }),
    );
  } finally {
    await other.close();
  }
});
test("archive tampering, outage, redirects and arbitrary receipt URLs fail closed", async () => {
  const f = setup();
  f.install();
  f.state.archive = Buffer.from("changed");
  await assert.rejects(verify(f));
  f.state.archive = null;
  await assert.rejects(verify(f));
  const retrieve = createPublicRetrieval(f.c, issuer.trust, { fetch: f.fetch });
  for (const url of [
    "https://evil.invalid/object",
    "https://synthetic-witness.invalid/?x=1",
    "https://synthetic-witness.invalid/%2e%2e/a",
    "https://synthetic-witness.invalid/object#part",
  ])
    await assert.rejects(retrieve({ ...binding(f), archive_url: url }));
  const redirect = async (url, options) =>
    url.startsWith(issuer.trust.archive_origin)
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://evil.invalid" },
        })
      : f.fetch(url, options);
  await assert.rejects(
    verifyGitHubPublication(ledger, proof, {
      configuration: f.c,
      trust: issuer.trust,
      executable,
      fetch: redirect,
    }),
  );
});

test("bounded HTTP cancellation rejects an unresponsive service", async () => {
  let aborted = false;
  await assert.rejects(
    publicRequest(
      async (_url, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("private diagnostics suppressed"));
            },
            { once: true },
          );
        }),
      "https://api.github.com/mock",
    ),
    /PUBLICATION_UNAVAILABLE/,
  );
  assert.equal(aborted, true);
});

test("native RFC3161 chain and CRL validity rejects expiry with an advanced verification clock", async () => {
  // Public synthetic evidence only. Same native verification flags as the frozen verifier;
  // -attime advances the verifier clock without changing system time or production policy.
  const directory = await mkdtemp(
    join(tmpdir(), "darkpool-publication-expiry-"),
  );
  try {
    const query = join(directory, "query"),
      reply = join(directory, "reply"),
      ca = join(directory, "ca");
    await Promise.all([
      writeFile(query, Buffer.from(proof.tsq, "base64")),
      writeFile(reply, Buffer.from(proof.tsr, "base64")),
      writeFile(ca, issuer.trust.ca_bundle),
    ]);
    const args = [
      "ts",
      "-verify",
      "-queryfile",
      query,
      "-in",
      reply,
      "-CAfile",
      ca,
      "-CApath",
      directory,
      "-CAstore",
      ca,
      "-crl_check_all",
    ];
    assert.match(await openssl(executable, args), /Verification: OK/);
    await assert.rejects(
      openssl(executable, [
        ...args,
        "-attime",
        String(Math.floor(Date.now() / 1000) + 8 * 86400),
      ]),
      /PUBLICATION_REJECTED/,
    );
  } finally {
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + "/") &&
      !resolve(directory).startsWith(resolve(tmpdir()) + "\\")
    )
      throw new Error("Unsafe temporary cleanup");
    if (!basename(directory).startsWith("darkpool-publication-expiry-"))
      throw new Error("Unsafe temporary cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { publishSyntheticOnce } from "../github-publish-cli.mjs";
import {
  syntheticEnvelope,
  syntheticDestination,
  syntheticPlan,
} from "../../../tools/commitment-witness/synthetic.mjs";
import { preparationDigest } from "../github.mjs";
import { githubFixture } from "./github-fixtures.mjs";

globalThis.fetch = async () => {
  throw Error("TEST_NETWORK_DISABLED");
};
const executable = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const worker = fileURLToPath(
  new URL("./credential-loader.fixture.ps1", import.meta.url),
);
const run = promisify(execFile);
const cases = [
  "roundtrip",
  "duplicate",
  "wrong-user",
  "wrong-repository",
  "wrong-repository-name",
  "metadata-type",
  "expired",
  "missing-expiry",
  "invalid-expiry",
  "corruption",
  "wrong-entropy",
  "extra-field",
  "oversize",
  "file-acl",
  "root-acl",
  "missing",
  "invalid-token",
  "child-isolation",
  "child-output-redaction",
  "child-error-redaction",
  "child-timeout",
  "child-oversize",
  "exclusive-marker",
];
for (const name of cases)
  test("Windows synthetic credential: " + name, async () => {
    assert.equal(
      process.platform,
      "win32",
      "Native DPAPI/ACL tests require Windows; do not silently skip.",
    );
    // Never inherit an operator token, NODE_OPTIONS, database auth or test wallet settings.
    const env = { NODE_TEST_CONTEXT: "child-v8" };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key]) env[key] = process.env[key];
    const result = await run(
      executable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        worker,
        "-Case",
        name,
      ],
      { env, windowsHide: true, timeout: 20000, maxBuffer: 8192 },
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "SYNTHETIC_PASS:" + name);
  });
test("Launch without explicit plan approval fails before credential access", async () => {
  const entry = fileURLToPath(
    new URL(
      "../../../scripts/dev/publication-credentials.ps1",
      import.meta.url,
    ),
  );
  await assert.rejects(
    run(
      executable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        entry,
        "-Action",
        "Launch",
      ],
      {
        env: { SystemRoot: process.env.SystemRoot },
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4096,
      },
    ),
    (error) => {
      assert.equal(error.stdout, "");
      assert.equal(
        error.stderr.trim(),
        "PUBLICATION_OPERATION_NOT_CONFIRMED; retain original credentials and attempt markers; no automatic retry.",
      );
      return true;
    },
  );
});
test("Check rejects redirected LOCALAPPDATA without using the actual credential store", async () => {
  const entry = fileURLToPath(
    new URL(
      "../../../scripts/dev/publication-credentials.ps1",
      import.meta.url,
    ),
  );
  await assert.rejects(
    run(
      executable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        entry,
        "-Action",
        "Check",
      ],
      {
        env: {
          SystemRoot: process.env.SystemRoot,
          LOCALAPPDATA: "C:\\SYNTHETIC_UNTRUSTED_PUBLICATION_PROFILE",
        },
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4096,
      },
    ),
    (error) => {
      assert.equal(error.stdout, "");
      assert.equal(
        error.stderr.trim(),
        "PUBLICATION_OPERATION_NOT_CONFIRMED; retain original credentials and attempt markers; no automatic retry.",
      );
      return true;
    },
  );
});

async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), "darkpool-publisher-loader-"));
  const model = githubFixture(syntheticEnvelope),
    requests = [];
  const environment = {
    DARKPOOL_GITHUB_TOKEN: "SYNTHETIC_TOKEN_NOT_REAL_1234567890",
    DARKPOOL_GITHUB_TOKEN_EXPIRES_AT: new Date(
      Date.now() + 3600000,
    ).toISOString(),
    DARKPOOL_SYNTHETIC_APPROVED_PLAN: preparationDigest(syntheticPlan()),
  };
  let unexpectedBranch = false,
    existing = false,
    malformed = false;
  const transport = async (url, options) => {
    requests.push({
      url,
      method: options.method,
      authenticated: Boolean(options.headers.Authorization),
    });
    const source =
      "https://api.github.com/repos/farad00/zcash-dark-pool-commitments";
    assert(url === source || url.startsWith(source + "/"));
    if (url === source)
      return Response.json({
        id: 1427973036,
        full_name: "farad00/zcash-dark-pool-commitments",
        default_branch: unexpectedBranch ? "other" : "main",
        private: false,
        visibility: "public",
        archived: false,
      });
    if (url.includes("/contents/") && options.method === "GET")
      return Response.json({}, { status: existing ? 200 : 404 });
    const mapped = url
      .replace(source, "https://api.github.com/repos/synthetic-fixture/ledger")
      .replace(syntheticDestination.path, model.c.path);
    const response = await model.fetch(mapped, options);
    if (options.method === "PUT" && malformed)
      return new Response("not-json", { status: 201 });
    if (url.includes("/git/trees/")) {
      const object = await response.json();
      for (const entry of object.tree) entry.path = syntheticDestination.path;
      return Response.json(object);
    }
    return response;
  };
  try {
    await work({
      directory,
      model,
      requests,
      environment,
      transport,
      branchMismatch: () => {
        unexpectedBranch = true;
      },
      existing: () => {
        existing = true;
      },
      malformed: () => {
        malformed = true;
      },
    });
  } finally {
    if (
      !resolve(directory).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ) ||
      !basename(directory).startsWith("darkpool-publisher-loader-")
    )
      throw Error("UNSAFE_CLEANUP");
    await rm(directory, { recursive: true, force: true });
  }
}
const publish = (f) =>
  publishSyntheticOnce({
    environment: f.environment,
    directory: f.directory,
    fetch: f.transport,
  });
test("fixed publisher child uses one mocked PUT, public pinned retrieval and redacted handoff", () =>
  fixture(async (f) => {
    const result = await publish(f);
    assert.equal(result.commit, f.model.state.commit);
    assert.equal(result.financial_authorization, "NOT_GRANTED");
    assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
    assert(
      f.requests
        .filter((r) => r.method === "GET")
        .every((r) => !r.authenticated),
    );
    const handoff = JSON.parse(
      await readFile(join(f.directory, "public-handoff.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(handoff).sort(), [
      "commit",
      "content_sha256",
      "envelope",
    ]);
    assert.deepEqual(handoff.envelope, syntheticEnvelope);
    assert(
      !JSON.stringify(result).includes(f.environment.DARKPOOL_GITHUB_TOKEN),
    );
  }));
test("missing approval or expired credential rejects before any network call", () =>
  fixture(async (f) => {
    delete f.environment.DARKPOOL_SYNTHETIC_APPROVED_PLAN;
    await assert.rejects(publish(f));
    f.environment.DARKPOOL_SYNTHETIC_APPROVED_PLAN =
      preparationDigest(syntheticPlan());
    f.environment.DARKPOOL_GITHUB_TOKEN_EXPIRES_AT = "2020-01-01T00:00:00Z";
    await assert.rejects(publish(f));
    assert.equal(f.requests.length, 0);
  }));
test("unexpected existing destination refuses even identical content", () =>
  fixture(async (f) => {
    f.existing();
    await assert.rejects(publish(f));
    assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
  }));
test("unexpected branch cannot use the stored credential", () =>
  fixture(async (f) => {
    f.branchMismatch();
    await assert.rejects(publish(f));
    assert.equal(f.requests.filter((r) => r.authenticated).length, 0);
  }));
for (const kind of ["rejection", "ambiguous", "malformed"])
  test(
    "publisher " +
      kind +
      " stops with one attempted PUT and no reconciliation requests",
    () =>
      fixture(async (f) => {
        if (kind === "rejection") f.model.state.failWrite = true;
        if (kind === "ambiguous") f.model.state.loseWriteReply = true;
        if (kind === "malformed") f.malformed();
        await assert.rejects(publish(f));
        assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
        assert.equal(f.requests.at(-1).method, "PUT");
        assert(
          !JSON.stringify(
            JSON.parse(
              await readFile(
                join(f.directory, "submission-attempt.json"),
                "utf8",
              ),
            ),
          ).includes(f.environment.DARKPOOL_GITHUB_TOKEN),
        );
      }),
  );

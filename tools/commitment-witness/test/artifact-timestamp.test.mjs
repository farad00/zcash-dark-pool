import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import candidate from "../synthetic/witness-config.proposed.json" with { type: "json" };
import {
  canonical,
  sha256,
  envelopeBytes,
  trustProfile,
} from "../../../services/publication/profile.mjs";
import {
  authority,
  executable,
} from "../../../services/publication/test/fixtures.mjs";
import { gitBlobSha1 } from "../../../services/publication/github.mjs";
import { verifyRfc3161 } from "../../../services/publication/rfc3161.mjs";
import { verifyPublication } from "../../../services/publication/verify.mjs";
import { captureClock } from "../operational.mjs";
import { syntheticPlan, syntheticRecord } from "../synthetic.mjs";
import { ARTIFACT_ACK_SHA256 } from "../artifact-timestamp.mjs";
import {
  ARTIFACT_LABELS,
  artifactTrust,
  checkArtifactTrust,
  verifyArtifactRfc3161,
} from "../artifact-rfc3161.mjs";
import {
  artifactQueryBinding,
  generateArtifactQuery,
} from "../artifact-query.mjs";
import {
  SIGNING_CONFIGURATION_SHA256,
  SIGNING_CONFIGURATION_FILE_SHA256,
} from "../synthetic-signing.mjs";
globalThis.fetch = async () => {
  throw Error("TEST_NETWORK_FORBIDDEN");
};
const clone = (v) => JSON.parse(JSON.stringify(v)),
  run = promisify(execFile),
  repo = fileURLToPath(new URL("../../../", import.meta.url));
let source, issuer, key, config, capture, ackBytes, Engine;
async function removeDisposable(path, prefix) {
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  assert(basename(path).startsWith(prefix));
  await rm(path, { recursive: true, force: true });
}
before(async () => {
  issuer = await authority({ policyOid: "1.2.3.4.1" });
  source = await mkdtemp(join(tmpdir(), "darkpool-artifact-source-"));
  const pair = generateKeyPairSync("ed25519"),
    password = Buffer.alloc(32, 9);
  key = {
    version: 1,
    mode: candidate.mode,
    public_spki: pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    encrypted_pkcs8: pair.privateKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: password,
    }),
    protected_password: Buffer.from("SYNTHETIC_FIXTURE_ONLY").toString(
      "base64",
    ),
  };
  config = clone(candidate);
  config.openssl = executable;
  config.trust.witness_spki = key.public_spki;
  const fixtureHash = sha256(Buffer.from(canonical(config)));
  const exporter = await readFile(
    join(repo, "scripts/dev/export-commitment-witness.ps1"),
    "utf8",
  );
  const files = [...exporter.matchAll(/'((?:tools|services)\/[^']+)'/g)]
    .map((m) => m[1])
    .filter((f) => /\.(mjs|json|ps1)$/.test(f));
  for (const name of files) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await copyFile(join(repo, name), join(source, name));
  }
  // Only public fixture pins are replaced in isolated copies. No operational
  // override or fixture/private key is shipped in the source-only package.
  const signingPath = join(
    source,
    "tools/commitment-witness/synthetic-signing.mjs",
  );
  const signing = await readFile(signingPath, "utf8");
  await writeFile(
    signingPath,
    signing
      .replace(SIGNING_CONFIGURATION_SHA256, fixtureHash)
      .replace(SIGNING_CONFIGURATION_FILE_SHA256, fixtureHash),
  );
  await writeFile(
    join(
      source,
      "tools/commitment-witness/synthetic/witness-config.proposed.json",
    ),
    canonical(config),
  );
  const core = await import(
    pathToFileURL(join(source, "tools/commitment-witness/core.mjs")).href
  );
  const synthetic = await import(pathToFileURL(signingPath).href);
  const request = {
    commit: "90e83e50bcc9bdf54f1f2963d988be18a94262e4",
    content_sha256: syntheticPlan().content_sha256,
    envelope: clone(syntheticPlan().envelope),
  };
  const witness = sha256(Buffer.from(key.public_spki, "base64"));
  capture = {
    version: 1,
    mode: config.mode,
    request,
    witness_id: witness,
    trust_sha256: fixtureHash,
    observed_at: "2026-10-21T12:31:00.000Z",
    archive_url: core.archiveUrl(config, witness, request),
    git_blob_sha1: gitBlobSha1(envelopeBytes(request.envelope)),
  };
  assert(
    Date.now() - Date.parse(capture.observed_at) > 900000,
    "Fixture must retain an expired publication window",
  );
  const ack = await synthetic.acknowledgeSynthetic(
    config,
    key,
    capture,
    syntheticRecord(),
    async () => Buffer.from(password),
    {
      fetch: async () => new Response(envelopeBytes(request.envelope)),
      beforeSign: async () => {},
    },
  );
  password.fill(0);
  ackBytes = Buffer.from(canonical(ack));
  const enginePath = join(
    source,
    "tools/commitment-witness/artifact-timestamp.mjs",
  );
  const engine = await readFile(enginePath, "utf8");
  assert.equal(engine.split(ARTIFACT_ACK_SHA256).length, 2);
  await writeFile(
    enginePath,
    engine.replace(ARTIFACT_ACK_SHA256, sha256(ackBytes)),
  );
  Engine = (await import(pathToFileURL(enginePath).href)).ArtifactTimestamp;
});
after(async () => {
  await issuer?.close();
  if (source) await removeDisposable(source, "darkpool-artifact-source-");
});
function tsaSidecar(trust = issuer.trust) {
  return {
    version: 1,
    scope: ARTIFACT_LABELS.scope,
    status: "ARTIFACT_ONLY_APPROVED",
    financial_authorization: "NOT_GRANTED",
    endpoint: "https://freetsa.org/tsr",
    tsa_policy_oid: "1.2.3.4.1",
    clock_skew_seconds: 120,
    ca_bundle: trust.ca_bundle,
    tsa_verification: clone(trust.tsa_verification),
  };
}
async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), "darkpool-artifact-test-"));
  try {
    const root = join(dir, "ZcashDarkPoolCommitmentWitness"),
      record = join(root, "archive", syntheticRecord());
    await mkdir(record, { recursive: true });
    await mkdir(join(root, "keys"));
    const configFile = join(dir, "approved.json"),
      trustFile = join(dir, "artifact-trust.json");
    await writeFile(configFile, canonical(config));
    await writeFile(join(root, "keys/witness-key.json"), canonical(key));
    await writeFile(join(record, "capture.json"), canonical(capture));
    await writeFile(
      join(record, "envelope.json"),
      envelopeBytes(capture.request.envelope),
    );
    await writeFile(
      join(record, "context.json"),
      canonical({
        mode: config.mode,
        third_party_independence: "NO",
        repository_id: config.destination.repository_id,
        branch: config.destination.branch,
        witness_id: capture.witness_id,
        financial_authorization: "NOT_AUTHORIZED",
      }),
    );
    await writeFile(join(record, "acknowledgement.json"), ackBytes);
    const oldMarker = join(
      root,
      "synthetic-sign-" + syntheticRecord() + ".attempt.json",
    );
    await writeFile(
      oldMarker,
      canonical({
        scope: "SYNTHETIC_TEST_ONLY",
        financial_authorization: "NOT_GRANTED",
      }),
    );
    const clockA = join(root, "clock-A-original"),
      clockB = join(root, "clock-B-original");
    for (const [device, path] of [
      ["COMPUTER_A", clockA],
      ["COMPUTER_B", clockB],
    ])
      await captureClock(device, path, {
        measure: async () => ({
          stdout: "-03.428s\n-03.420s\n-03.422s\n",
          stderr: "",
        }),
      });
    let trust = tsaSidecar(),
      posts = 0;
    await writeFile(trustFile, canonical(trust));
    const f = {
      dir,
      root,
      record,
      configFile,
      trustFile,
      clockA,
      clockB,
      oldMarker,
      mode: "ok",
      posts: () => posts,
    };
    const engine = new Engine(root, configFile, {
      trustFile,
      trustHash: sha256(Buffer.from(canonical(trust))),
      clockA,
      clockB,
      fetch: async (url, options) => {
        assert.equal(url, "https://freetsa.org/tsr");
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(
          options.headers["Content-Type"],
          "application/timestamp-query",
        );
        assert(
          !Buffer.from(options.body).includes(Buffer.from("statement")),
          "Only a digest-bearing TSQ leaves the utility",
        );
        posts++;
        if (f.mode === "timeout") throw Error("MOCK_AMBIGUOUS_TIMEOUT");
        const b =
          f.mode === "bad"
            ? Buffer.from("MOCK_INVALID_TSR")
            : await issuer.timestampQuery(Buffer.from(options.body));
        return new Response(b, {
          headers: { "Content-Type": "application/timestamp-reply" },
        });
      },
    });
    f.engine = engine;
    f.retrust = async (next) => {
      trust = next;
      await writeFile(trustFile, canonical(trust));
      engine.trustHash = sha256(Buffer.from(canonical(trust)));
    };
    f.trust = () => clone(trust);
    f.clocks = async () =>
      Promise.all(
        [clockA, clockB].map(async (p) =>
          JSON.parse(await readFile(join(p, "clock-check.json"), "utf8")),
        ),
      );
    const originals = [
      configFile,
      join(root, "keys/witness-key.json"),
      ...(await files(record)),
      ...(await files(clockA)),
      ...(await files(clockB)),
      oldMarker,
    ];
    const before = await Promise.all(
      originals.map(async (p) => [
        p,
        sha256(await readFile(p)),
        (await stat(p)).mtimeMs,
      ]),
    );
    f.preserved = async () => {
      const got = await Promise.all(
        originals.map(async (p) => [
          p,
          sha256(await readFile(p)),
          (await stat(p)).mtimeMs,
        ]),
      );
      // Explicit adversarial edits are TEST setup, not utility writes.
      assert.deepEqual(
        f.externalMutation ? got.map((r) => r.slice(0, 2)) : got,
        f.externalMutation ? before.map((r) => r.slice(0, 2)) : before,
      );
    };
    await work(f);
    await f.preserved();
    assert.equal(config.trust.status, "UNAVAILABLE");
  } finally {
    await removeDisposable(dir, "darkpool-artifact-test-");
  }
}
async function files(path) {
  const out = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out.sort();
}
const approval = "SUBMIT_SYNTHETIC_ARTIFACT_TSA_ONCE";
async function full(f) {
  await f.engine.prepare();
  await f.engine.submit(approval);
  return f.engine.verify();
}
test("operational acknowledgement hash is fixed, with no runtime override", () => {
  assert.equal(
    ARTIFACT_ACK_SHA256,
    "cdcd869f517a516761607abe6000d72a54b406ca9915741a94bad84a70526c0a",
  );
});
test("read-only check needs no trust, clock renewal, network or writes", () =>
  fixture(async (f) => {
    const before = await files(f.root);
    f.engine.trustFile = undefined;
    f.engine.clockA = undefined;
    const result = await f.engine.check();
    assert.equal(result.status, "PASS");
    assert.equal(result.assertion, "ARTIFACT_EXISTENCE_ONLY");
    assert.deepEqual(await files(f.root), before);
    assert.equal(f.posts(), 0);
  }));
test("expired original observation accepts only artifact existence; production 900-second rule still rejects", () =>
  fixture(async (f) => {
    const result = await full(f);
    assert.equal(result.status, "ARTIFACT_EXISTENCE_VERIFIED");
    assert.equal(result.publication, "NOT_TIMELY_PUBLICATION");
    assert.equal(result.authorization, "NOT_FINANCIALLY_AUTHORIZED");
    assert.equal(result.control, "COMMON_HUMAN_CONTROL");
    const q = await readFile(join(f.engine.directory, "request.tsq")),
      r = await readFile(join(f.engine.directory, "response.tsr"));
    await assert.rejects(
      verifyRfc3161({
        query: q,
        reply: r,
        data: ackBytes,
        ca_bundle: f.trust().ca_bundle,
        policy: f.trust().tsa_verification,
        policy_oid: "1.2.3.4.1",
        executable,
        observed_at: capture.observed_at,
        locked_at: capture.request.envelope.locked_at,
        witness_lag_seconds: 900,
        clock_checks: await f.clocks(),
      }),
    );
    assert.throws(() => trustProfile(f.trust()));
    assert.equal(f.posts(), 1);
    await f.preserved();
  }));
test("prepare retry preserves exact query, nonce, bindings and mtime", () =>
  fixture(async (f) => {
    const a = await f.engine.prepare(),
      p = join(f.engine.directory, "request.tsq"),
      b = await readFile(p),
      m = (await stat(p)).mtimeMs;
    const retry = await f.engine.prepare();
    assert.equal(a.nonce_hex, retry.nonce_hex);
    assert.deepEqual(await readFile(p), b);
    assert.equal((await stat(p)).mtimeMs, m);
    assert.equal(f.posts(), 0);
  }));
test("missing approval cannot create a submission marker or POST", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    await assert.rejects(f.engine.submit());
    await assert.rejects(f.engine.submit(true));
    await assert.rejects(
      readFile(join(f.engine.directory, "submission-attempt.json")),
      { code: "ENOENT" },
    );
    assert.equal(f.posts(), 0);
  }));
test("ambiguous submission cannot be retried or assigned a new nonce", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const q = await readFile(join(f.engine.directory, "request.tsq"));
    f.mode = "timeout";
    await assert.rejects(f.engine.submit(approval));
    const marker = await readFile(
      join(f.engine.directory, "submission-attempt.json"),
    );
    f.mode = "ok";
    await assert.rejects(f.engine.submit(approval), /RECONCILIATION_REQUIRED/);
    await f.engine.prepare();
    assert.deepEqual(
      await readFile(join(f.engine.directory, "request.tsq")),
      q,
    );
    assert.deepEqual(
      await readFile(join(f.engine.directory, "submission-attempt.json")),
      marker,
    );
    assert.equal(f.posts(), 1);
  }));
test("completed submission replay refuses another POST; verification replay is create-only", () =>
  fixture(async (f) => {
    await full(f);
    const path = join(f.engine.directory, "artifact-evidence.json"),
      b = await readFile(path),
      m = (await stat(path)).mtimeMs;
    await assert.rejects(f.engine.submit(approval), /RECONCILIATION_REQUIRED/);
    await f.engine.verify();
    assert.deepEqual(await readFile(path), b);
    assert.equal((await stat(path)).mtimeMs, m);
    assert.equal(f.posts(), 1);
  }));
test("concurrent preparation creates only one request and rejects the competing lock", () =>
  fixture(async (f) => {
    const r = await Promise.allSettled([
      f.engine.prepare(),
      f.engine.prepare(),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(f.posts(), 0);
  }));
test("concurrent submissions create exactly one POST", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const r = await Promise.allSettled([
      f.engine.submit(approval),
      f.engine.submit(approval),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(f.posts(), 1);
  }));
test("crash marker before POST quarantines the same request", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const path = join(f.engine.directory, "submission-attempt.json");
    await writeFile(path, "SYNTHETIC_CRASH", { flag: "wx" });
    await assert.rejects(f.engine.submit(approval), /RECONCILIATION_REQUIRED/);
    assert.equal(await readFile(path, "utf8"), "SYNTHETIC_CRASH");
    assert.equal(f.posts(), 0);
  }));
for (const label of ["partial query", "missing plan", "partial plan"])
  test(label + " is preserved without regenerating a nonce", () =>
    fixture(async (f) => {
      await f.engine.prepare();
      const q = join(f.engine.directory, "request.tsq"),
        plan = join(f.engine.directory, "preparation.json");
      if (label === "partial query") await writeFile(q, "partial");
      else if (label === "missing plan") await rm(plan);
      else await writeFile(plan, "{");
      const before = await files(f.engine.directory),
        hashes = await Promise.all(
          before.map(async (p) => sha256(await readFile(p))),
        );
      await assert.rejects(f.engine.prepare());
      await assert.rejects(f.engine.submit(approval));
      assert.deepEqual(await files(f.engine.directory), before);
      assert.deepEqual(
        await Promise.all(before.map(async (p) => sha256(await readFile(p)))),
        hashes,
      );
      assert.equal(f.posts(), 0);
    }),
  );
test("changed query nonce cannot substitute for the persisted binding", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const other = await generateArtifactQuery(
      executable,
      join(f.engine.directory, "acknowledgement.bin"),
    );
    await writeFile(join(f.engine.directory, "request.tsq"), other);
    await assert.rejects(f.engine.submit(approval));
    assert.equal(f.posts(), 0);
  }));
test("altered signed acknowledgement rejects before preparation", () =>
  fixture(async (f) => {
    f.externalMutation = true;
    const path = join(f.record, "acknowledgement.json"),
      original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
      await assert.rejects(f.engine.check());
      await assert.rejects(f.engine.prepare());
      assert.equal(f.posts(), 0);
    } finally {
      await writeFile(path, original);
    }
  }));
test("altered capture observation cannot renew the expired window", () =>
  fixture(async (f) => {
    f.externalMutation = true;
    const path = join(f.record, "capture.json"),
      original = await readFile(path);
    try {
      const c = JSON.parse(original);
      c.observed_at = new Date().toISOString();
      await writeFile(path, canonical(c));
      await assert.rejects(f.engine.check());
    } finally {
      await writeFile(path, original);
    }
  }));
test("partial or forged response is retained but never becomes evidence", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    f.mode = "bad";
    await f.engine.submit(approval);
    const path = join(f.engine.directory, "response.tsr"),
      b = await readFile(path);
    await assert.rejects(f.engine.verify());
    assert.deepEqual(await readFile(path), b);
    await assert.rejects(
      readFile(join(f.engine.directory, "artifact-evidence.json")),
      { code: "ENOENT" },
    );
    assert.equal(f.posts(), 1);
  }));
test("partial evidence file is never overwritten", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    await f.engine.submit(approval);
    const path = join(f.engine.directory, "artifact-evidence.json");
    await writeFile(path, "{", { flag: "wx" });
    await assert.rejects(f.engine.verify());
    assert.equal(await readFile(path, "utf8"), "{");
  }));
test("missing, stale and same-device clock reports stop before POST", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const originalA = f.engine.clockA;
    f.engine.clockA = f.engine.clockB;
    await assert.rejects(f.engine.submit(approval));
    f.engine.clockA = join(f.root, "missing-clock");
    await assert.rejects(f.engine.submit(approval));
    f.engine.clockA = originalA;
    f.engine.now = () => Date.now() + 301000;
    await assert.rejects(f.engine.submit(approval));
    assert.equal(f.posts(), 0);
  }));
test("unavailable trust and wrong sidecar hash do not create request artifacts", () =>
  fixture(async (f) => {
    const t = f.trust();
    t.status = "UNAVAILABLE";
    await f.retrust(t);
    await assert.rejects(f.engine.prepare());
    t.status = "ARTIFACT_ONLY_APPROVED";
    await f.retrust(t);
    f.engine.trustHash = "00".repeat(32);
    await assert.rejects(f.engine.prepare());
    await assert.rejects(readFile(join(f.engine.directory, "request.tsq")), {
      code: "ENOENT",
    });
    assert.equal(f.posts(), 0);
  }));
for (const [label, change] of [
  [
    "policy alias",
    (t) => {
      t.tsa_policy_oid = "tsa_policy1";
    },
  ],
  [
    "wrong policy OID",
    (t) => {
      t.tsa_policy_oid = "1.2.3.4.2";
    },
  ],
  [
    "alternate endpoint",
    (t) => {
      t.endpoint = "https://other.invalid/tsr";
    },
  ],
  [
    "signer certificate pin",
    (t) => {
      t.tsa_verification.signer_certificate_sha256 = "00".repeat(32);
    },
  ],
  [
    "signer SPKI pin",
    (t) => {
      t.tsa_verification.signer_spki_sha256 = "00".repeat(32);
    },
  ],
  [
    "root pin",
    (t) => {
      t.tsa_verification.anchor_certificate_sha256 = ["00".repeat(32)];
    },
  ],
  [
    "missing CRL",
    (t) => {
      t.ca_bundle = t.ca_bundle.replace(
        /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/,
        "",
      );
    },
  ],
  [
    "stale CRL fetch",
    (t) => {
      t.tsa_verification.crl_fetch_records[0].retrieved_at =
        "2000-01-01T00:00:00Z";
    },
  ],
])
  test("artifact trust rejects " + label + " before POST", () =>
    fixture(async (f) => {
      const t = f.trust();
      change(t);
      await f.retrust(t);
      await assert.rejects(f.engine.prepare());
      assert.equal(f.posts(), 0);
    }),
  );
test("revoked signer is rejected by independent chain/CRL preflight", () =>
  fixture(async (f) => {
    const revoked = await authority({ policyOid: "1.2.3.4.1" });
    try {
      await f.retrust(tsaSidecar(await revoked.revoke()));
      await assert.rejects(f.engine.prepare());
      assert.equal(f.posts(), 0);
    } finally {
      await revoked.close();
    }
  }));
test("wrong nonce, changed imprint and altered token fail cryptographic verification", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    await f.engine.submit(approval);
    const q = await readFile(join(f.engine.directory, "request.tsq")),
      reply = await readFile(join(f.engine.directory, "response.tsr"));
    const input = {
      query: q,
      reply,
      data: ackBytes,
      trust: f.trust(),
      executable,
      clock_checks: await f.clocks(),
    };
    const other = await generateArtifactQuery(
      executable,
      join(f.engine.directory, "acknowledgement.bin"),
    );
    await assert.rejects(verifyArtifactRfc3161({ ...input, query: other }));
    await assert.rejects(
      verifyArtifactRfc3161({
        ...input,
        data: Buffer.from("OTHER_SYNTHETIC_BYTES"),
      }),
    );
    const corrupt = Buffer.from(reply);
    corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(verifyArtifactRfc3161({ ...input, reply: corrupt }));
  }));
test("expired certificate and expired CRL fail with synthetic verification clocks", () =>
  fixture(async (f) => {
    const later = Date.now() + 8 * 86400000,
      records = (await f.clocks()).map((c) => ({
        ...c,
        checked_at: new Date(later).toISOString(),
      }));
    await assert.rejects(
      checkArtifactTrust(f.trust(), executable, records, later),
    );
    const short = await issuer.refreshCrl(1),
      t = tsaSidecar(short),
      twoHours = Date.now() + 7200000;
    t.tsa_verification.min_crl_remaining_seconds = 0;
    t.tsa_verification.crl_fetch_records[0].retrieved_at = new Date(
      twoHours,
    ).toISOString();
    await assert.rejects(
      checkArtifactTrust(
        t,
        executable,
        (await f.clocks()).map((c) => ({
          ...c,
          checked_at: new Date(twoHours).toISOString(),
        })),
        twoHours,
      ),
    );
  }));
test("artifact evidence cannot be accepted by production receipt verification", () =>
  fixture(async (f) => {
    await full(f);
    const evidence = JSON.parse(
      await readFile(
        join(f.engine.directory, "artifact-evidence.json"),
        "utf8",
      ),
    );
    let retrievals = 0;
    await assert.rejects(
      verifyPublication(
        capture.request.envelope,
        evidence,
        issuer.trust,
        executable,
        async () => {
          retrievals++;
          throw Error("MUST_NOT_RETRIEVE");
        },
      ),
    );
    assert.equal(retrievals, 0);
  }));
test("interruption before query retention leaves the generation marker and never regenerates", () =>
  fixture(async (f) => {
    await mkdir(f.engine.directory, { recursive: true });
    const marker = join(f.engine.directory, "request-generation-attempt.json");
    await writeFile(marker, "SYNTHETIC_CRASH_AFTER_GENERATION_STARTED", {
      flag: "wx",
    });
    await assert.rejects(f.engine.prepare());
    assert.equal(
      await readFile(marker, "utf8"),
      "SYNTHETIC_CRASH_AFTER_GENERATION_STARTED",
    );
    await assert.rejects(readFile(join(f.engine.directory, "request.tsq")), {
      code: "ENOENT",
    });
    assert.equal(f.posts(), 0);
  }));
test("interruption retaining a response cannot overwrite partial bytes or resubmit", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const fetch = f.engine.fetch,
      response = join(f.engine.directory, "response.tsr");
    f.engine.fetch = async (...args) => {
      const got = await fetch(...args);
      await writeFile(response, "PARTIAL_TSR", { flag: "wx" });
      return got;
    };
    await assert.rejects(f.engine.submit(approval));
    await assert.rejects(f.engine.submit(approval));
    await assert.rejects(f.engine.verify());
    assert.equal(await readFile(response, "utf8"), "PARTIAL_TSR");
    assert.equal(f.posts(), 1);
  }));
for (const name of ["operation.lock", "artifact-timestamp.lock"])
  test("an existing " + name + " is preserved and blocks mutation", () =>
    fixture(async (f) => {
      const path = join(f.root, name);
      await writeFile(path, "SYNTHETIC_EXISTING_LOCK", { flag: "wx" });
      await assert.rejects(f.engine.prepare());
      assert.equal(await readFile(path, "utf8"), "SYNTHETIC_EXISTING_LOCK");
      assert.equal(f.posts(), 0);
    }),
  );
test("a changed sidecar after preparation cannot silently replace frozen trust", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const t = f.trust();
    t.tsa_verification.max_crl_fetch_age_seconds--;
    await f.retrust(t);
    await assert.rejects(f.engine.submit(approval));
    assert.equal(f.posts(), 0);
  }));
test("a modified CRL signature fails even with a matching CRL digest", () =>
  fixture(async (f) => {
    const t = f.trust(),
      match = /-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/.exec(
        t.ca_bundle,
      );
    const der = Buffer.from(match[1].replace(/\s/g, ""), "base64");
    der[der.length - 1] ^= 1;
    t.tsa_verification.crl_fetch_records[0].sha256 = sha256(der);
    t.ca_bundle = t.ca_bundle.replace(
      match[0],
      "-----BEGIN X509 CRL-----\n" +
        der
          .toString("base64")
          .match(/.{1,64}/g)
          .join("\n") +
        "\n-----END X509 CRL-----",
    );
    await f.retrust(t);
    await assert.rejects(f.engine.prepare());
    assert.equal(f.posts(), 0);
  }));
test("an alternate TSA token cannot replace the pinned signer/root", () =>
  fixture(async (f) => {
    await f.engine.prepare();
    const other = await authority({ policyOid: "1.2.3.4.1" });
    try {
      const q = await readFile(join(f.engine.directory, "request.tsq")),
        reply = await other.timestampQuery(q);
      await assert.rejects(
        verifyArtifactRfc3161({
          query: q,
          reply,
          data: ackBytes,
          trust: f.trust(),
          executable,
          clock_checks: await f.clocks(),
        }),
      );
    } finally {
      await other.close();
    }
  }));
test("CLI check is read-only, scoped and cannot dispatch signing or publication", () =>
  fixture(async (f) => {
    const script = join(source, "tools/commitment-witness/artifact-cli.mjs");
    const result = await run(
      process.execPath,
      [
        script,
        "check",
        f.configFile,
        "-",
        "-",
        "-",
        "-",
        "NO_SUBMISSION_APPROVAL",
      ],
      {
        env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: f.dir },
        windowsHide: true,
      },
    );
    const r = JSON.parse(result.stdout);
    assert.equal(r.stage, "READ_ONLY_ARTIFACT_INPUTS");
    assert.equal(r.financial_authorization, "NOT_GRANTED");
    await assert.rejects(
      run(
        process.execPath,
        [
          script,
          "sign",
          f.configFile,
          "-",
          "-",
          "-",
          "-",
          "NO_SUBMISSION_APPROVAL",
        ],
        {
          env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: f.dir },
          windowsHide: true,
        },
      ),
    );
    assert.equal(f.posts(), 0);
  }));

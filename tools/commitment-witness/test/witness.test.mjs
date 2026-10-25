import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  unlink,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import {
  authority,
  envelope,
  executable,
} from "../../../services/publication/test/fixtures.mjs";
import { githubFixture } from "../../../services/publication/test/github-fixtures.mjs";
import {
  canonical,
  envelopeBytes,
  sha256,
} from "../../../services/publication/profile.mjs";
import {
  MODE,
  settings,
  newKey,
  identity,
  observe,
  captureValid,
  submitTimestamp,
  checkBundle,
} from "../core.mjs";
import { WitnessStore, EXPORTS } from "../store.mjs";
import { captureClock, operationalEvidence } from "../operational.mjs";
globalThis.fetch = async () => {
  throw new Error("TEST_NETWORK_DISABLED");
};
let tsa;
before(async () => {
  tsa = await authority();
});
after(async () => {
  await tsa?.close();
});
const protect = async (bytes) =>
  Buffer.concat([Buffer.from("SYNTHETIC_DPAPI_MOCK:"), bytes]);
const unprotect = async (bytes) => {
  if (!bytes.subarray(0, 21).equals(Buffer.from("SYNTHETIC_DPAPI_MOCK:")))
    throw new Error("mock user mismatch");
  return bytes.subarray(21);
};
async function fixture(work, { external = false, clock = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "darkpool-witness-unit-"));
  try {
    for (const name of ["keys", "archive", "exports"])
      await mkdir(join(root, name));
    const ledger = envelope(),
      model = githubFixture(ledger);
    model.install();
    model.state.archive = null;
    const config = {
      version: 1,
      mode: MODE,
      destination: model.c,
      archive_origin: tsa.trust.archive_origin,
      archive_base_path: "witness",
      openssl: executable,
      trust: {
        ...tsa.trust,
        policy_ref: "common_control_synthetic_v1",
        evidence_class: external ? "EXTERNAL" : "SYNTHETIC_TEST",
      },
    };
    let posts = 0,
      failTsa = false,
      badTsa = false;
    const fetcher = async (url, options) => {
      if (url.endsWith("/branches/main"))
        return new Response(
          JSON.stringify({ name: "main", commit: { sha: model.state.head } }),
          { status: 200 },
        );
      if (url === "https://freetsa.org/tsr") {
        posts++;
        assert.equal(options.method, "POST");
        assert.equal(
          options.headers["Content-Type"],
          "application/timestamp-query",
        );
        if (failTsa) throw new Error("mock timeout");
        const bytes = badTsa
          ? Buffer.from("bad token")
          : await tsa.timestampQuery(Buffer.from(options.body));
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/timestamp-reply" },
        });
      }
      return model.fetch(url, options);
    };
    let operational;
    if (clock) {
      for (const device of ["COMPUTER_A", "COMPUTER_B"])
        await captureClock(device, join(root, device), {
          measure: async () => ({
            stdout: "+00.422s\n+00.405s\n+00.410s\n",
            stderr: "",
          }),
        });
      operational = operationalEvidence(
        join(root, "COMPUTER_A"),
        join(root, "COMPUTER_B"),
        join(root, "audit"),
      );
    }
    const store = new WitnessStore(root, config, {
      protect,
      unprotect,
      fetch: fetcher,
      operational,
    });
    await store.initKey();
    config.trust.witness_spki = (await store.publicIdentity()).witness_spki;
    const request = {
      commit: model.state.commit,
      content_sha256: sha256(envelopeBytes(ledger)),
      envelope: ledger,
    };
    await work({
      root,
      config,
      store,
      model,
      request,
      fetch: fetcher,
      posts: () => posts,
      failTsa: () => {
        failTsa = true;
      },
      badTsa: () => {
        badTsa = true;
      },
      mirror: () => {
        model.state.archive = model.state.bytes;
      },
    });
  } finally {
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + "/") &&
      !resolve(root).startsWith(resolve(tmpdir()) + "\\")
    )
      throw new Error("Unsafe cleanup");
    if (!basename(root).startsWith("darkpool-witness-unit-"))
      throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
}
async function prepared(f) {
  const r = await f.store.capture(f.request);
  f.mirror();
  await f.store.sign(r.record);
  await f.store.query(r.record);
  return r.record;
}
test("unavailable trust is not made READY; synthetic key is encrypted and identity stable", async () => {
  assert.throws(() =>
    settings({
      version: 1,
      mode: MODE,
      destination: {},
      archive_origin: "x",
      archive_base_path: "w",
      openssl: executable,
      trust: { status: "UNAVAILABLE" },
    }),
  );
  const key = await newKey(protect);
  assert.match(key.encrypted_pkcs8, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.equal(identity(key).length, 64);
  assert(!canonical(key).includes("BEGIN PRIVATE KEY"));
});
test("capture is public-only, commit/branch pinned, canonical and idempotent", () =>
  fixture(async (f) => {
    const a = await f.store.capture(f.request),
      b = await f.store.capture(f.request);
    assert.equal(a.record, b.record);
    assert.equal(b.retry, true);
    const capture = await f.store.json(
      join(f.store.record(a.record), "capture.json"),
    );
    assert.match(capture.archive_url, /\/common-control\//);
    assert(
      capture.archive_url.includes(
        f.config.destination.repository_id + "/main/",
      ),
    );
    assert(capture.archive_url.includes(capture.witness_id));
    assert.equal(capture.mode, MODE);
    assert.equal(f.posts(), 0);
  }));
test("conflicting ledger, extra private field, wrong digest and unexpected HEAD reject", () =>
  fixture(async (f) => {
    await assert.rejects(
      f.store.capture({ ...f.request, claim_secret: "synthetic" }),
    );
    await assert.rejects(
      f.store.capture({ ...f.request, content_sha256: "00".repeat(32) }),
    );
    f.model.state.head = "23".repeat(20);
    await assert.rejects(f.store.capture(f.request));
    f.model.state.head = f.request.commit;
    await f.store.capture(f.request);
    const envelope = { ...f.request.envelope, merkle_root: "cd".repeat(32) };
    await assert.rejects(
      f.store.capture({
        ...f.request,
        envelope,
        content_sha256: sha256(envelopeBytes(envelope)),
      }),
    );
  }));
test("wrong repository ID and malformed envelope reject before acknowledgement", () =>
  fixture(async (f) => {
    const key = await f.store.key();
    await assert.rejects(
      observe(
        {
          ...f.config,
          destination: { ...f.config.destination, repository_id: "456" },
        },
        key,
        f.request,
        { fetch: f.fetch },
      ),
    );
    await assert.rejects(
      observe(
        f.config,
        key,
        { ...f.request, envelope: { ...f.request.envelope, side: "YES" } },
        { fetch: f.fetch },
      ),
    );
  }));
test("public archive must actually exist and match before a synthetic acknowledgement", () =>
  fixture(async (f) => {
    const r = await f.store.capture(f.request);
    await assert.rejects(f.store.sign(r.record));
    f.model.state.archive = Buffer.from("wrong");
    await assert.rejects(f.store.sign(r.record));
    f.mirror();
    await f.store.sign(r.record);
    const file = join(f.store.record(r.record), "acknowledgement.json"),
      before = await readFile(file);
    await f.store.sign(r.record);
    assert((await readFile(file)).equals(before));
    const ack = JSON.parse(before);
    assert.equal(Object.keys(ack.statement).length, 12);
    assert.equal(f.posts(), 0);
  }));
test("original TSQ is retained on retry, changed retained query never causes submission", () =>
  fixture(async (f) => {
    const id = await prepared(f),
      path = join(f.store.record(id), "timestamp.tsq"),
      before = await readFile(path);
    await f.store.query(id);
    assert((await readFile(path)).equals(before));
    await writeFile(path, Buffer.from("changed"));
    await assert.rejects(f.store.timestamp(id, true));
    assert.equal(f.posts(), 0);
  }));
test("explicit submission gate, real local RFC3161 verification and exact compatible bundle", () =>
  fixture(async (f) => {
    const id = await prepared(f);
    await assert.rejects(f.store.timestamp(id));
    assert.equal(f.posts(), 0);
    const done = await f.store.timestamp(id, true);
    assert.equal(done.status, "BUNDLE_CRYPTOGRAPHICALLY_VERIFIED");
    assert.equal(done.financial_authorization, false);
    assert.equal(done.third_party_independence, false);
    assert.equal(f.posts(), 1);
    await f.store.timestamp(id, true);
    assert.equal(f.posts(), 1);
    const bundle = await f.store.json(
      join(f.store.record(id), "publication-evidence.json"),
    );
    assert.deepEqual(Object.keys(bundle).sort(), [
      "envelope",
      "signature",
      "statement",
      "tsq",
      "tsr",
    ]);
    const check = await checkBundle(
      f.config,
      { request: { envelope: f.request.envelope } },
      bundle,
      { fetch: f.fetch },
    );
    assert.equal(check.evidence_class, "SYNTHETIC_TEST");
  }));
test("ambiguous TSA submission is quarantined and cannot automatically POST again", () =>
  fixture(async (f) => {
    const id = await prepared(f);
    f.failTsa();
    await assert.rejects(f.store.timestamp(id, true));
    await assert.rejects(
      f.store.timestamp(id, true),
      /WITNESS_TSA_RECONCILIATION_REQUIRED/,
    );
    assert.equal(f.posts(), 1);
    assert.equal(
      await f.store.exists(
        join(f.store.record(id), "publication-evidence.json"),
      ),
      false,
    );
  }));
test("malformed TSR is retained but never classified verified or replaced", () =>
  fixture(async (f) => {
    const id = await prepared(f);
    f.badTsa();
    await assert.rejects(f.store.timestamp(id, true));
    await assert.rejects(f.store.timestamp(id, true));
    assert.equal(f.posts(), 1);
    assert.equal(
      await f.store.exists(join(f.store.record(id), "timestamp.tsr")),
      true,
    );
    assert.equal(
      await f.store.exists(
        join(f.store.record(id), "publication-evidence.json"),
      ),
      false,
    );
  }));
test("public export is allowlisted and excludes encrypted keys and DPAPI capsules", () =>
  fixture(async (f) => {
    const id = await prepared(f);
    await f.store.timestamp(id, true);
    await f.store.export(id);
    const out = join(f.root, "exports", id);
    assert.deepEqual((await readdir(out)).sort(), [...EXPORTS].sort());
    for (const name of EXPORTS) {
      const bytes = await readFile(join(out, name));
      assert(!bytes.includes(Buffer.from("ENCRYPTED PRIVATE KEY")));
      assert(!bytes.includes(Buffer.from("protected_password")));
    }
    await assert.rejects(f.store.export(id));
  }));
test("tampered acknowledgement, common-control context and key bindings fail closed", () =>
  fixture(async (f) => {
    const id = await prepared(f),
      p = f.store.record(id),
      key = await f.store.key(),
      capture = await f.store.json(join(p, "capture.json"));
    assert.throws(() =>
      captureValid(f.config, key, { ...capture, witness_id: "00".repeat(32) }),
    );
    assert.throws(() =>
      captureValid(f.config, key, {
        ...capture,
        git_blob_sha1: "00".repeat(20),
      }),
    );
    const ack = await f.store.json(join(p, "acknowledgement.json"));
    ack.statement.observed_at = "2000-01-01T00:00:00Z";
    await writeFile(join(p, "acknowledgement.json"), canonical(ack));
    await assert.rejects(f.store.timestamp(id, true));
    assert.equal(f.posts(), 0);
  }));
test("in-process concurrency uses a durable exclusive lock; crash marker requires review", () =>
  fixture(async (f) => {
    const results = await Promise.allSettled([
      f.store.capture(f.request),
      f.store.capture(f.request),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await writeFile(join(f.root, "operation.lock"), "synthetic crash marker");
    await assert.rejects(f.store.capture(f.request));
  }));
test("TSA transport rejects redirect, wrong type, excessive body and non-200", async () => {
  for (const response of [
    new Response(null, { status: 302 }),
    new Response("bad", { status: 500 }),
    new Response("bad", { headers: { "Content-Type": "text/html" } }),
    new Response(Buffer.alloc(262145), {
      headers: { "Content-Type": "application/timestamp-reply" },
    }),
  ])
    await assert.rejects(
      submitTimestamp(Buffer.from("synthetic"), {
        fetch: async () => response,
      }),
    );
});

test("partial capture refuses retry and signing instead of silently repairing", () =>
  fixture(async (f) => {
    const r = await f.store.capture(f.request);
    await unlink(join(f.store.record(r.record), "context.json"));
    await assert.rejects(f.store.capture(f.request));
    await assert.rejects(f.store.sign(r.record));
    assert.equal(f.posts(), 0);
  }));

test("external capture refuses absent clock/audit hooks before retrieval", () =>
  fixture(
    async (f) => {
      let gets = 0;
      f.store.fetch = async () => {
        gets++;
        throw new Error("no network permitted");
      };
      await assert.rejects(f.store.capture(f.request));
      assert.equal(gets, 0);
      assert.equal(f.posts(), 0);
    },
    { external: true },
  ));

test("external-shaped mock workflow durably audits capture, sign, query and verification", () =>
  fixture(
    async (f) => {
      const id = await prepared(f);
      await f.store.timestamp(id, true);
      await f.store.verify(id);
      await f.store.export(id);
      assert.equal(f.posts(), 1);
      const audit = await readdir(join(f.root, "audit"));
      const events = await Promise.all(
        audit.map(async (n) =>
          JSON.parse(await readFile(join(f.root, "audit", n), "utf8")),
        ),
      );
      for (const action of [
        "CAPTURE",
        "SIGN",
        "QUERY",
        "TIMESTAMP",
        "VERIFY",
        "EXPORT",
        "CRYPTOGRAPHIC_VERIFICATION",
      ])
        assert(events.some((e) => e.action === action));
      for (const event of events)
        assert.equal(event.financial_authorization, "NOT_GRANTED");
      assert(!JSON.stringify(events).includes("protected_password"));
    },
    { external: true, clock: true },
  ));

test("missing A clock fails before the first TSA POST; existing query stays unchanged", () =>
  fixture(
    async (f) => {
      const id = await prepared(f),
        path = join(f.store.record(id), "timestamp.tsq"),
        before = await readFile(path);
      await unlink(join(f.root, "COMPUTER_A", "clock-check.json"));
      await assert.rejects(f.store.timestamp(id, true));
      assert.equal(f.posts(), 0);
      assert((await readFile(path)).equals(before));
    },
    { external: true, clock: true },
  ));

test("audit failure before signing prevents acknowledgement and key unprotection", () =>
  fixture(
    async (f) => {
      const id = (await f.store.capture(f.request)).record;
      f.mirror();
      f.store.operational.before = async () => {
        throw new Error("synthetic fsync failure");
      };
      let decrypts = 0;
      f.store.unprotect = async () => {
        decrypts++;
        throw new Error("must not decrypt");
      };
      await assert.rejects(f.store.sign(id));
      assert.equal(decrypts, 0);
      assert.equal(
        await f.store.exists(join(f.store.record(id), "acknowledgement.json")),
        false,
      );
    },
    { external: true, clock: true },
  ));

test("expired witness-lag budget refuses submission before any TSA POST", () =>
  fixture(
    async (f) => {
      f.config.trust.max_witness_lag_seconds = 0;
      const id = await prepared(f);
      await assert.rejects(f.store.timestamp(id, true));
      assert.equal(f.posts(), 0);
      assert.equal(
        await f.store.exists(
          join(f.store.record(id), "timestamp-attempt.json"),
        ),
        false,
      );
    },
    { external: true, clock: true },
  ));

test("failed verification audit retains the original TSR, blocks bundle, and never reposts", () =>
  fixture(
    async (f) => {
      const id = await prepared(f),
        original = f.store.operational.verification;
      f.store.operational.verification = async () => ({
        ...(await original()),
        recordClockAudit: async () => {
          throw new Error("synthetic audit disk failure");
        },
      });
      await assert.rejects(f.store.timestamp(id, true));
      assert.equal(f.posts(), 1);
      const file = join(f.store.record(id), "timestamp.tsr"),
        before = await readFile(file);
      assert.equal(
        await f.store.exists(
          join(f.store.record(id), "publication-evidence.json"),
        ),
        false,
      );
      f.store.operational.verification = original;
      await f.store.timestamp(id, true);
      assert.equal(f.posts(), 1);
      assert((await readFile(file)).equals(before));
    },
    { external: true, clock: true },
  ));

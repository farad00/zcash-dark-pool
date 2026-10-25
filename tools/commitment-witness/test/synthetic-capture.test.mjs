import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import candidate from "../synthetic/witness-config.proposed.json" with { type: "json" };
import {
  settings,
  captureSettings,
  captureOnlyValid,
  captureValid,
  checkBundle,
} from "../core.mjs";
import { WitnessStore } from "../store.mjs";
import { captureClock, operationalEvidence } from "../operational.mjs";
import { syntheticPlan } from "../synthetic.mjs";
import {
  canonical,
  envelopeBytes,
  sha256,
  trustProfile,
} from "../../../services/publication/profile.mjs";
import { createPublicRetrieval } from "../../../services/publication/github-receipt.mjs";
import { mockGitHub, commit } from "./capture-fixture.mjs";

globalThis.fetch = async () => {
  throw Error("TEST_NETWORK_FORBIDDEN");
};
const run = promisify(execFile),
  clone = (v) => JSON.parse(JSON.stringify(v));
const request = () => ({
  commit,
  content_sha256: syntheticPlan().content_sha256,
  envelope: clone(syntheticPlan().envelope),
});
const stubKey = () => ({
  version: 1,
  mode: candidate.mode,
  public_spki: candidate.trust.witness_spki,
  encrypted_pkcs8:
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nSYNTHETIC_PUBLIC_IDENTITY_STUB_NOT_A_KEY",
  protected_password: Buffer.from("SYNTHETIC_NOT_A_SECRET").toString("base64"),
});
const measure = async () => ({
  stdout: "+00.422s\n+00.405s\n+00.410s\n",
  stderr: "",
});
const win = process.platform === "win32";
const script = (name) => fileURLToPath(new URL("../" + name, import.meta.url));
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
async function fixture(
  work,
  { windowsStorage = false, clock = true, alter = {} } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "darkpool-capture-only-"));
  try {
    const root = join(dir, "ZcashDarkPoolCommitmentWitness");
    if (windowsStorage)
      await run(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script("storage.ps1"),
          "-Action",
          "init",
        ],
        {
          env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: dir },
          windowsHide: true,
        },
      );
    else {
      await mkdir(root);
      for (const name of ["keys", "archive", "exports"])
        await mkdir(join(root, name));
    }
    const config = clone(candidate),
      req = request(),
      keyFile = join(root, "keys/witness-key.json");
    await writeFile(keyFile, canonical(stubKey()), { flag: "wx" });
    const keyHash = sha256(await readFile(keyFile));
    const clockDir = join(root, "clock-B");
    if (clock) await captureClock("COMPUTER_B", clockDir, { measure });
    const requests = [],
      fetcher = mockGitHub({ requests, alter });
    let unprotectCalls = 0;
    const store = new WitnessStore(root, config, {
      fetch: fetcher,
      unprotect: async () => {
        unprotectCalls++;
        throw Error("TEST_DECRYPT_FORBIDDEN");
      },
      operational: operationalEvidence(
        join(dir, "absent-A"),
        clockDir,
        join(root, "audit"),
      ),
    });
    await work({
      dir,
      root,
      config,
      req,
      store,
      requests,
      fetch: fetcher,
      clockDir,
      unprotectCalls: () => unprotectCalls,
    });
    assert.equal(sha256(await readFile(keyFile)), keyHash);
    assert.equal(config.trust.status, "UNAVAILABLE");
    assert.equal(unprotectCalls, 0);
  } finally {
    const prefix = resolve(tmpdir()) + (win ? "\\" : "/");
    if (
      !resolve(dir).startsWith(prefix) ||
      !basename(dir).startsWith("darkpool-capture-only-")
    )
      throw Error("UNSAFE_TEST_CLEANUP");
    await rm(dir, { recursive: true, force: true });
  }
}
test("original failure remains reproducible through strict receipt settings", () => {
  assert.throws(() => settings(clone(candidate)), /PUBLICATION_UNAVAILABLE/);
  assert.throws(
    () => trustProfile(clone(candidate.trust)),
    /PUBLICATION_UNAVAILABLE/,
  );
  assert.deepEqual(captureSettings(clone(candidate), request()), candidate);
});
test("unavailable synthetic capture retains exact public record, clock audit, identity and key", () =>
  fixture(async (f) => {
    const a = await f.store.capture(f.req),
      b = await f.store.capture(f.req);
    assert.equal(a.record, b.record);
    assert.equal(b.retry, true);
    assert.equal(a.financial_authorization, false);
    const loaded = await f.store.loadCapture(a.record);
    captureOnlyValid(f.config, stubKey(), loaded.capture);
    assert.throws(
      () => captureValid(f.config, stubKey(), loaded.capture),
      /PUBLICATION_UNAVAILABLE/,
    );
    assert.deepEqual(
      await readFile(join(loaded.path, "envelope.json")),
      envelopeBytes(f.req.envelope),
    );
    assert.deepEqual((await readdir(loaded.path)).sort(), [
      "capture.json",
      "context.json",
      "envelope.json",
    ]);
    const audits = await readdir(join(f.root, "audit"));
    assert(audits.length >= 1);
    const event = JSON.parse(
      await readFile(join(f.root, "audit", audits[0]), "utf8"),
    );
    assert.equal(event.action, "CAPTURE");
    assert.equal(event.clock.device, "COMPUTER_B");
    assert.equal(event.financial_authorization, "NOT_GRANTED");
    assert(f.requests.every((u) => u.startsWith("https://api.github.com/")));
  }));
for (const [name, change] of [
  [
    "real destination",
    (c) => {
      c.destination.path = "testnet/ledger-v1.json";
      c.trust.path = c.destination.path;
    },
  ],
  [
    "wrong repository ID",
    (c) => {
      c.destination.repository_id = "1";
    },
  ],
  [
    "wrong repository",
    (c) => {
      c.destination.repository = "https://github.com/other/repository";
    },
  ],
  [
    "wrong branch",
    (c) => {
      c.destination.branch = "other";
    },
  ],
  [
    "unapproved synthetic path",
    (c) => {
      c.destination.path = "testnet/synthetic/other.json";
    },
  ],
  [
    "wrong policy",
    (c) => {
      c.trust.policy_ref = "common_control_other";
    },
  ],
  [
    "wrong witness",
    (c) => {
      c.trust.witness_spki =
        "MCowBQYDK2VwAyEA" + Buffer.alloc(32).toString("base64");
    },
  ],
  [
    "wrong archive origin",
    (c) => {
      c.archive_origin = "https://other.invalid";
    },
  ],
  [
    "wrong archive base",
    (c) => {
      c.archive_base_path = "other";
    },
  ],
  [
    "synthetic fixture trust",
    (c) => {
      c.trust.evidence_class = "SYNTHETIC_TEST";
    },
  ],
])
  test("capture rejects " + name + " before retrieval", () =>
    fixture(async (f) => {
      change(f.config);
      await assert.rejects(f.store.capture(f.req));
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await readdir(join(f.root, "archive")), []);
    }),
  );
for (const [name, change] of [
  [
    "wrong digest",
    (r) => {
      r.content_sha256 = "00".repeat(32);
    },
  ],
  [
    "altered root",
    (r) => {
      r.envelope.merkle_root = "00".repeat(32);
      r.content_sha256 = sha256(envelopeBytes(r.envelope));
    },
  ],
  [
    "real market",
    (r) => {
      r.envelope.market_id = "REAL_MARKET";
      r.content_sha256 = sha256(envelopeBytes(r.envelope));
    },
  ],
  [
    "unknown private field",
    (r) => {
      r.claim_secret = "SYNTHETIC_REJECTED";
    },
  ],
  [
    "different commit",
    (r) => {
      r.commit = "00".repeat(20);
    },
  ],
])
  test("capture rejects " + name, () =>
    fixture(async (f) => {
      change(f.req);
      await assert.rejects(f.store.capture(f.req));
      assert.deepEqual(await readdir(join(f.root, "archive")), []);
    }),
  );
for (const [name, alter] of [
  ["retrieved wrong ID", { id: 1 }],
  ["retrieved wrong path", { path: "testnet/ledger-v1.json" }],
  ["tampered content", { bytes: Buffer.from("altered") }],
  ["changed HEAD", { commit: "ee".repeat(20) }],
])
  test("capture rejects " + name, () =>
    fixture(
      async (f) => {
        await assert.rejects(f.store.capture(f.req));
        assert.deepEqual(await readdir(join(f.root, "archive")), []);
      },
      { alter },
    ),
  );
test("missing local clock evidence rejects before network or archive creation", () =>
  fixture(
    async (f) => {
      await assert.rejects(f.store.capture(f.req));
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await readdir(join(f.root, "archive")), []);
    },
    { clock: false },
  ));
test("corrupted clock evidence and missing operational hooks fail closed", () =>
  fixture(async (f) => {
    await writeFile(join(f.clockDir, "clock-raw.txt"), "altered");
    await assert.rejects(f.store.capture(f.req));
    assert.equal(f.requests.length, 0);
    f.store.operational = undefined;
    await assert.rejects(f.store.capture(f.req));
    assert.equal(f.requests.length, 0);
  }));
test("conflicting retry and modified capture fail without rewriting originals", () =>
  fixture(async (f) => {
    const a = await f.store.capture(f.req),
      path = f.store.record(a.record);
    const original = await readFile(join(path, "capture.json"));
    await assert.rejects(
      f.store.capture({ ...f.req, commit: "ee".repeat(20) }),
    );
    assert.deepEqual(await readFile(join(path, "capture.json")), original);
    const changed = JSON.parse(original);
    changed.trust_sha256 = "00".repeat(32);
    await writeFile(join(path, "capture.json"), canonical(changed));
    await assert.rejects(f.store.capture(f.req));
  }));
test("stale clock evidence rejects before retrieval", () =>
  fixture(async (f) => {
    const path = join(f.clockDir, "clock-check.json");
    const clock = JSON.parse(await readFile(path, "utf8"));
    clock.checked_at = new Date(Date.now() - 301000).toISOString();
    await writeFile(path, canonical(clock));
    await assert.rejects(f.store.capture(f.req));
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await readdir(join(f.root, "archive")), []);
  }));
test("stored witness identity mismatch rejects without decrypting or archiving", () =>
  fixture(async (f) => {
    const path = join(f.root, "keys/witness-key.json"),
      original = await readFile(path);
    try {
      const key = stubKey();
      key.public_spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.alloc(32),
      ]).toString("base64");
      await writeFile(path, canonical(key));
      await assert.rejects(f.store.capture(f.req));
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await readdir(join(f.root, "archive")), []);
    } finally {
      await writeFile(path, original);
    }
  }));
test("strict nonce, timestamp, receipt and export paths remain blocked", () =>
  fixture(async (f) => {
    const { record } = await f.store.capture(f.req),
      calls = f.requests.length;
    for (const action of ["load", "query", "timestamp", "verify", "export"])
      await assert.rejects(f.store[action](record, true));
    const { capture } = await f.store.loadCapture(record);
    await assert.rejects(
      checkBundle(f.config, capture, {}, { fetch: f.fetch }),
    );
    assert.throws(() =>
      createPublicRetrieval(f.config.destination, f.config.trust, {
        fetch: f.fetch,
      }),
    );
    assert.equal(f.requests.length, calls);
    assert.equal(f.unprotectCalls(), 0);
    assert.deepEqual(await readdir(join(f.root, "exports")), []);
    assert.deepEqual((await readdir(f.store.record(record))).sort(), [
      "capture.json",
      "context.json",
      "envelope.json",
    ]);
  }));
async function cli(f, action = "capture") {
  const config = join(f.dir, "config.json"),
    req = join(f.dir, "request.json");
  await writeFile(config, canonical(f.config));
  await writeFile(req, canonical(f.req));
  try {
    return {
      code: 0,
      ...(await run(
        process.execPath,
        [
          "--import",
          new URL("./capture-fixture.mjs", import.meta.url).href,
          script("cli.mjs"),
          action,
          config,
          req,
          "-",
          action === "timestamp"
            ? "COMMON_CONTROL_AND_TSA_SUBMISSION_ACKNOWLEDGED"
            : "COMMON_CONTROL_ACKNOWLEDGED",
          "-",
          f.clockDir,
        ],
        {
          env: {
            SystemRoot: process.env.SystemRoot,
            LOCALAPPDATA: f.dir,
            NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
            DARKPOOL_SYNTHETIC_CAPTURE_TEST: "1",
          },
          windowsHide: true,
        },
      )),
    };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
test(
  "Windows CLI completes synthetic capture with actual restricted storage checks",
  { skip: !win },
  () =>
    fixture(
      async (f) => {
        const result = await cli(f);
        assert.equal(result.code, 0, result.stderr);
        const v = JSON.parse(result.stdout);
        assert.equal(v.scope, "SYNTHETIC_TEST_ONLY");
        assert.equal(v.financial_authorization, false);
        assert.equal(v.third_party_independence, false);
        assert.equal((await readdir(join(f.root, "archive"))).length, 1);
      },
      { windowsStorage: true },
    ),
);
test(
  "Windows CLI refuses unsafe ACL before anonymous retrieval",
  { skip: !win },
  () =>
    fixture(
      async (f) => {
        await run(
          join(process.env.SystemRoot, "System32/icacls.exe"),
          [f.root, "/grant", "*S-1-1-0:(R)"],
          {
            env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: f.dir },
            windowsHide: true,
          },
        );
        const result = await cli(f);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /Witness operation not confirmed/);
        assert.deepEqual(await readdir(join(f.root, "archive")), []);
        await assert.rejects(readFile(join(f.dir, "network.jsonl")), {
          code: "ENOENT",
        });
      },
      { windowsStorage: true },
    ),
);
test(
  "Windows CLI refuses non-capture operations under unavailable trust",
  { skip: !win },
  () =>
    fixture(
      async (f) => {
        for (const action of [
          "sign",
          "query",
          "timestamp",
          "verify",
          "export",
        ]) {
          const result = await cli(f, action);
          assert.notEqual(result.code, 0);
          assert.match(result.stderr, /Witness operation not confirmed/);
          assert.equal(result.stdout, "");
        }
        await assert.rejects(readFile(join(f.dir, "network.jsonl")), {
          code: "ENOENT",
        });
      },
      { windowsStorage: true },
    ),
);

import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import candidate from "../synthetic/witness-config.proposed.json" with { type: "json" };
import {
  canonical,
  sha256,
  envelopeBytes,
  trustProfile,
  DOMAIN,
} from "../../../services/publication/profile.mjs";
import { gitBlobSha1 } from "../../../services/publication/github.mjs";
import {
  acknowledgementValid,
  captureValid,
  checkBundle,
  archiveUrl,
  captureOnlyValid,
  settings,
} from "../core.mjs";
import { WitnessStore as OriginalStore } from "../store.mjs";
import { syntheticPlan, syntheticRecord } from "../synthetic.mjs";
import { captureClock, operationalEvidence } from "../operational.mjs";
import {
  syntheticSigningSettings,
  SIGNING_CONFIGURATION_SHA256,
  SIGNING_CONFIGURATION_FILE_SHA256,
  requireSyntheticSigningFile,
  SIGNING_COMMIT,
} from "../synthetic-signing.mjs";
import { verifyPublication } from "../../../services/publication/verify.mjs";

// All fetches are mocked; no real key, capture, hosting or TSA is accessed.
globalThis.fetch = async () => {
  throw Error("TEST_NETWORK_FORBIDDEN");
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
let tree, config, fixtureKey, fixturePassword, Synthetic, Store, ConfigCheck;
async function cleanup(path, prefix) {
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  assert(basename(path).startsWith(prefix));
  await rm(path, { recursive: true, force: true });
}
before(async () => {
  tree = await mkdtemp(join(tmpdir(), "darkpool-synthetic-sign-source-"));
  // Real Ed25519 test signatures need a disposable test key. Mirror source with
  // ONLY its public SPKI/configuration digest pins substituted. No runtime override
  // exists, no test hook is exported, and production pins are separately tested.
  const pair = generateKeyPairSync("ed25519");
  fixturePassword = Buffer.alloc(32, 7);
  fixtureKey = {
    version: 1,
    mode: candidate.mode,
    public_spki: pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    encrypted_pkcs8: pair.privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: fixturePassword,
    }),
    protected_password: Buffer.from("SYNTHETIC_DPAPI_FIXTURE").toString(
      "base64",
    ),
  };
  config = clone(candidate);
  config.trust.witness_spki = fixtureKey.public_spki;
  const digest = sha256(Buffer.from(canonical(config)));
  const files = [
    "tools/commitment-witness/core.mjs",
    "tools/commitment-witness/store.mjs",
    "tools/commitment-witness/cli.mjs",
    "tools/commitment-witness/witness.ps1",
    "tools/commitment-witness/storage.ps1",
    "tools/commitment-witness/operational.mjs",
    "tools/commitment-witness/synthetic.mjs",
    "tools/commitment-witness/synthetic-signing.mjs",
    "tools/commitment-witness/check-signing-config.mjs",
    "tools/commitment-witness/synthetic/github-destination.json",
    "tools/commitment-witness/synthetic/envelope.json",
    "tools/commitment-witness/synthetic/witness-config.proposed.json",
    "services/publication/profile.mjs",
    "services/publication/github.mjs",
    "services/publication/github-receipt.mjs",
    "services/publication/http.mjs",
    "services/publication/verify.mjs",
    "services/publication/openssl.mjs",
    "services/publication/tst-policy.mjs",
    "services/publication/rfc3161.mjs",
    "services/publication/github-destination.json",
  ];
  for (const name of files) {
    const target = join(tree, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repo, name), target);
  }
  await writeFile(
    join(
      tree,
      "tools/commitment-witness/synthetic/witness-config.proposed.json",
    ),
    canonical(config),
  );
  const path = join(tree, "tools/commitment-witness/synthetic-signing.mjs");
  const source = await readFile(path, "utf8");
  assert.equal(source.split(SIGNING_CONFIGURATION_SHA256).length, 2);
  assert.equal(source.split(SIGNING_CONFIGURATION_FILE_SHA256).length, 2);
  await writeFile(
    path,
    source
      .replace(SIGNING_CONFIGURATION_SHA256, digest)
      .replace(
        SIGNING_CONFIGURATION_FILE_SHA256,
        sha256(Buffer.from(canonical(config))),
      ),
  );
  Synthetic = await import(pathToFileURL(path).href);
  ConfigCheck = await import(
    pathToFileURL(
      join(tree, "tools/commitment-witness/check-signing-config.mjs"),
    ).href
  );
  Store = (
    await import(
      pathToFileURL(join(tree, "tools/commitment-witness/store.mjs")).href
    )
  ).WitnessStore;
});
after(async () => {
  fixturePassword?.fill(0);
  if (tree) await cleanup(tree, "darkpool-synthetic-sign-source-");
});

async function fixture(work, { windowsStorage = false } = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), "darkpool-synthetic-sign-test-"),
  );
  const root = join(directory, "ZcashDarkPoolCommitmentWitness");
  try {
    if (windowsStorage) await psStorage(directory, "init");
    else await mkdir(root);
    const id = syntheticRecord(),
      record = join(root, "archive", id),
      clock = join(root, "clock-B");
    if (!windowsStorage)
      for (const name of ["keys", "archive", "exports"])
        await mkdir(join(root, name));
    await mkdir(record);
    const request = {
      commit: SIGNING_COMMIT,
      content_sha256: syntheticPlan().content_sha256,
      envelope: clone(syntheticPlan().envelope),
    };
    const c = clone(config),
      key = clone(fixtureKey);
    if (windowsStorage)
      key.protected_password = (
        await psStorage(
          directory,
          "protect",
          fixturePassword.toString("base64"),
        )
      ).stdout.trim();
    const capture = {
      version: 1,
      mode: c.mode,
      request,
      witness_id: sha256(Buffer.from(key.public_spki, "base64")),
      trust_sha256: sha256(Buffer.from(canonical(c))),
      observed_at: "2026-10-23T12:00:00.000Z",
      archive_url: archiveUrl(
        c,
        sha256(Buffer.from(key.public_spki, "base64")),
        request,
      ),
      git_blob_sha1: gitBlobSha1(envelopeBytes(request.envelope)),
    };
    const context = {
      mode: c.mode,
      third_party_independence: "NO",
      repository_id: c.destination.repository_id,
      branch: c.destination.branch,
      witness_id: capture.witness_id,
      financial_authorization: "NOT_AUTHORIZED",
    };
    await writeFile(join(root, "keys/witness-key.json"), canonical(key), {
      flag: "wx",
    });
    for (const [name, value] of [
      ["capture", capture],
      ["context", context],
    ])
      await writeFile(join(record, name + ".json"), canonical(value), {
        flag: "wx",
      });
    await writeFile(
      join(record, "envelope.json"),
      envelopeBytes(request.envelope),
      { flag: "wx" },
    );
    await captureClock("COMPUTER_B", clock, {
      measure: async () => ({
        stdout: "-03.081s\n-03.080s\n-03.079s\n",
        stderr: "",
      }),
    });
    const calls = [];
    let decrypts = 0;
    const f = {
      directory,
      root,
      record,
      id,
      clock,
      c,
      key,
      capture,
      context,
      request,
      calls,
      hosted: envelopeBytes(request.envelope),
      status: 200,
      decrypts: () => decrypts,
    };
    const store = new Store(root, c, {
      fetch: async (url, options) => {
        assert.equal(url, capture.archive_url);
        assert.equal(options.method, "GET");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.body, undefined);
        calls.push(url);
        await f.onFetch?.();
        if (f.networkError) throw Error("MOCK_NETWORK_UNAVAILABLE");
        return new Response(f.hosted, { status: f.status, headers: f.headers });
      },
      unprotect: async () => {
        decrypts++;
        await f.onDecrypt?.();
        return Buffer.from(fixturePassword);
      },
      operational: operationalEvidence(
        join(root, "absent-A"),
        clock,
        join(root, "audit"),
      ),
    });
    f.store = store;
    f.ack = join(record, "acknowledgement.json");
    f.snapshot = async () =>
      Promise.all(
        ["capture.json", "context.json", "envelope.json"]
          .map((n) => readFile(join(record, n)))
          .concat([readFile(join(root, "keys/witness-key.json"))]),
      );
    f.reject = async () => {
      const originals = await f.snapshot();
      await assert.rejects(store.sign(id));
      assert.deepEqual(await f.snapshot(), originals);
      await assert.rejects(readFile(f.ack), { code: "ENOENT" });
    };
    await work(f);
    assert.equal(c.trust.status, "UNAVAILABLE");
    assert.deepEqual(await readdir(join(root, "exports")), []);
  } finally {
    await cleanup(directory, "darkpool-synthetic-sign-test-");
  }
}
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
function run(executable, args, env, input = "") {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("SYNTHETIC_CHILD_TIMEOUT"));
    }, 30000);
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
async function psStorage(directory, action, input = "") {
  const result = await run(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(tree, "tools/commitment-witness/storage.ps1"),
      "-Action",
      action,
    ],
    {
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: directory,
    },
    input,
  );
  assert.equal(result.code, 0, result.stderr);
  return result;
}
async function stale(f) {
  const path = join(f.clock, "clock-check.json"),
    clock = JSON.parse(await readFile(path, "utf8"));
  clock.checked_at = new Date(Date.now() - 301000).toISOString();
  await writeFile(path, canonical(clock));
}

test("operator-confirmed original pins reject the distinct bundled template", () => {
  assert.equal(
    sha256(Buffer.from(canonical(candidate))),
    "681d420bf1cac096f2e89dc94a7ce446a35c7bba8f623841f21d7547481421de",
  );
  assert.equal(
    SIGNING_CONFIGURATION_SHA256,
    "ce055bbd67ba4fa20bfba2a34e3f2de55cdafb70551283b6ce3e4341fed91a73",
  );
  assert.equal(
    SIGNING_CONFIGURATION_FILE_SHA256,
    "df3047845f92ecbee3c3ce031229cf34363a01bc64e604c7f863fa465111cf72",
  );
  assert.throws(() => syntheticSigningSettings(candidate, syntheticRecord()));
  assert.throws(() =>
    requireSyntheticSigningFile(Buffer.from(canonical(candidate))),
  );
  assert.throws(() => trustProfile(candidate.trust), /PUBLICATION_UNAVAILABLE/);
});
test("reported capture hash reproduces the exact loadCapture failure before signing validation", () =>
  fixture(async (f) => {
    // Entirely disposable reconstruction of the supplied public mismatch.
    // No B capture/config/key is copied or rewritten.
    const key = { ...f.key, public_spki: candidate.trust.witness_spki };
    const witness = sha256(Buffer.from(key.public_spki, "base64"));
    const capture = {
      ...f.capture,
      witness_id: witness,
      trust_sha256: SIGNING_CONFIGURATION_SHA256,
      archive_url: archiveUrl(candidate, witness, f.request),
    };
    const context = { ...f.context, witness_id: witness };
    await writeFile(join(f.root, "keys/witness-key.json"), canonical(key));
    await writeFile(join(f.record, "capture.json"), canonical(capture));
    await writeFile(join(f.record, "context.json"), canonical(context));
    const before = await f.snapshot();
    const store = new OriginalStore(f.root, clone(candidate));
    await assert.rejects(store.loadCapture(f.id), /WITNESS_REJECTED/);
    assert.throws(
      () => captureOnlyValid(candidate, key, capture),
      /WITNESS_REJECTED/,
    );
    assert.deepEqual(await f.snapshot(), before);
    // Control: changing just the synthetic fixture's binding proves that all
    // other fields pass. This is NEVER a repair procedure for the real record.
    capture.trust_sha256 = sha256(
      Buffer.from(canonical(settings(candidate, false))),
    );
    assert.equal(
      capture.trust_sha256,
      "681d420bf1cac096f2e89dc94a7ce446a35c7bba8f623841f21d7547481421de",
    );
    await writeFile(join(f.record, "capture.json"), canonical(capture));
    assert.equal(
      (await store.loadCapture(f.id)).capture.trust_sha256,
      capture.trust_sha256,
    );
    assert.throws(() => syntheticSigningSettings(candidate, f.id));
    assert.equal(f.calls.length, 0);
    assert.equal(f.decrypts(), 0);
  }));

async function configDiagnostic(f, bytes = Buffer.from(canonical(f.c))) {
  const path = join(f.directory, "approved-public-config.json");
  await writeFile(path, bytes);
  const originals = await f.snapshot();
  const result = await ConfigCheck.checkSigningConfiguration(path, f.root);
  assert.deepEqual(await f.snapshot(), originals);
  assert.equal(f.calls.length, 0);
  assert.equal(f.decrypts(), 0);
  await assert.rejects(readFile(join(f.root, "audit")), { code: "ENOENT" });
  return result;
}
test("correct original-config fixture passes the read-only check without clock renewal or writes", () =>
  fixture(async (f) => {
    assert.deepEqual(await configDiagnostic(f), {
      stage: "READ_ONLY_CONFIG_AND_CAPTURE",
      status: "PASS",
    });
    assert.equal(
      (await f.store.loadCapture(f.id)).capture.observed_at,
      f.capture.observed_at,
    );
  }));
for (const [label, bytes] of [
  ["bundled template", () => Buffer.from(canonical(candidate))],
  ["formatting-only changes", (f) => Buffer.from(JSON.stringify(f.c, null, 2))],
  ["added newline", (f) => Buffer.from(canonical(f.c) + "\n")],
  [
    "different OpenSSL path",
    (f) => {
      const c = clone(f.c);
      c.openssl += "-3.5.9";
      return Buffer.from(canonical(c));
    },
  ],
  ["malformed JSON", () => Buffer.from("{")],
])
  test(
    "config diagnostic rejects " +
      label +
      " at raw file hash without private access",
    () =>
      fixture(async (f) => {
        assert.deepEqual(await configDiagnostic(f, bytes(f)), {
          stage: "CONFIGURATION_FILE_HASH",
          status: "FAIL",
        });
      }),
  );
for (const [label, change, stage] of [
  [
    "mismatched capture trust hash",
    (f) => {
      f.capture.trust_sha256 = "00".repeat(32);
    },
    "EXISTING_CAPTURE",
  ],
  [
    "wrong witness",
    (f) => {
      f.capture.witness_id = "00".repeat(32);
    },
    "EXISTING_CAPTURE",
  ],
  [
    "different publication commit",
    (f) => {
      f.capture.request.commit = "00".repeat(20);
    },
    "SIGNING_CAPTURE_BINDING",
  ],
])
  test(
    "config diagnostic locates " +
      label +
      " without altering the failed record",
    () =>
      fixture(async (f) => {
        change(f);
        await writeFile(join(f.record, "capture.json"), canonical(f.capture));
        assert.deepEqual(await configDiagnostic(f), { stage, status: "FAIL" });
      }),
  );
for (const [label, pathFor] of [
  ["operation lock", (f) => join(f.root, "operation.lock")],
  ["partial acknowledgement", (f) => f.ack],
  [
    "signing attempt",
    (f) => join(f.root, "synthetic-sign-" + f.id + ".attempt.json"),
  ],
])
  test("config diagnostic preserves an existing " + label, () =>
    fixture(async (f) => {
      const path = pathFor(f);
      await writeFile(path, "SYNTHETIC_EXISTING_MARKER", { flag: "wx" });
      assert.deepEqual(await configDiagnostic(f), {
        stage: "EXISTING_OPERATION",
        status: "FAIL",
      });
      assert.equal(await readFile(path, "utf8"), "SYNTHETIC_EXISTING_MARKER");
    }),
  );
test("config diagnostic refuses a private state path as configuration", () =>
  fixture(async (f) => {
    assert.deepEqual(
      await ConfigCheck.checkSigningConfiguration(
        join(f.root, "keys/witness-key.json"),
        f.root,
      ),
      { stage: "CONFIGURATION_PATH", status: "FAIL" },
    );
  }));
test("config diagnostic emits only allowlisted stage/status for a wrong file", () =>
  fixture(async (f) => {
    const path = join(f.directory, "wrong-public-config.json");
    await writeFile(path, "PUBLIC_SENTINEL_NOT_TO_PRINT");
    const result = await run(
      process.execPath,
      [join(tree, "tools/commitment-witness/check-signing-config.mjs"), path],
      { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: f.directory },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      '{"stage":"CONFIGURATION_FILE_HASH","status":"FAIL"}\n',
    );
  }));
for (const [label, change] of [
  ["different record", (c) => {}],
  [
    "READY trust",
    (c) => {
      c.trust.status = "READY";
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
    "real path",
    (c) => {
      c.destination.path = c.trust.path = "testnet/ledger-v1.json";
    },
  ],
  [
    "wrong branch",
    (c) => {
      c.destination.branch = "other";
    },
  ],
  [
    "wrong repository ID",
    (c) => {
      c.destination.repository_id = "1";
    },
  ],
  [
    "changed clock policy",
    (c) => {
      c.trust.max_clock_skew_seconds = 121;
    },
  ],
  [
    "changed TSA material",
    (c) => {
      c.trust.ca_bundle += "\n";
    },
  ],
  [
    "changed OpenSSL path",
    (c) => {
      c.openssl = "C:\\other.exe";
    },
  ],
  [
    "changed archive",
    (c) => {
      c.archive_base_path = "other";
    },
  ],
  [
    "extra config field",
    (c) => {
      c.extra = "not approved";
    },
  ],
])
  test("unmodified production pins reject " + label, () => {
    const c = clone(candidate);
    change(c);
    assert.throws(() =>
      syntheticSigningSettings(
        c,
        label === "different record" ? "00".repeat(32) : syntheticRecord(),
      ),
    );
  });
test("existing capture signs only a labeled synthetic acknowledgement and preserves originals", () =>
  fixture(async (f) => {
    const originals = await f.snapshot(),
      result = await f.store.sign(f.id);
    assert.equal(result.status, "SYNTHETIC_ACKNOWLEDGEMENT_RETAINED");
    assert.equal(result.financial_authorization, false);
    assert.equal(result.third_party_independence, false);
    assert.equal(result.authorization_status, "NOT_GRANTED");
    const ack = JSON.parse(await readFile(f.ack, "utf8"));
    Synthetic.syntheticAcknowledgementValid(f.c, f.key, f.capture, f.id, ack);
    assert.equal(ack.statement.observed_at, f.capture.observed_at);
    assert.equal(ack.statement.configuration_sha256, f.capture.trust_sha256);
    assert.equal(ack.statement.profile, "DARKPOOL_SYNTHETIC_WITNESS_ACK_V1");
    assert.equal(ack.statement.financial_authorization, "NOT_GRANTED");
    assert.equal(ack.statement.third_party_independence, "NO");
    assert.deepEqual(await f.snapshot(), originals);
    const audit = await readdir(join(f.root, "audit"));
    assert(audit.length >= 1);
    for (const name of audit)
      assert.equal(
        JSON.parse(await readFile(join(f.root, "audit", name), "utf8"))
          .financial_authorization,
        "NOT_GRANTED",
      );
  }));
test("identical retry retains original bytes and mtime without another private-key operation", () =>
  fixture(async (f) => {
    await f.store.sign(f.id);
    const b = await readFile(f.ack),
      m = (await stat(f.ack)).mtimeMs,
      d = f.decrypts();
    await f.store.sign(f.id);
    assert.deepEqual(await readFile(f.ack), b);
    assert.equal((await stat(f.ack)).mtimeMs, m);
    assert.equal(f.decrypts(), d);
    assert.equal(f.calls.length, 2);
  }));
for (const [label, change] of [
  [
    "missing hosting",
    (f) => {
      f.status = 404;
    },
  ],
  [
    "unavailable hosting",
    (f) => {
      f.status = 503;
    },
  ],
  [
    "network timeout",
    (f) => {
      f.networkError = true;
    },
  ],
  [
    "altered bytes",
    (f) => {
      f.hosted = Buffer.from("altered");
    },
  ],
  [
    "trailing newline",
    (f) => {
      f.hosted = Buffer.concat([f.hosted, Buffer.from("\n")]);
    },
  ],
  [
    "BOM",
    (f) => {
      f.hosted = Buffer.concat([Buffer.from([239, 187, 191]), f.hosted]);
    },
  ],
  [
    "compression",
    (f) => {
      f.headers = { "content-encoding": "gzip" };
    },
  ],
])
  test("synthetic signing rejects " + label + " before decrypting", () =>
    fixture(async (f) => {
      change(f);
      await f.reject();
      assert.equal(f.decrypts(), 0);
    }),
  );
for (const [label, change] of [
  [
    "changed configuration",
    async (f) => {
      f.c.trust.max_witness_lag_seconds++;
    },
  ],
  [
    "different commit",
    async (f) => {
      f.capture.request.commit = "00".repeat(20);
    },
  ],
  [
    "changed configuration binding",
    async (f) => {
      f.capture.trust_sha256 = "00".repeat(32);
    },
  ],
  [
    "changed root",
    async (f) => {
      f.capture.request.envelope.merkle_root = "00".repeat(32);
    },
  ],
  [
    "wrong witness identity",
    async (f) => {
      f.capture.witness_id = "00".repeat(32);
    },
  ],
  [
    "wrong public archive URL",
    async (f) => {
      f.capture.archive_url = "https://other.invalid/envelope.json";
    },
  ],
  [
    "invalid observation time",
    async (f) => {
      f.capture.observed_at = "2020-01-01T00:00:00.000Z";
    },
  ],
])
  test(
    "synthetic signing rejects " +
      label +
      " without rewriting the failed inputs",
    () =>
      fixture(async (f) => {
        await change(f);
        await writeFile(join(f.record, "capture.json"), canonical(f.capture));
        await f.reject();
        assert.equal(f.calls.length, 0);
        assert.equal(f.decrypts(), 0);
      }),
  );
test("stale clock fails before public retrieval", () =>
  fixture(async (f) => {
    await stale(f);
    await f.reject();
    assert.equal(f.calls.length, 0);
  }));
test("missing clock fails before public retrieval", () =>
  fixture(async (f) => {
    await rm(f.clock, { recursive: true });
    await f.reject();
    assert.equal(f.calls.length, 0);
  }));
test("tampered clock fails before public retrieval", () =>
  fixture(async (f) => {
    await writeFile(join(f.clock, "clock-raw.txt"), "altered");
    await f.reject();
    assert.equal(f.calls.length, 0);
  }));
test("clock expiration during GET stops before key access", () =>
  fixture(async (f) => {
    f.onFetch = () => stale(f);
    await f.reject();
    assert.equal(f.decrypts(), 0);
  }));
test("clock expiration during decryption stops before a signature is persisted", () =>
  fixture(async (f) => {
    f.onDecrypt = () => stale(f);
    await f.reject();
    assert.equal(f.decrypts(), 1);
  }));
test("missing operational audit hooks fail closed", () =>
  fixture(async (f) => {
    f.store.operational = undefined;
    await f.reject();
    assert.equal(f.calls.length, 0);
  }));
test("future clock evidence fails before public retrieval", () =>
  fixture(async (f) => {
    const path = join(f.clock, "clock-check.json");
    const clock = JSON.parse(await readFile(path, "utf8"));
    clock.checked_at = new Date(Date.now() + 60000).toISOString();
    await writeFile(path, canonical(clock));
    await f.reject();
    assert.equal(f.calls.length, 0);
  }));
test("public-key substitution fails before network or decryption", () =>
  fixture(async (f) => {
    f.key.public_spki = candidate.trust.witness_spki;
    await writeFile(join(f.root, "keys/witness-key.json"), canonical(f.key));
    await f.reject();
    assert.equal(f.calls.length, 0);
    assert.equal(f.decrypts(), 0);
  }));
test("missing original capture fails without recreation", () =>
  fixture(async (f) => {
    await rm(join(f.record, "capture.json"));
    await assert.rejects(f.store.sign(f.id));
    await assert.rejects(readFile(join(f.record, "capture.json")), {
      code: "ENOENT",
    });
    assert.equal(f.calls.length, 0);
  }));
test("failed audit creation stops before public retrieval", () =>
  fixture(async (f) => {
    await writeFile(join(f.root, "audit"), "SYNTHETIC_NOT_A_DIRECTORY", {
      flag: "wx",
    });
    await f.reject();
    assert.equal(f.calls.length, 0);
  }));
test("interrupted acknowledgement write is preserved and blocks retry", () =>
  fixture(async (f) => {
    const originalSave = f.store.saveJson.bind(f.store);
    f.store.saveJson = async (path, value) => {
      if (path !== f.ack) return originalSave(path, value);
      await f.store.save(path, Buffer.from('{"statement":'));
      throw Error("SYNTHETIC_CRASH_AFTER_PARTIAL_WRITE");
    };
    const originals = await f.snapshot();
    await assert.rejects(f.store.sign(f.id));
    const partial = await readFile(f.ack),
      decrypts = f.decrypts();
    f.store.saveJson = originalSave;
    await assert.rejects(f.store.sign(f.id));
    assert.deepEqual(await readFile(f.ack), partial);
    assert.equal(f.decrypts(), decrypts);
    assert.deepEqual(await f.snapshot(), originals);
  }));
test("key parsing failure preserves originals and creates no acknowledgement", () =>
  fixture(async (f) => {
    f.key.encrypted_pkcs8 =
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nSYNTHETIC_BROKEN_KEY";
    await writeFile(join(f.root, "keys/witness-key.json"), canonical(f.key));
    await f.reject();
  }));
test("a different decrypted private key cannot sign as the pinned witness", () =>
  fixture(async (f) => {
    f.key.encrypted_pkcs8 = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: fixturePassword,
    });
    await writeFile(join(f.root, "keys/witness-key.json"), canonical(f.key));
    await f.reject();
  }));
test("key decryption failure preserves the captured record", () =>
  fixture(async (f) => {
    f.store.unprotect = async () => {
      throw Error("MOCK_WRONG_USER");
    };
    await f.reject();
  }));
for (const value of ["", "{", "{}", '{"statement":{},"signature":"bad"}\n'])
  test(
    "partial or invalid acknowledgement is retained, never overwritten: " +
      JSON.stringify(value),
    () =>
      fixture(async (f) => {
        await writeFile(f.ack, value, { flag: "wx" });
        const b = await readFile(f.ack),
          originals = await f.snapshot();
        await assert.rejects(f.store.sign(f.id));
        assert.deepEqual(await readFile(f.ack), b);
        assert.deepEqual(await f.snapshot(), originals);
        assert.equal(f.decrypts(), 0);
      }),
  );
test("conflicting signed statement and forged signature fail closed", () =>
  fixture(async (f) => {
    await f.store.sign(f.id);
    const ack = JSON.parse(await readFile(f.ack, "utf8"));
    ack.statement.financial_authorization = "GRANTED";
    await writeFile(f.ack, canonical(ack));
    const b = await readFile(f.ack);
    await assert.rejects(f.store.sign(f.id));
    assert.deepEqual(await readFile(f.ack), b);
  }));
test("existing lock is not removed or replaced", () =>
  fixture(async (f) => {
    const path = join(f.root, "operation.lock");
    await writeFile(path, "SYNTHETIC_EXISTING_LOCK", { flag: "wx" });
    await f.reject();
    assert.equal(await readFile(path, "utf8"), "SYNTHETIC_EXISTING_LOCK");
    assert.equal(f.calls.length, 0);
  }));
test("concurrent signing attempts cannot create two acknowledgements", () =>
  fixture(async (f) => {
    const results = await Promise.allSettled([
      f.store.sign(f.id),
      f.store.sign(f.id),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.decrypts(), 1);
    Synthetic.syntheticAcknowledgementValid(
      f.c,
      f.key,
      f.capture,
      f.id,
      JSON.parse(await readFile(f.ack, "utf8")),
    );
  }));
test("retry still fails if hosted bytes are no longer available", () =>
  fixture(async (f) => {
    await f.store.sign(f.id);
    const b = await readFile(f.ack);
    f.status = 404;
    await assert.rejects(f.store.sign(f.id));
    assert.deepEqual(await readFile(f.ack), b);
    assert.equal(f.decrypts(), 1);
  }));
test("synthetic acknowledgement cannot enter production receipt, timestamp or export paths", () =>
  fixture(async (f) => {
    await f.store.sign(f.id);
    const ack = JSON.parse(await readFile(f.ack, "utf8"));
    assert.throws(() => captureValid(f.c, f.key, f.capture));
    assert.throws(() => acknowledgementValid(f.c, f.key, f.capture, ack));
    await assert.rejects(checkBundle(f.c, f.capture, ack));
    for (const action of ["load", "query", "timestamp", "verify", "export"])
      await assert.rejects(f.store[action](f.id, true));
    // Even a separately changed READY policy has another schema/profile/domain.
    assert(!Buffer.from("DARKPOOL_SYNTHETIC_WITNESS_ACK_V1\0").equals(DOMAIN));
    assert.equal(ack.statement.evidence_class, "SYNTHETIC_TEST_ONLY");
    assert.equal(f.calls.length, 1);
    const ready = clone(f.c.trust);
    ready.status = "READY";
    assert.equal(trustProfile(ready).status, "READY");
    await assert.rejects(
      verifyPublication(
        f.request.envelope,
        {
          envelope: envelopeBytes(f.request.envelope).toString("base64"),
          ...ack,
          tsq: "AA==",
          tsr: "AA==",
        },
        ready,
        "UNREACHABLE_OPENSSL",
        async () => {
          throw Error("RETRIEVAL_MUST_NOT_BE_CALLED");
        },
      ),
      /PUBLICATION_REJECTED/,
    );
  }));
test(
  "Windows wrapper forwards synthetic sign with actual DPAPI, ACLs and mocked public GET only",
  { skip: process.platform !== "win32" },
  () =>
    fixture(
      async (f) => {
        const configPath = join(f.directory, "config.json"),
          preload = join(f.directory, "network-fixture.mjs"),
          requests = join(f.directory, "requests.jsonl");
        await writeFile(configPath, canonical(f.c));
        // Explicit test-only Node preload. Not exported or reachable through the CLI.
        await writeFile(
          preload,
          `import {appendFileSync} from 'node:fs';
globalThis.fetch=async(url,options)=>{
 if(url!==${JSON.stringify(f.capture.archive_url)}||options.method!=='GET'||options.body||options.headers.Authorization) throw Error('TEST_NETWORK_FORBIDDEN');
 appendFileSync(${JSON.stringify(requests)},JSON.stringify({method:options.method,url})+'\\n');
 return new Response(Buffer.from(${JSON.stringify(f.hosted.toString("base64"))},'base64'));
};`,
        );
        const env = {
          SystemRoot: process.env.SystemRoot,
          LOCALAPPDATA: f.directory,
          PATH: dirname(process.execPath) + ";" + process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
        };
        const originals = await f.snapshot();
        const result = await run(
          powershell,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(tree, "tools/commitment-witness/witness.ps1"),
            "-Action",
            "sign",
            "-Config",
            configPath,
            "-Record",
            f.id,
            "-ClockB",
            f.clock,
            "-CommonControlAcknowledged",
          ],
          env,
        );
        assert.equal(result.code, 0, result.stderr);
        const response = JSON.parse(result.stdout.trim());
        assert.equal(response.scope, "SYNTHETIC_TEST_ONLY");
        assert.equal(response.financial_authorization, false);
        assert.equal(response.third_party_independence, false);
        assert.equal(
          (await readFile(requests, "utf8")).trim().split("\n").length,
          1,
        );
        assert(!result.stdout.includes(f.key.protected_password));
        assert(!result.stdout.includes("PRIVATE KEY"));
        assert.deepEqual(await f.snapshot(), originals);
        Synthetic.syntheticAcknowledgementValid(
          f.c,
          f.key,
          f.capture,
          f.id,
          JSON.parse(await readFile(f.ack, "utf8")),
        );
      },
      { windowsStorage: true },
    ),
);

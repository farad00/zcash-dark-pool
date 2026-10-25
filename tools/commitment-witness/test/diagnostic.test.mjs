import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import proposed from "../synthetic/witness-config.proposed.json" with { type: "json" };
import { diagnoseCapture, DIAGNOSTIC_STAGES } from "../diagnose-capture.mjs";
import { captureClock, operationalEvidence } from "../operational.mjs";
import { syntheticPlan } from "../synthetic.mjs";
import { canonical, sha256 } from "../../../services/publication/profile.mjs";
import { WitnessStore } from "../store.mjs";
const run = promisify(execFile),
  win = process.platform === "win32";
const ps = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const source = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
globalThis.fetch = async () => {
  throw Error("TEST_NETWORK_DISABLED");
};
async function snapshot(dir) {
  const files = {};
  async function visit(path) {
    const s = await lstat(path);
    if (s.isDirectory()) {
      files[path] = "DIRECTORY";
      for (const n of await readdir(path)) await visit(join(path, n));
    } else files[path] = sha256(await readFile(path)) + ":" + s.mtimeMs;
  }
  await visit(dir);
  return files;
}
async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), "darkpool-capture-diagnostic-"));
  try {
    await run(
      ps,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        source("storage.ps1"),
        "-Action",
        "init",
      ],
      {
        env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: dir },
        windowsHide: true,
      },
    );
    const root = join(dir, "ZcashDarkPoolCommitmentWitness"),
      configFile = join(dir, "synthetic-config.json"),
      requestFile = join(dir, "public-handoff.json"),
      clockDirectory = join(root, "clock-B"),
      key = join(root, "keys/witness-key.json");
    const config = JSON.parse(JSON.stringify(proposed)),
      plan = syntheticPlan(),
      request = {
        commit: "90e83e50bcc9bdf54f1f2963d988be18a94262e4",
        content_sha256: plan.content_sha256,
        envelope: plan.envelope,
      };
    await writeFile(configFile, canonical(config));
    await writeFile(requestFile, canonical(request));
    // Intentionally NOT key material or even JSON. Metadata-only diagnosis must not parse it.
    await writeFile(
      key,
      "SYNTHETIC_PRIVATE_CONTENT_SENTINEL_DO_NOT_READ_OR_OUTPUT",
    );
    await captureClock("COMPUTER_B", clockDirectory, {
      measure: async () => ({
        stdout: "-01.317s\n-01.316s\n-01.315s\n",
        stderr: "",
      }),
    });
    const options = {
      configFile,
      requestFile,
      clockDirectory,
      local: dir,
      systemRoot: process.env.SystemRoot,
    };
    await work({ dir, root, key, config, request, options });
  } finally {
    if (
      !resolve(dir).startsWith(resolve(tmpdir()) + "\\") ||
      !basename(dir).startsWith("darkpool-capture-diagnostic-")
    )
      throw Error("UNSAFE_CLEANUP");
    await rm(dir, { recursive: true, force: true });
  }
}
function expected(result, stage, status = "FAIL") {
  assert.deepEqual(Object.keys(result).sort(), ["stage", "status"]);
  assert(DIAGNOSTIC_STAGES.includes(result.stage));
  assert.deepEqual(result, { stage, status });
}
test(
  "diagnostic is read-only and deliberately does not parse private-key contents",
  { skip: !win },
  () =>
    fixture(async (f) => {
      const before = await snapshot(f.dir);
      expected(await diagnoseCapture(f.options), "READ_ONLY_CHECKS", "PASS");
      assert.deepEqual(await snapshot(f.dir), before);
      assert.deepEqual(await readdir(join(f.root, "archive")), []);
      assert.deepEqual(await readdir(join(f.root, "exports")), []);
      await assert.rejects(lstat(join(f.root, "audit")), { code: "ENOENT" });
    }),
);
for (const [name, stage, change] of [
  [
    "private-key input path",
    "PUBLIC_INPUT_PATHS",
    async (f) => {
      f.options.configFile = f.key;
    },
  ],
  [
    "malformed configuration",
    "CONFIGURATION_JSON",
    async (f) => {
      await writeFile(f.options.configFile, "DO_NOT_OUTPUT_SYNTHETIC_SECRET");
    },
  ],
  [
    "malformed handoff",
    "HANDOFF_JSON",
    async (f) => {
      await writeFile(f.options.requestFile, "DO_NOT_OUTPUT_SYNTHETIC_SECRET");
    },
  ],
  [
    "real destination",
    "SYNTHETIC_BINDINGS",
    async (f) => {
      f.config.destination.path = "testnet/ledger-v1.json";
      await writeFile(f.options.configFile, canonical(f.config));
    },
  ],
  [
    "activated trust",
    "SYNTHETIC_BINDINGS",
    async (f) => {
      f.config.trust.status = "READY";
      await writeFile(f.options.configFile, canonical(f.config));
    },
  ],
  [
    "wrong digest",
    "SYNTHETIC_BINDINGS",
    async (f) => {
      f.request.content_sha256 = "00".repeat(32);
      await writeFile(f.options.requestFile, canonical(f.request));
    },
  ],
  [
    "wrong witness pin",
    "SYNTHETIC_BINDINGS",
    async (f) => {
      f.config.trust.witness_spki = "INVALID_SYNTHETIC_VALUE";
      await writeFile(f.options.configFile, canonical(f.config));
    },
  ],
  [
    "existing lock",
    "OPERATION_LOCK",
    async (f) => {
      await writeFile(join(f.root, "operation.lock"), "DO_NOT_CLEAR");
    },
  ],
  [
    "missing key",
    "KEY_FILE_METADATA",
    async (f) => {
      await unlink(f.key);
    },
  ],
  [
    "empty key",
    "KEY_FILE_METADATA",
    async (f) => {
      await writeFile(f.key, "");
    },
  ],
  [
    "missing archive directory",
    "ARCHIVE_LAYOUT",
    async (f) => {
      await rmdir(join(f.root, "archive"));
    },
  ],
  [
    "corrupted clock",
    "CLOCK_INTEGRITY",
    async (f) => {
      await writeFile(
        join(f.options.clockDirectory, "clock-raw.txt"),
        "ALTERED",
      );
    },
  ],
  [
    "stale clock",
    "CLOCK_FRESHNESS",
    async (f) => {
      f.options.now = Date.now() + 301000;
    },
  ],
  [
    "audit path is a file",
    "AUDIT_PATH",
    async (f) => {
      await writeFile(join(f.root, "audit"), "DO_NOT_REPAIR");
    },
  ],
  [
    "existing archive record",
    "RECORD_ABSENT",
    async (f) => {
      await mkdir(
        join(
          f.root,
          "archive",
          sha256(Buffer.from(f.request.envelope.market_id)),
        ),
      );
    },
  ],
])
  test(
    "diagnostic localizes " + name + " without mutation",
    { skip: !win },
    () =>
      fixture(async (f) => {
        await change(f);
        const before = await snapshot(f.dir);
        const result = await diagnoseCapture(f.options);
        expected(result, stage);
        assert(!JSON.stringify(result).includes("DO_NOT_OUTPUT"));
        assert.deepEqual(await snapshot(f.dir), before);
      }),
  );
test(
  "native Windows unsafe ACL fails the unchanged storage policy",
  { skip: !win },
  () =>
    fixture(async (f) => {
      await run(
        join(process.env.SystemRoot, "System32/icacls.exe"),
        [f.root, "/grant", "*S-1-1-0:(R)"],
        { windowsHide: true },
      );
      const before = await snapshot(f.dir);
      expected(await diagnoseCapture(f.options), "STORAGE_VALIDATION");
      assert.deepEqual(await snapshot(f.dir), before);
    }),
);
test(
  "storage subprocess failure redacts exception details",
  { skip: !win },
  () =>
    fixture(async (f) => {
      expected(
        await diagnoseCapture({
          ...f.options,
          checkStorage: async () => {
            throw Error("DO_NOT_OUTPUT_SECRET_PATH_OR_ENV");
          },
        }),
        "STORAGE_VALIDATION",
      );
    }),
);
test(
  "noncanonical key record reproduces capture failure before audit, without real key",
  { skip: !win },
  () =>
    fixture(async (f) => {
      // Only this isolated reproduction invokes the store; the diagnostic never imports it.
      await writeFile(
        f.key,
        JSON.stringify({ synthetic: "NOT_KEY_MATERIAL" }, null, 2),
      );
      const store = new WitnessStore(f.root, f.config, {
        fetch: globalThis.fetch,
        operational: operationalEvidence(
          "-",
          f.options.clockDirectory,
          join(f.root, "audit"),
        ),
      });
      await assert.rejects(store.capture(f.request));
      await assert.rejects(lstat(join(f.root, "audit")), { code: "ENOENT" });
      expected(await diagnoseCapture(f.options), "READ_ONLY_CHECKS", "PASS");
    }),
);
async function launch(f, args = {}) {
  try {
    const result = await run(
      ps,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        source("diagnose-capture.ps1"),
        "-Config",
        f.options.configFile,
        "-Request",
        f.options.requestFile,
        "-ClockB",
        f.options.clockDirectory,
      ],
      {
        env: {
          SystemRoot: process.env.SystemRoot,
          LOCALAPPDATA: f.dir,
          PATH: join(process.execPath, ".."),
          NODE_OPTIONS: "--import=DO_NOT_EXECUTE",
          ...args,
        },
        windowsHide: true,
      },
    );
    return { code: 0, ...result };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
test(
  "PowerShell diagnostic emits only two allowlisted fields and strips preload environment",
  { skip: !win },
  () =>
    fixture(async (f) => {
      const before = await snapshot(f.dir),
        result = await launch(f);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      expected(JSON.parse(result.stdout), "READ_ONLY_CHECKS", "PASS");
      assert.deepEqual(await snapshot(f.dir), before);
    }),
);
test(
  "PowerShell diagnostic returns only stage/FAIL for malformed public input",
  { skip: !win },
  () =>
    fixture(async (f) => {
      await writeFile(f.options.configFile, "DO_NOT_OUTPUT_SYNTHETIC_SECRET");
      const result = await launch(f);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      expected(JSON.parse(result.stdout), "CONFIGURATION_JSON");
    }),
);
test("PowerShell diagnostic redacts missing-node errors", { skip: !win }, () =>
  fixture(async (f) => {
    const result = await launch(f, { PATH: f.dir });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    expected(JSON.parse(result.stdout), "DIAGNOSTIC_PROCESS");
  }),
);

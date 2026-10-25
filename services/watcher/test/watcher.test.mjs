import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  readdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { allocateInternal } from "../../../apps/web/src/issuance.mjs";
import {
  canonicalContradiction,
  createCoordinator,
  createWalletProcess,
  framedWalletProcess,
  encodeFrame,
  identity,
  MAX_FRAME,
  walletEnvironment,
} from "../main.mjs";
import { watcherEnvironment } from "../db.mjs";
import {
  safeDiagnostic,
  safeProgress,
  protectedDiagnosticFile,
} from "../diagnostics.mjs";

test("Progress: closed schema excludes private fields and saturates counters", () => {
  const r = safeProgress({
    stage: "PRIVATE_SENTINEL",
    coverage: "PRIVATE_SENTINEL",
    unit_kind: "PRIVATE_SENTINEL",
    last_completed_stage: "PRIVATE_SENTINEL",
    sequence: Number.MAX_SAFE_INTEGER,
    received_count: -1,
    requested_count: NaN,
    committed_block_count: Infinity,
    txid: "PRIVATE_SENTINEL",
    headers: { secret: "PRIVATE_SENTINEL" },
  });
  assert.equal(r.stage, "OTHER");
  assert.equal(r.coverage, "UNKNOWN");
  assert.equal(r.unit_kind, "OTHER");
  assert.equal(r.sequence, 4294967295);
  assert.equal(r.received_count, 0);
  assert.equal(r.requested_count, 0);
  assert.equal(r.committed_block_count, 0);
  assert.ok(!JSON.stringify(r).includes("PRIVATE_SENTINEL"));
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 1024);
});
async function progressDirectory(f) {
  const root = join(process.env.LOCALAPPDATA, "ZcashDarkPoolDev", "phase9");
  const directory = await mkdtemp(join(root, "synthetic-progress-"));
  try {
    const acl = String.raw`$ErrorActionPreference='Stop';$p=$env:DARKPOOL_TEST_DIAGNOSTIC;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$s=New-Object System.Security.Principal.SecurityIdentifier($id);$r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $a`;
    execFileSync(
      join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(acl, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          DARKPOOL_TEST_DIAGNOSTIC: directory,
        },
        stdio: "pipe",
      },
    );
    await f(directory);
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(root) + "\\synthetic-progress-"),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
test("Progress: protected atomic updates reject corrupt and oversized prior records", async () => {
  await progressDirectory(async (directory) => {
    const target = join(directory, "evidence.json");
    const file = await protectedDiagnosticFile({
      ...process.env,
      WATCHER_DIAGNOSTIC_PATH: target,
    });
    try {
      for (const sequence of [1, 2, 3]) {
        await file.progress({
          stage: "DOWNLOAD",
          unit_kind: "VERIFY",
          sequence,
          received_count: sequence,
        });
        const r = JSON.parse(await readFile(target + ".progress", "utf8"));
        assert.equal(r.sequence, sequence);
        assert.equal(r.stage, "DOWNLOAD");
      }
      await writeFile(target + ".progress", "{broken");
      await assert.rejects(file.progress({ stage: "SYNC_COMPLETE" }));
      assert.equal(await readFile(target + ".progress", "utf8"), "{broken");
      await writeFile(target + ".progress", "x".repeat(2049));
      await assert.rejects(file.progress({ stage: "SYNC_COMPLETE" }));
      assert.deepEqual((await readdir(directory)).sort(), [
        "evidence.json",
        "evidence.json.progress",
      ]);
    } finally {
      await file.close();
    }
  });
});
test("Progress: symlink replacement is rejected and its destination remains unchanged", async () => {
  await progressDirectory(async (directory) => {
    const target = join(directory, "evidence.json");
    const file = await protectedDiagnosticFile({
      ...process.env,
      WATCHER_DIAGNOSTIC_PATH: target,
    });
    const victimDirectory = join(directory, "victim");
    await mkdir(victimDirectory);
    const victim = join(victimDirectory, "record.json");
    await writeFile(victim, "PRIVATE_SENTINEL");
    try {
      await unlink(target + ".progress");
      await symlink(victimDirectory, target + ".progress", "junction");
      await assert.rejects(file.progress({ stage: "SYNC_COMPLETE" }));
      assert.equal(await readFile(victim, "utf8"), "PRIVATE_SENTINEL");
    } finally {
      await file.close();
    }
  });
});
test("Progress: IPC coalesces updates without resolving sync or changing its deadline", async () => {
  const script = `process.stdin.once('data',()=>{for(let i=1;i<=100;i++){const b=Buffer.from(JSON.stringify({progress:{stage:'DOWNLOAD',sequence:i,received_count:i}}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));}});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let release;
  const wait = new Promise((done) => {
    release = done;
  });
  const records = [];
  let writes = 0;
  const file = {
    write: () => {},
    progress: async (r) => {
      records.push(r);
      if (++writes === 1) await wait;
    },
  };
  const wallet = framedWalletProcess(child, file);
  let settled = false;
  const request = wallet.request("sync", context).catch(() => {
    settled = true;
  });
  try {
    await new Promise((done, reject) => {
      const end = Date.now() + 5000;
      const check = () => {
        if (records.length) done();
        else if (Date.now() > end)
          reject(Error("progress fixture unavailable"));
        else setTimeout(check, 10);
      };
      check();
    });
    assert.equal(settled, false);
    release();
    await new Promise((done) => setTimeout(done, 100));
    assert.ok(records.length < 100);
    assert.equal(records.at(-1).sequence, 100);
    assert.equal(settled, false);
  } finally {
    release();
    await wallet.close();
    await request;
  }
});
test("Progress: real Rust pending DOWNLOAD and TREE_STATE survive child termination", async () => {
  const names = (await readdir(resolve("target/debug/deps"))).filter((n) =>
    /^darkpool_zcash-[0-9a-f]+\.exe$/.test(n),
  );
  const executable = names
    .map((n) => resolve("target/debug/deps", n))
    .find((p) => {
      try {
        return execFileSync(p, ["--list"], {
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).includes("watcher::sync_tests::progress_os_child_writer_fixture:");
      } catch {
        return false;
      }
    });
  assert.ok(executable, "compiled Rust fixture required");
  for (const stage of ["DOWNLOAD", "TREE_STATE", "EMPTY", "SHORT"])
    await progressDirectory(async (directory) => {
      const target = join(directory, "evidence.json");
      const file = await protectedDiagnosticFile({
        ...process.env,
        WATCHER_DIAGNOSTIC_PATH: target,
      });
      const child = spawn(
        executable,
        [
          "--exact",
          "watcher::sync_tests::progress_os_child_writer_fixture",
          "--nocapture",
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            DARKPOOL_PROGRESS_TEST_CHILD_STAGE: stage,
            DARKPOOL_PROGRESS_TEST_WALLET: join(directory, "disposable.sqlite"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const output = new PassThrough();
      let prelude = Buffer.alloc(0),
        started = false;
      child.stdout.on("data", (chunk) => {
        if (started) {
          output.write(chunk);
          return;
        }
        prelude = Buffer.concat([prelude, chunk]);
        const index = prelude.indexOf('{"progress":');
        if (index >= 4) {
          started = true;
          output.write(prelude.subarray(index - 4));
          prelude = Buffer.alloc(0);
        } else assert.ok(prelude.length < 2048);
      });
      const transport = {
        stdin: child.stdin,
        stdout: output,
        stderr: child.stderr,
        on: child.on.bind(child),
        kill: child.kill.bind(child),
      };
      const wallet = framedWalletProcess(transport, file);
      const request = wallet.request("sync", context).catch(() => {});
      try {
        await new Promise((done, reject) => {
          const end = Date.now() + 10000;
          const check = async () => {
            try {
              const r = JSON.parse(
                await readFile(target + ".progress", "utf8"),
              );
              if (
                (stage === "EMPTY" &&
                  r.verify_empty_count > 0 &&
                  r.unit_kind === "VERIFY" &&
                  r.stage === "DOWNLOAD" &&
                  r.stream_terminated === false) ||
                (stage === "SHORT" &&
                  r.verify_short_count > 0 &&
                  r.unit_kind === "VERIFY" &&
                  r.stage === "DOWNLOAD" &&
                  r.stream_terminated === false) ||
                (r.stage === stage &&
                  (stage !== "DOWNLOAD" || r.received_count === 3))
              ) {
                done();
                return;
              }
            } catch {}
            if (Date.now() > end) reject(Error("real Rust progress missing"));
            else setTimeout(check, 10);
          };
          check();
        });
        child.kill();
        await wallet.close();
        await request;
        const r = JSON.parse(await readFile(target + ".progress", "utf8"));
        if (stage === "EMPTY" || stage === "SHORT")
          assert.ok(
            r[stage === "EMPTY" ? "verify_empty_count" : "verify_short_count"] >
              0,
          );
        else assert.equal(r.stage, stage);
        assert.equal(r.unit_kind, "VERIFY");
        assert.equal(r.completed_unit_count, 0);
        assert.equal(r.maintained_returned, false);
        assert.notEqual(r.last_completed_stage, "SYNC_COMPLETE");
        assert.ok(!JSON.stringify(r).includes(directory));
      } finally {
        await wallet.close();
        await request;
        await file.close();
      }
    });
});
test("Progress: update interruption retains a complete bounded current record", async () => {
  await progressDirectory(async (directory) => {
    const target = join(directory, "interrupted.json");
    const url = pathToFileURL(resolve("services/watcher/diagnostics.mjs")).href;
    const script = `const {protectedDiagnosticFile}=await import(${JSON.stringify(url)});const f=await protectedDiagnosticFile({...process.env,WATCHER_DIAGNOSTIC_PATH:process.env.DARKPOOL_PROGRESS_TEST_TARGET});await f.progress({stage:'DOWNLOAD',sequence:1});process.stdout.write('READY');for(let sequence=2;;sequence++) await f.progress({stage:'DOWNLOAD',sequence});`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        windowsHide: true,
        env: { ...process.env, DARKPOOL_PROGRESS_TEST_TARGET: target },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr.on("data", () => {});
    const ended = new Promise((done) => child.once("close", done));
    try {
      await new Promise((done, reject) => {
        child.stdout.once("data", done);
        child.once("error", reject);
        child.once("close", () => reject(Error("update child exited early")));
      });
      await new Promise((done) => setTimeout(done, 30));
      child.kill();
      await ended;
      const bytes = await readFile(target + ".progress", "utf8");
      const record = JSON.parse(bytes);
      assert.ok(bytes.length <= 2048);
      assert.equal(record.stage, "DOWNLOAD");
      assert.ok(record.sequence >= 1);
      assert.notEqual(record.last_completed_stage, "SYNC_COMPLETE");
      assert.deepEqual(record, safeProgress(record));
      assert.ok(
        (await readdir(directory)).filter((name) => name.endsWith(".tmp"))
          .length <= 1,
      );
    } finally {
      child.kill();
      await ended;
    }
  });
});
test("Progress: frames without protected activation are rejected", async () => {
  const frame = encodeFrame({ progress: { stage: "DOWNLOAD" } });
  const record = await childFailure(
    `process.stdin.once('data',()=>process.stdout.write(Buffer.from('${frame.toString("hex")}','hex')));setInterval(()=>{},1000);`,
  );
  assert.equal(record.class, "IPC_FRAME");
});

const note = {
  txid: "ab".repeat(32),
  pool: "IRONWOOD",
  output_index: 0,
  block_height: 101,
  block_hash: "cd".repeat(32),
  canonical: true,
  present: true,
  is_change: false,
  receiver_verified: true,
  key_scope: 0,
  block_time: 1800000001,
  tx_index: 1,
};
const context = {
  revision: "0",
  market_id: "m",
  vault_context_ref: "v",
  account_ref: "a",
  endpoint_ref: "https://synthetic.invalid",
  receipts: [],
  unmapped: [],
};
const snapshot = () => ({
  outputs: [{ ...note }],
  chain: {
    complete: true,
    verified: true,
    tip_height: 103,
    verified_at: new Date().toISOString(),
  },
});
async function isolated(f) {
  const directory = await mkdtemp(join(tmpdir(), "darkpool-p9-recovery-"));
  try {
    await f(join(directory, "stop.json"));
  } finally {
    assert.ok(
      resolve(directory).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ),
    );
    assert.ok(basename(directory).startsWith("darkpool-p9-recovery-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}
function fixture({
  before = [{ ...note }],
  sync = snapshot(),
  dbError = false,
  observeError = false,
  syncError = false,
  accepted = false,
} = {}) {
  let state = {
      ...context,
      receipts: accepted ? [{ ...note, accepted: true }] : [],
    },
    calls = [];
  const db = {
    context: async () => ({ ...state }),
    reconcile: async (revision, r) => {
      calls.push(r.mode);
      if (dbError) throw new Error("injected-private-database-error");
      state = {
        ...state,
        revision: String(+state.revision + 1),
        receipts: r.mode === "observe_only" ? r.outputs : state.receipts,
      };
      return {
        result:
          r.mode === "safety_stop"
            ? "HELD"
            : r.mode === "observe_only"
              ? "RETAINED"
              : "RECONCILED",
        revision: state.revision,
      };
    },
  };
  const wallet = {
    request: async (op) => {
      calls.push(op);
      if ((op === "observe" && observeError) || (op === "sync" && syncError))
        throw new Error("injected-private-wallet-error");
      return op === "observe" ? { outputs: before } : sync;
    },
  };
  return { db, wallet, calls };
}
test("Pure: stable output identity distinguishes pools/indices and frame bounds", () => {
  assert.notEqual(identity(note), identity({ ...note, pool: "ORCHARD" }));
  assert.notEqual(identity(note), identity({ ...note, output_index: 1 }));
  const frame = encodeFrame({ operation: "observe" });
  assert.equal(frame.readUInt32BE(), frame.length - 4);
  assert.throws(() => encodeFrame("x".repeat(MAX_FRAME)), {
    message: "WATCHER_UNAVAILABLE",
  });
});
test("Pure: accepted contradiction includes same-height hash, shorter depth and receiver evidence", () => {
  const c = { ...context, receipts: [{ ...note, accepted: true }] };
  assert.equal(canonicalContradiction(c, snapshot()), false);
  for (const edit of [
    (s) => (s.outputs = []),
    (s) => (s.outputs[0].block_hash = "ee".repeat(32)),
    (s) => (s.chain.tip_height = 102),
    (s) => (s.outputs[0].present = false),
    (s) => (s.outputs[0].receiver_verified = false),
    (s) => (s.outputs[0].is_change = true),
  ]) {
    const s = snapshot();
    edit(s);
    assert.equal(canonicalContradiction(c, s), true);
  }
});
test("Security: wallet child receives no PostgreSQL, seed, signer or claim credentials", () => {
  const clean = walletEnvironment({
    ZCASH_NETWORK: "testnet",
    WALLET_DB_PATH: "fixture.sqlite",
    CHAIN_ENDPOINT: "https://synthetic.invalid",
    PGPASSWORD: "secret",
    SEED: "secret",
    UFVK: "private",
    CLAIM_SECRET: "secret",
    FROST_SHARES: "secret",
  });
  assert.deepEqual(Object.keys(clean).sort(), [
    "CHAIN_ENDPOINT",
    "WALLET_DB_PATH",
    "ZCASH_NETWORK",
  ]);
  for (const endpoint of [
    "http://synthetic.invalid",
    "https://u:p@synthetic.invalid",
    "https://synthetic.invalid?key=secret",
  ])
    assert.throws(
      () => walletEnvironment({ ...clean, CHAIN_ENDPOINT: endpoint }),
      { message: "WATCHER_UNAVAILABLE" },
    );
});
test("Security: runtime rejects mainnet, inherited maintenance knobs and product development DB", () => {
  const e = {
    APP_ENV: "development",
    DARKPOOL_WATCHER_INTERNAL: "1",
    ZCASH_NETWORK: "testnet",
    PGHOST: "127.0.0.1",
    PGPORT: "55432",
    PGUSER: "watcher",
    PGDATABASE: "darkpool_phase9_1234567890abcdef",
  };
  assert.ok(watcherEnvironment(e));
  for (const extra of [
    { ZCASH_NETWORK: "mainnet" },
    { PGDATABASE: "darkpool_product_dev" },
    { PGOPTIONS: "-c role=admin" },
    { PGHOST: "0.0.0.0" },
    { DATABASE_URL: "private" },
  ])
    assert.throws(() => watcherEnvironment({ ...e, ...extra }), {
      message: "WATCHER_UNAVAILABLE",
    });
});
test("Recovery fixture: unretained observation acknowledgement precedes destructive sync", async () =>
  isolated(async (stopFile) => {
    const f = fixture();
    await createCoordinator({ ...f, stopFile }).cycle();
    assert.deepEqual(f.calls, ["observe", "observe_only", "sync", "snapshot"]);
    const known = fixture({ accepted: true });
    await createCoordinator({ ...known, stopFile }).cycle();
    assert.deepEqual(known.calls, ["observe", "sync", "snapshot"]);
  }));
test("Recovery fixture: explicit controlled rescan still acknowledges unretained notes first", async () =>
  isolated(async (stopFile) => {
    const f = fixture();
    const original = f.wallet.request;
    let height;
    f.wallet.request = async (op, c, r) => {
      if (op === "sync") height = r;
      return original(op, c);
    };
    await createCoordinator({
      ...f,
      stopFile,
      reviewRescanHeight: 100,
    }).cycle();
    assert.equal(height, 100);
    assert.deepEqual(f.calls, ["observe", "observe_only", "sync", "snapshot"]);
    assert.throws(
      () => createCoordinator({ ...f, stopFile, reviewRescanHeight: 0 }),
      { message: "WATCHER_UNAVAILABLE" },
    );
  }));
test("Recovery fixture: preflight database failure never invokes destructive sync", async () =>
  isolated(async (stopFile) => {
    const f = fixture({ dbError: true });
    await assert.rejects(createCoordinator({ ...f, stopFile }).cycle());
    assert.deepEqual(f.calls, ["observe", "observe_only"]);
  }));
test("Recovery fixture: wallet/read and sync failures create no acceptance", async () =>
  isolated(async (stopFile) => {
    for (const options of [{ observeError: true }, { syncError: true }]) {
      const f = fixture(options);
      await assert.rejects(createCoordinator({ ...f, stopFile }).cycle());
      assert.ok(!f.calls.includes("snapshot"));
    }
  }));
test("Recovery fixture: ambiguous commit retries the exact same immutable request", async () =>
  isolated(async (stopFile) => {
    const f = fixture({ before: [] });
    const requests = [];
    let first = true;
    f.db.reconcile = async (revision, r) => {
      requests.push({ revision, r });
      if (first) {
        first = false;
        throw new Error("reply lost after commit");
      }
      return { result: "RECONCILED", revision: "1" };
    };
    await createCoordinator({ ...f, stopFile }).cycle();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].r, requests[1].r);
    assert.equal(requests[0].revision, requests[1].revision);
  }));
test("Recovery fixture: pending safety stop survives DB outage and is replayed before next sync", async () =>
  isolated(async (stopFile) => {
    const f = fixture({
      before: [],
      sync: { stop_reason: "ANCHOR_CONFLICT" },
      dbError: true,
    });
    await assert.rejects(createCoordinator({ ...f, stopFile }).cycle());
    assert.deepEqual(JSON.parse(await readFile(stopFile)), {
      version: 1,
      reason: "ANCHOR_CONFLICT",
    });
    const restarted = fixture({ before: [] });
    await createCoordinator({ ...restarted, stopFile }).cycle();
    assert.equal(restarted.calls[0], "safety_stop");
    await assert.rejects(readFile(stopFile), (e) => e.code === "ENOENT");
  }));
test("Recovery fixture: postaccept contradiction stores stop before PostgreSQL outage", async () =>
  isolated(async (stopFile) => {
    const s = snapshot();
    s.outputs[0].canonical = false;
    const f = fixture({ before: [], accepted: true, sync: s, dbError: true });
    await assert.rejects(createCoordinator({ ...f, stopFile }).cycle());
    assert.equal(
      JSON.parse(await readFile(stopFile)).reason,
      "CANONICAL_CONTRADICTION",
    );
  }));
test("Recovery fixture: corrupt stop marker and stale/incomplete snapshot fail closed", async () =>
  isolated(async (stopFile) => {
    await writeFile(stopFile, '{"version":1}');
    const f = fixture();
    await assert.rejects(createCoordinator({ ...f, stopFile }).cycle(), {
      message: "WATCHER_UNAVAILABLE",
    });
    assert.equal(f.calls.length, 0);
    await rm(stopFile);
    for (const edit of [
      (s) => delete s.chain.verified_at,
      (s) => (s.chain.verified_at = "2000-01-01"),
      (s) => (s.chain.complete = false),
    ]) {
      const s = snapshot();
      edit(s);
      const invalid = fixture({ before: [], sync: s });
      await assert.rejects(
        createCoordinator({ ...invalid, stopFile }).cycle(),
        { message: "WATCHER_UNAVAILABLE" },
      );
      assert.ok(!invalid.calls.includes("snapshot"));
    }
    const s = snapshot();
    delete s.chain.verified_at;
    s.chain.verified_at_epoch = String(Math.floor(Date.now() / 1000));
    const valid = fixture({ before: [], sync: s });
    await createCoordinator({ ...valid, stopFile }).cycle();
    assert.ok(Number.isFinite(Date.parse(s.chain.verified_at)));
  }));
test("Real child process: missing wallet and CLI failures expose only sanitized diagnostics", async () => {
  await isolated(async (stopFile) => {
    const w = createWalletProcess({
      ...process.env,
      ZCASH_NETWORK: "testnet",
      WALLET_DB_PATH: join(stopFile, "missing.sqlite"),
      CHAIN_ENDPOINT: "https://synthetic.invalid",
    });
    try {
      await assert.rejects(w.request("observe", context), {
        message: "WATCHER_UNAVAILABLE",
      });
    } finally {
      w.close();
    }
  });
  const result = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve("services/watcher/main.mjs"), "--once"],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          PGPASSWORD: "must-not-leak",
          ZCASH_NETWORK: "mainnet",
        },
        windowsHide: true,
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", reject);
    child.on("close", (code) => done({ code, out, err }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(result.err, "Private testnet watcher unavailable\n");
});

test(
  "Real child process: invalid HTTPS URI fails offline with a sanitized sync frame",
  { timeout: 30000 },
  async () =>
    isolated(async (stopFile) => {
      const extension = process.platform === "win32" ? ".exe" : "";
      const executable = resolve(`target/debug/darkpool-zcash${extension}`);
      const wallet = stopFile + ".sqlite";
      const clean = walletEnvironment({
        ...process.env,
        ZCASH_NETWORK: "testnet",
        WALLET_DB_PATH: wallet,
        CHAIN_ENDPOINT: "https://127.0.0.1:1",
      });
      const run = (path, args, env, input) =>
        new Promise((done, reject) => {
          const child = spawn(path, args, { env, windowsHide: true });
          const out = [],
            err = [];
          child.stdout.on("data", (b) => out.push(b));
          child.stderr.on("data", (b) => err.push(b));
          child.on("error", () => reject(new Error("Test child unavailable")));
          child.stdin.on("error", () => {});
          child.on("close", (code) =>
            done({
              code,
              out: Buffer.concat(out),
              err: Buffer.concat(err).toString(),
            }),
          );
          child.stdin.end(input);
        });
      const created = await run(
        resolve(`target/debug/examples/issuance-fixture${extension}`),
        [wallet],
        { ...clean, DARKPOOL_SYNTHETIC_TEST: "1" },
      );
      assert.equal(created.code, 0);
      assert.equal(created.out.length, 0);
      assert.equal(created.err, "");
      const authority = randomBytes(32).toString("hex");
      const allocator = spawn(executable, ["serve-allocation"], {
        env: {
          ...clean,
          ALLOCATION_MARKET_ID: "tls-test",
          ALLOCATION_VAULT_CONTEXT: "tls-vault",
          ALLOCATION_AUTH: authority,
          ALLOCATION_PORT: "0",
        },
        windowsHide: true,
      });
      const closed = new Promise((done) => allocator.once("close", done));
      let allocatorErr = "";
      allocator.stderr.on("data", (b) => (allocatorErr += b));
      try {
        const port = await new Promise((done, reject) => {
          let out = "";
          const timer = setTimeout(
            () => reject(new Error("Test allocator timeout")),
            10000,
          );
          allocator.once("error", () => {
            clearTimeout(timer);
            reject(new Error("Test allocator unavailable"));
          });
          allocator.stdout.on("data", (b) => {
            out += b;
            const match = /127\.0\.0\.1:(\d+)/.exec(out);
            if (match) {
              clearTimeout(timer);
              done(match[1]);
            }
          });
        });
        await allocateInternal(
          {
            market_id: "tls-test",
            vault_context_ref: "tls-vault",
            ticket_id: "12".repeat(32),
            claim_commitment: "ab".repeat(32),
          },
          { ALLOCATION_PORT: port, ALLOCATION_AUTH: authority },
        );
      } finally {
        allocator.kill();
        await closed;
      }
      assert.equal(allocatorErr, "");
      const db = new DatabaseSync(wallet, { readOnly: true });
      const binding = db
        .prepare("SELECT account FROM ext_darkpool_context WHERE singleton=1")
        .get();
      db.close();
      // URL accepts/escapes a space, but tonic rejects the literal invalid URI
      // before connect. No socket, DNS or chain RPC is attempted. Rust's separate
      // fresh-process regression still exercises valid TLS connector construction.
      const endpoint = "https://127.0.0.1:1/invalid uri";
      const env = { ...clean, CHAIN_ENDPOINT: endpoint };
      const c = {
        network: "testnet",
        market_id: "tls-test",
        vault_context_ref: "tls-vault",
        account_ref: binding.account,
        endpoint_ref: endpoint,
        anchor_hash: "00".repeat(32),
        receipts: [],
        unmapped: [],
      };
      const result = await run(
        executable,
        ["serve-watcher"],
        env,
        Buffer.concat([
          encodeFrame({ operation: "observe", context: c }),
          encodeFrame({ operation: "sync", context: c }),
        ]),
      );
      assert.equal(result.code, 1); // An ordinary failure, never panic exit 101.
      assert.deepEqual(
        result.out,
        Buffer.concat([
          encodeFrame({ outputs: [] }),
          encodeFrame({ error: true }),
        ]),
      );
      assert.equal(result.err, "private testnet watcher unavailable\n");
      const diagnostics = [];
      const w = createWalletProcess(env, {
        write: (value) => diagnostics.push(value),
      });
      try {
        assert.deepEqual(await w.request("observe", c), { outputs: [] });
        await assert.rejects(w.request("sync", c), {
          message: "WATCHER_UNAVAILABLE",
        });
      } finally {
        await w.close();
      }
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].class, "TLS_CONNECT");
      assert.equal(diagnostics[0].stage, "TLS_CONNECT");
      assert.equal(diagnostics[0].guard, "OTHER");
      assert.equal(diagnostics[0].phase, "OTHER");
      assert.equal(diagnostics[0].exit_code, 1);
      assert.equal(diagnostics[0].valid_failure_frame, true);
      assert.equal(diagnostics[0].node_killed, false);
    }),
);

test("Diagnostics accept only bounded enums/numbers and drop all arbitrary strings", () => {
  const d = safeDiagnostic({
    class: "SECRET",
    stage: "SECRET",
    guard: "SECRET",
    phase: "SECRET",
    signal: "SECRET",
    grpc_code: 99,
    sqlite_code: -1,
    exit_code: Infinity,
    cache_bytes: Infinity,
    cache_blocks: -1,
    cached_range: { start: 9, end: 1 },
    ufvk: "SECRET",
    stderr: "SECRET",
    ticket_id: "SECRET",
  });
  assert.equal(d.class, "UNKNOWN");
  assert.equal(
    safeDiagnostic({ class: "HISTORY_LIMIT" }).class,
    "HISTORY_LIMIT",
  );
  assert.equal(d.stage, "IPC");
  assert.equal(d.guard, "OTHER");
  assert.equal(d.phase, "OTHER");
  assert.equal(d.grpc_code, null);
  assert.equal(safeDiagnostic(null).class, "UNKNOWN");
  assert.equal(
    safeDiagnostic({ exit_code: -1073741819 }).exit_code,
    -1073741819,
  );
  assert.equal(d.cached_range, null);
  assert.ok(!JSON.stringify(d).includes("SECRET"));
  assert.equal(
    walletEnvironment({
      ...process.env,
      ZCASH_NETWORK: "testnet",
      WALLET_DB_PATH: "synthetic",
      CHAIN_ENDPOINT: "https://synthetic.invalid",
      DARKPOOL_WATCHER_DIAGNOSTIC_IPC: "1",
      WATCHER_DIAGNOSTIC_PATH: "secret",
    }).DARKPOOL_WATCHER_DIAGNOSTIC_IPC,
    undefined,
  );
});
async function childFailure(script, options = {}) {
  const records = [];
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const wallet = framedWalletProcess(
    child,
    { write: (value) => records.push(value) },
    options.timers,
  );
  try {
    if (options.prepare) await options.prepare(child);
    const request = wallet.request(options.operation ?? "observe", {});
    if (options.afterRequest) await options.afterRequest(child);
    await assert.rejects(request, { message: "WATCHER_UNAVAILABLE" });
  } finally {
    await wallet.close();
  }
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records).includes("PRIVATE_SENTINEL"));
  return records[0];
}

test("Closed guard and phase fields survive private child IPC and reject arbitrary values", async () => {
  const guards = [
    "BLOCK_HEIGHT",
    "BLOCK_HASH_SHAPE",
    "BLOCK_PREV_HASH_SHAPE",
    "TIP_ADVERTISED_HASH",
    "OUTPUT_BLOCK_HASH",
    "OUTPUT_TX_INDEX",
    "OUTPUT_TX_ID",
    "FINAL_TIP_HEIGHT_CHANGED",
    "FINAL_TIP_HASH_CHANGED",
    "RECEIPT_CONTEXT",
    "CLOCK",
    "OTHER",
  ];
  const phases = [
    "INITIAL",
    "CHECKPOINT",
    "OUTPUT_INCLUSION",
    "FINAL_TIP",
    "OTHER",
  ];
  for (const guard of guards) {
    for (const phase of phases) {
      const d = safeDiagnostic({
        class: "CHAIN_VALIDATION",
        stage: "BLOCK",
        guard,
        phase,
        txid: "SECRET",
        error: "SECRET",
        endpoint_response: "SECRET",
      });
      assert.equal(d.guard, guard);
      assert.equal(d.phase, phase);
      assert.ok(!JSON.stringify(d).includes("SECRET"));
    }
  }
  for (const value of [undefined, null, "BLOCK", "UNKNOWN", {}, 7]) {
    const d = safeDiagnostic({ stage: "BLOCK", guard: value, phase: value });
    assert.equal(d.guard, "OTHER");
    assert.equal(d.phase, "OTHER");
  }
  const script = `process.stdin.once("data", () => {
    const b = Buffer.from(JSON.stringify({error:true,diagnostic:{class:"CHAIN_VALIDATION",stage:"BLOCK",guard:"CLOCK",phase:"FINAL_TIP",error:"SECRET",txid:"SECRET"}}));
    const n = Buffer.alloc(4); n.writeUInt32BE(b.length);
    process.stdout.write(Buffer.concat([n,b]), () => process.exit(1));
  });`;
  const record = await childFailure(script);
  assert.equal(record.guard, "CLOCK");
  assert.equal(record.phase, "FINAL_TIP");
  assert.equal(record.stage, "BLOCK");
  assert.ok(!JSON.stringify(record).includes("SECRET"));
});
const waitInput = "process.stdin.once('data',()=>{";
function requestClock(expectedDelay) {
  let now = 0,
    scheduled;
  return {
    timers: {
      setTimeout: (callback, delay) => {
        assert.equal(delay, expectedDelay);
        scheduled = { callback, at: now + delay };
        return 1;
      },
      clearTimeout: (id) => {
        assert.equal(id, 1);
        scheduled = undefined;
      },
    },
    advance: (milliseconds) => {
      now += milliseconds;
      if (scheduled && now >= scheduled.at) {
        const { callback } = scheduled;
        scheduled = undefined;
        callback();
      }
    },
    get pending() {
      return scheduled !== undefined;
    },
  };
}
test("Actual child: valid failure frame preserves natural Windows exit code and private class", async () => {
  const frame = encodeFrame({
    error: true,
    diagnostic: {
      class: "SCAN_ERROR",
      stage: "SCAN",
      secret: "PRIVATE_SENTINEL",
    },
  }).toString("hex");
  const d = await childFailure(
    `${waitInput}process.stderr.write('PRIVATE_SENTINEL');process.stdout.write(Buffer.from('${frame}','hex'),()=>process.exit(7));});`,
  );
  assert.equal(d.class, "SCAN_ERROR");
  assert.equal(d.exit_code, 7);
  assert.equal(d.valid_response_frame, true);
  assert.equal(d.valid_failure_frame, true);
  assert.equal(d.node_killed, false);
});
test("Actual child: exit 101 before a response frame remains distinguishable", async () => {
  const d = await childFailure(
    `${waitInput}process.stderr.write('PRIVATE_SENTINEL');process.exit(101);});`,
  );
  assert.equal(d.class, "CHILD_EXIT");
  assert.equal(d.exit_code, 101);
  assert.equal(d.valid_response_frame, false);
});
test("Actual child: truncated frame records IPC_FRAME and natural exit", async () => {
  const d = await childFailure(
    `${waitInput}process.stdout.write(Buffer.from([0,0,0,20,123]),()=>process.exit(23));});`,
  );
  assert.equal(d.class, "IPC_FRAME");
  assert.equal(d.exit_code, 23);
  assert.equal(d.valid_response_frame, false);
});
test("Actual child: malformed JSON frame is killed with bounded IPC evidence", async () => {
  const d = await childFailure(
    `${waitInput}process.stdout.write(Buffer.from([0,0,0,1,123]));});setInterval(()=>{},1000);`,
  );
  assert.equal(d.class, "IPC_FRAME");
  assert.equal(d.node_killed, true);
  assert.equal(d.valid_response_frame, false);
});
test("Actual child: oversized frame header is rejected before allocating its body", async () => {
  const d = await childFailure(
    `${waitInput}process.stdout.write(Buffer.from([0,64,0,1]));});setInterval(()=>{},1000);`,
  );
  assert.equal(d.class, "IPC_FRAME");
  assert.equal(d.node_killed, true);
});
test("Actual child: signal termination preserves the OS close signal", async () => {
  const d = await childFailure(
    "process.stdin.resume();setInterval(()=>{},1000);",
    {
      afterRequest: (child) => {
        child.kill("SIGTERM");
      },
    },
  );
  assert.equal(d.class, "CHILD_SIGNAL");
  assert.equal(d.signal, "SIGTERM");
  assert.equal(d.node_timeout, false);
});
test("Actual child: hung sync is killed exactly at the fixed 1800000ms deadline", async () => {
  const clock = requestClock(1_800_000);
  const d = await childFailure(
    "process.stdin.resume();setInterval(()=>{},1000);",
    {
      operation: "sync",
      timers: clock.timers,
      afterRequest: (child) => {
        clock.advance(1_799_999);
        assert.equal(clock.pending, true);
        assert.equal(child.killed, false);
        clock.advance(1);
        assert.equal(child.killed, true);
      },
    },
  );
  assert.equal(d.class, "NODE_TIMEOUT");
  assert.equal(d.stage, "IPC");
  assert.equal(d.node_timeout, true);
  assert.equal(d.node_killed, true);
  assert.equal(d.valid_response_frame, false);
  assert.equal(d.valid_failure_frame, false);
  assert.equal(d.signal, "SIGTERM");
  assert.equal(d.exit_code, null);
  assert.equal(d.grpc_code, null);
  assert.equal(d.sqlite_code, null);
  assert.equal(d.cached_range, null);
  assert.equal(d.cache_blocks, null);
  assert.equal(d.cache_bytes, null);
  assert.equal(clock.pending, false);
});
test("Actual child: sync can finish after 300s but before 30min and cancels its timer", async () => {
  const clock = requestClock(1_800_000);
  const response = { outputs: [], chain: { complete: true } };
  const frame = encodeFrame(response).toString("hex");
  const records = [];
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${waitInput}process.stderr.write('PRIVATE_SENTINEL');process.stdout.write(Buffer.from('${frame}','hex'));});setInterval(()=>{},1000);`,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const wallet = framedWalletProcess(
    child,
    { write: (value) => records.push(value) },
    clock.timers,
  );
  try {
    const request = wallet.request("sync", {});
    clock.advance(300_001);
    assert.equal(child.killed, false);
    clock.advance(1_499_998);
    assert.equal(clock.pending, true);
    assert.equal(child.killed, false);
    assert.deepEqual(await request, response);
    assert.equal(clock.pending, false);
    clock.advance(1);
    assert.equal(child.killed, false);
  } finally {
    await wallet.close();
  }
  assert.deepEqual(records, []);
});
test("Actual child: observation still expires exactly at the shorter 10000ms deadline", async () => {
  const clock = requestClock(10_000);
  const d = await childFailure(
    "process.stdin.resume();setInterval(()=>{},1000);",
    {
      timers: clock.timers,
      afterRequest: (child) => {
        clock.advance(9_999);
        assert.equal(child.killed, false);
        clock.advance(1);
        assert.equal(child.killed, true);
      },
    },
  );
  assert.equal(d.class, "NODE_TIMEOUT");
  assert.equal(d.stage, "IPC");
  assert.equal(d.node_timeout, true);
  assert.equal(d.node_killed, true);
  assert.equal(d.signal, "SIGTERM");
});
test("Actual child: hanging sync failure frame retains its stage until the 30min timeout", async () => {
  const clock = requestClock(1_800_000);
  const frame = encodeFrame({
    error: true,
    diagnostic: {
      class: "SCAN_ERROR",
      stage: "SCAN",
      secret: "PRIVATE_SENTINEL",
    },
  }).toString("hex");
  const d = await childFailure(
    `${waitInput}process.stdout.write(Buffer.from('${frame}','hex'));});setInterval(()=>{},1000);`,
    {
      operation: "sync",
      timers: clock.timers,
      afterRequest: (child) =>
        new Promise((done) =>
          child.stdout.once("data", () => {
            clock.advance(1_799_999);
            assert.equal(child.killed, false);
            clock.advance(1);
            done();
          }),
        ),
    },
  );
  assert.equal(d.class, "NODE_TIMEOUT");
  assert.equal(d.stage, "SCAN");
  assert.equal(d.node_timeout, true);
  assert.equal(d.node_killed, true);
  assert.equal(d.valid_response_frame, true);
  assert.equal(d.valid_failure_frame, true);
  assert.equal(d.signal, "SIGTERM");
  assert.equal(d.grpc_code, null);
  assert.equal(d.sqlite_code, null);
});
test("Actual child: a closed stdin is classified as IPC failure", async () => {
  const d = await childFailure("setInterval(()=>{},1000);", {
    prepare: (child) => child.stdin.end(),
  });
  assert.equal(d.class, "IPC_ERROR");
  assert.equal(d.valid_response_frame, false);
});
test("Actual child: unexpected exit between requests preserves its code", async () => {
  const frame = encodeFrame({ outputs: [] }).toString("hex");
  const records = [];
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${waitInput}process.stdout.write(Buffer.from('${frame}','hex'),()=>process.exit(42));});`,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise((done) => child.once("close", done));
  const wallet = framedWalletProcess(child, {
    write: (value) => records.push(value),
  });
  try {
    assert.deepEqual(await wallet.request("observe", {}), { outputs: [] });
    await closed;
    await assert.rejects(wallet.request("sync", {}), {
      message: "WATCHER_UNAVAILABLE",
    });
  } finally {
    await wallet.close();
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].class, "CHILD_EXIT");
  assert.equal(records[0].exit_code, 42);
  assert.equal(records[0].valid_response_frame, true);
});
test("Actual child: a hanging failure frame keeps the unchanged observation deadline", async () => {
  const frame = encodeFrame({
    error: true,
    diagnostic: { class: "SCAN_ERROR", stage: "SCAN" },
  }).toString("hex");
  let fire;
  const timers = {
    setTimeout: (f, delay) => {
      assert.equal(delay, 10000);
      fire = f;
      return 1;
    },
    clearTimeout: () => {},
  };
  const d = await childFailure(
    `${waitInput}process.stdout.write(Buffer.from('${frame}','hex'));});setInterval(()=>{},1000);`,
    {
      timers,
      afterRequest: (child) =>
        new Promise((done) =>
          child.stdout.once("data", () => {
            fire();
            done();
          }),
        ),
    },
  );
  assert.equal(d.class, "NODE_TIMEOUT");
  assert.equal(d.node_timeout, true);
  assert.equal(d.valid_failure_frame, true);
  assert.equal(d.valid_response_frame, true);
});
test("Protected diagnostic path refuses a repository path and a broad Windows DACL", async () => {
  await assert.rejects(
    protectedDiagnosticFile({
      ...process.env,
      WATCHER_DIAGNOSTIC_PATH: resolve("diagnostic.json"),
    }),
  );
  const root = join(process.env.LOCALAPPDATA, "ZcashDarkPoolDev", "phase9");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "synthetic-diagnostic-"));
  try {
    await assert.rejects(
      protectedDiagnosticFile({
        ...process.env,
        WATCHER_DIAGNOSTIC_PATH: join(directory, "failure.json"),
      }),
    );
  } finally {
    assert.equal(
      resolve(directory).startsWith(resolve(root) + "\\synthetic-diagnostic-"),
      true,
    );
    await rm(directory, { recursive: true, force: true });
  }
});
test("Protected Windows evidence file persists only sanitized metadata and refuses overwrite", async () => {
  const root = join(process.env.LOCALAPPDATA, "ZcashDarkPoolDev", "phase9");
  const directory = await mkdtemp(join(root, "synthetic-diagnostic-"));
  const target = join(directory, "failure.json");
  try {
    const acl = String.raw`$ErrorActionPreference='Stop';$p=$env:DARKPOOL_TEST_DIAGNOSTIC;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$s=New-Object System.Security.Principal.SecurityIdentifier($id);$r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $a`;
    execFileSync(
      join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(acl, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          DARKPOOL_TEST_DIAGNOSTIC: directory,
        },
        stdio: "pipe",
      },
    );
    const file = await protectedDiagnosticFile({
      ...process.env,
      WATCHER_DIAGNOSTIC_PATH: target,
    });
    try {
      await file.write({
        class: "CACHE_LIMIT",
        stage: "CACHE_INSERT",
        cache_blocks: 8200,
        cache_bytes: 664200,
        ufvk: "PRIVATE_SENTINEL",
      });
      await file.write({ class: "UNKNOWN" });
    } finally {
      await file.close();
    }
    const data = JSON.parse(await readFile(target, "utf8"));
    assert.equal(data.class, "CACHE_LIMIT");
    assert.ok(!JSON.stringify(data).includes("PRIVATE_SENTINEL"));
    await assert.rejects(
      protectedDiagnosticFile({
        ...process.env,
        WATCHER_DIAGNOSTIC_PATH: target,
      }),
    );
  } finally {
    assert.equal(
      resolve(directory).startsWith(resolve(root) + "\\synthetic-diagnostic-"),
      true,
    );
    await rm(directory, { recursive: true, force: true });
  }
});

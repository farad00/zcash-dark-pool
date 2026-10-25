// Tooling-only synthetic evidence. Does not import or execute any application suite.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  rm,
  rmdir,
  realpath,
  lstat,
  symlink,
  unlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  ROOT,
  MANIFEST,
  NODE_FILES,
  EXCLUDED_RUST,
  REQUIREMENTS,
  sha256,
  nodeInventory,
  rustInventory,
  validateManifest,
  parseTap,
  parseRust,
  reportEvidence,
  writeExclusive,
} from "./phase9-focused.mjs";

import { syntheticProof } from "./phase9-focused-completion-v2-fixtures.mjs";

const manifest = JSON.parse(await readFile(join(ROOT, MANIFEST), "utf8"));
const digest = sha256(await readFile(join(ROOT, MANIFEST)));
const copy = (v) => structuredClone(v);
const source = {
  revision: "a".repeat(40),
  dirty_worktree_sha256: "b".repeat(64),
};
const hash = "c".repeat(64);
let directory, evidence;

function tap(names, change = {}) {
  const states = names.map((n) => change[n] ?? "PASS");
  const count = (s) => states.filter((x) => x === s).length;
  return [
    "TAP version 13",
    ...names.flatMap((name, i) => [
      "# Subtest: " + name,
      (states[i] === "FAIL" ? "not ok " : "ok ") +
        (i + 1) +
        " - " +
        name +
        (states[i] === "NOT RUN" ? " # SKIP synthetic" : ""),
      "  ---",
      "  duration_ms: 0.1",
      "  ...",
    ]),
    "1.." + names.length,
    "# tests " + names.length,
    "# suites 0",
    "# pass " + count("PASS"),
    "# fail " + count("FAIL"),
    "# cancelled 0",
    "# skipped " + count("NOT RUN"),
    "# todo 0",
    "# duration_ms 1",
    "",
  ].join("\n");
}
function rust(names, change = {}) {
  const state = (n) => change[n] ?? "PASS";
  const count = (s) => names.filter((n) => state(n) === s).length;
  return [
    "running " + names.length + " tests",
    ...names.map(
      (n) =>
        "test " +
        n +
        " ... " +
        { PASS: "ok", FAIL: "FAILED", "NOT RUN": "ignored" }[state(n)],
    ),
    "test result: " +
      (count("FAIL") ? "FAILED" : "ok") +
      ". " +
      count("PASS") +
      " passed; " +
      count("FAIL") +
      " failed; " +
      count("NOT RUN") +
      " ignored; 0 measured; " +
      (72 - names.length) +
      " filtered out; finished in 0.01s",
    "",
  ].join("\n");
}
async function report(value, m = manifest) {
  return reportEvidence(m, value, {
    evidenceRoot: directory,
    currentSource: source,
  });
}
before(async () => {
  const tools = await realpath(join(ROOT, ".tools"));
  directory = await mkdtemp(join(tools, "phase9-focused-offline-"));
  const identity = (policy, pid, port) => ({
    ...policy,
    pid,
    port,
    process_start_utc: "2026-10-18T01:00:00Z",
    path_sha256: hash,
    executable_sha256: hash,
    profile_sha256: hash,
    marker_sha256: hash,
    evidence_class: "native-file-observation",
  });
  const environments = {
    test: identity(manifest.environment_policy.test, 24984, 55433),
    old_live: identity(manifest.environment_policy.old_live, 22968, 55434),
    historical: { sql_connections: 0, lifecycle_actions: 0 },
    v2: { exists: false, listener: false, created: false },
  };
  const inventory = Object.fromEntries(
    Object.entries(manifest.preservation_groups).map(([name, count]) => [
      name,
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => ["synthetic-file-" + i, hash]),
      ),
    ]),
  );
  evidence = {
    version: 1,
    evidence_class: "offline-fixture",
    manifest_sha256: digest,
    source_before: source,
    source_after: source,
    execution_environment: {
      DARKPOOL_PG_ENV: "TEST",
      DARKPOOL_TEST_ONLY: "TEST_ONLY",
      DARKPOOL_LIVE_INSTANCE: null,
      ZCASH_NETWORK: "testnet",
      PGHOST: "127.0.0.1",
      PGPORT: "55433",
      PGUSER: "darkpool_test_maintenance",
      PGDATABASE: "postgres",
      libpq_overrides: [],
    },
    environments: { before: environments, after: copy(environments) },
    preservation: { before: inventory, after: copy(inventory) },
    stages: [],
  };
  for (let i = 0; i < manifest.stages.length; i++) {
    const s = manifest.stages[i];
    const output =
      s.kind === "build"
        ? "synthetic compile-only capture\n"
        : s.kind === "node-tap"
          ? tap(s.expected_tests)
          : rust(s.expected_tests);
    await writeFile(join(directory, s.id + ".stdout"), output, { flag: "wx" });
    await writeFile(
      join(directory, s.id + ".stderr"),
      "synthetic stderr must not escape\n",
      { flag: "wx" },
    );
    const start = new Date(Date.UTC(2026, 9, 19, 0, 0, i * 3)).toISOString();
    const zero = new Date(Date.UTC(2026, 9, 19, 0, 0, i * 3 + 1)).toISOString();
    const end = new Date(Date.UTC(2026, 9, 19, 0, 0, i * 3 + 2)).toISOString();
    const native = await syntheticProof({
      command: s.command,
      pid: 10000 + i,
      start,
      exit: start,
      zero,
    });
    const nativeBytes = JSON.stringify(native);
    await writeFile(join(directory, s.id + ".native.json"), nativeBytes, {
      flag: "wx",
    });
    evidence.stages.push({
      id: s.id,
      command: s.command,
      started_utc: start,
      ended_utc: end,
      exit_code: 0,
      stdout: { path: s.id + ".stdout", sha256: sha256(output) },
      stderr: {
        path: s.id + ".stderr",
        sha256: sha256("synthetic stderr must not escape\n"),
      },
      ownership: {
        ...native,
        evidence_path: s.id + ".native.json",
        evidence_sha256: sha256(nativeBytes),
      },
    });
  }
});
after(async () => {
  const actual = await realpath(directory),
    tools = await realpath(join(ROOT, ".tools"));
  assert.equal(dirname(actual), tools);
  assert.ok(actual.startsWith(join(tools, "phase9-focused-offline-")));
  assert.equal((await lstat(actual)).isSymbolicLink(), false);
  await rm(actual, { recursive: true });
});

test("static manifest includes exact current existing suites and all 12 payment requirements", async () => {
  assert.deepEqual(await validateManifest(manifest), {
    stages: 37,
    tests: 342,
    rust_tests: 66,
    node_files: 22,
  });
  assert.equal(NODE_FILES.length, 22);
  assert.equal(REQUIREMENTS.length, 12);
  assert.equal((await rustInventory()).length, 72);
  assert.equal(EXCLUDED_RUST.length, 6);
});
test("static Node inventory expands only literal registrations and finite name loops without executing bodies", () => {
  assert.deepEqual(
    nodeInventory(
      'import test from "node:test"; for(const [name,ignored] of [["one",()=>{throw 1}],["two",()=>{}]]) test(`case ${name}`,()=>{throw Error("NEVER RUN")});',
    ),
    ["case one", "case two"],
  );
  assert.throws(
    () => nodeInventory("test(computeName(),()=>{});"),
    /E_DYNAMIC_TEST_NAME/,
  );
  assert.throws(
    () => nodeInventory('test("same",()=>{});test("same",()=>{});'),
    /E_TEST_INVENTORY/,
  );
  assert.throws(
    () => nodeInventory("for(const n of external) test(n,()=>{});"),
    /E_DYNAMIC_TEST_LOOP/,
  );
});
for (const [name, edit] of [
  ["missing requirement", (m) => m.requirements.pop()],
  [
    "missing payment-critical file",
    (m) =>
      m.stages.splice(
        m.stages.findIndex((s) => s.source_file === "db/test/watcher.test.mjs"),
        1,
      ),
  ],
  [
    "missing exact Node test identity",
    (m) => m.stages.find((s) => s.kind === "node-tap").expected_tests.pop(),
  ],
  [
    "duplicate expected identity",
    (m) => {
      const s = m.stages.find((s) => s.kind === "node-tap");
      s.expected_tests.push(s.expected_tests[0]);
    },
  ],
  [
    "unexpected command argument",
    (m) =>
      m.stages
        .find((s) => s.kind === "node-tap")
        .command.push("--test-name-pattern=only-one"),
  ],
  ["dependency gap", (m) => (m.stages[3].depends_on = [])],
  [
    "source checksum drift",
    (m) => (m.source_pins["Cargo.lock"] = "0".repeat(64)),
  ],
  [
    "reclassifying a required Rust test as excluded",
    (m) =>
      (m.excluded_rust[0].identity =
        "watcher::tests::maintained_ironwood_receiver_scan_restart_and_reorg"),
  ],
  [
    "V2 auto authorization",
    (m) => (m.environment_policy.live_authorization = true),
  ],
  [
    "weakened preservation inventory",
    (m) => (m.preservation_groups.historical_database = 0),
  ],
])
  test("manifest rejects " + name, async () => {
    const m = copy(manifest);
    edit(m);
    await assert.rejects(validateManifest(m));
  });

test("strict TAP validates identities and final per-test accounting", () => {
  assert.equal(parseTap(tap(["alpha", "beta"]), ["alpha", "beta"]).pass, true);
  assert.equal(
    parseTap(tap(["alpha"], { alpha: "FAIL" }), ["alpha"]).pass,
    false,
  );
  assert.equal(
    parseTap(tap(["alpha"], { alpha: "NOT RUN" }), ["alpha"]).cases[0].status,
    "NOT RUN",
  );
});
for (const [name, edit] of [
  ["missing identity", (s) => s.replace("ok 2 - beta", "# missing")],
  ["duplicate identity", (s) => s.replaceAll("beta", "alpha")],
  ["unexpected identity", (s) => s.replaceAll("beta", "unknown")],
  ["forged aggregate PASS", (s) => s.replace("# pass 2", "# pass 99")],
  ["missing final plan", (s) => s.replace("1..2", "")],
  ["duplicate summary", (s) => s + "# pass 2\n"],
  ["truncated diagnostics", (s) => s + "  ---\n"],
  ["nested tests outside supported grammar", (s) => s + "    ok 1 - nested\n"],
  ["unrecognized TAP output", (s) => s + "UNRECOGNIZED\n"],
])
  test("TAP rejects " + name, () =>
    assert.throws(() =>
      parseTap(edit(tap(["alpha", "beta"])), ["alpha", "beta"]),
    ),
  );
test("Rust parser preserves failure/ignored states and accepts known long-running notice", () => {
  const names = ["watcher::tests::one", "watcher::tests::two"];
  assert.equal(
    parseRust(
      rust(names).replace(
        "test watcher",
        "test watcher::tests::one has been running for over 60 seconds\ntest watcher",
      ),
      names,
    ).pass,
    true,
  );
  assert.equal(
    parseRust(rust(names, { [names[1]]: "FAIL" }), names).pass,
    false,
  );
  assert.equal(
    parseRust(rust(names, { [names[1]]: "NOT RUN" }), names).cases[1].status,
    "NOT RUN",
  );
});
for (const [name, edit] of [
  ["missing completion", (s) => s.replace("test two ... ok", "")],
  [
    "duplicate completion",
    (s) => s.replace("test two ... ok", "test one ... ok"),
  ],
  [
    "unexpected completion",
    (s) => s.replace("test two ... ok", "test unknown ... ok"),
  ],
  [
    "wrong filtered count",
    (s) => s.replace("70 filtered out", "0 filtered out"),
  ],
  ["wrong completed count", (s) => s.replace("2 passed", "99 passed")],
  ["truncated summary", (s) => s.split("test result:")[0]],
  [
    "failure-section noise beside a forged success summary",
    (s) => s.replace("test result:", "failures:\ncontradiction\ntest result:"),
  ],
  [
    "unknown progress notice",
    (s) =>
      s.replace(
        "running 2 tests",
        "running 2 tests\ntest unknown has been running for over 60 seconds",
      ),
  ],
])
  test("Rust rejects " + name, () =>
    assert.throws(() => parseRust(edit(rust(["one", "two"])), ["one", "two"])),
  );

test("synthetic complete evidence exercises all reporting paths without promoting application readiness", async () => {
  const r = await report(evidence);
  assert.equal(r.status, "PASS");
  assert.equal(r.actual.tests_executed, 342);
  assert.equal(r.coverage_complete, true);
  assert.equal(r.application_validation_pass, false);
  assert.equal(r.evidence_class, "offline-fixture");
  assert.equal(r.live_authorized, false);
  assert.equal(r.v2_authorized, false);
  assert.equal(r.complete_gate, "BLOCKED_UNCHANGED");
  assert.ok(!JSON.stringify(r).includes("synthetic stderr must not escape"));
});
test("an empty plan reports every expected test NOT RUN, never PASS", async () => {
  const e = {
    ...copy(evidence),
    evidence_class: "plan-only",
    execution_environment: null,
    environments: null,
    preservation: null,
    stages: [],
  };
  const r = await report(e);
  assert.equal(r.status, "NOT RUN");
  assert.equal(r.actual.tests_executed, 0);
  assert.equal(r.actual.not_run, 342);
  assert.equal(r.application_validation_pass, false);
});
test("partial valid evidence reports unexecuted suffix explicitly", async () => {
  const e = copy(evidence);
  e.stages = e.stages.slice(0, 4);
  const r = await report(e);
  assert.equal(r.status, "NOT RUN");
  assert.equal(r.actual.tests_executed, 8);
  assert.equal(r.actual.not_run, 334);
  assert.equal(r.first_failure, null);
});
for (const [name, edit] of [
  ["missing version", (e) => delete e.version],
  [
    "unknown secret-bearing field",
    (e) => (e.claim_secret = "SYNTHETIC_SENTINEL"),
  ],
  ["manifest hash mismatch", (e) => (e.manifest_sha256 = "0".repeat(64))],
  [
    "changed dirty worktree",
    (e) => (e.source_after.dirty_worktree_sha256 = "0".repeat(64)),
  ],
  ["changed revision", (e) => (e.source_after.revision = "0".repeat(40))],
  [
    "wrong TEST cluster",
    (e) => (e.environments.before.test.system_identifier = "0"),
  ],
  ["retargeted OLD LIVE", (e) => (e.environments.after.old_live.port = 55435)],
  ["V2 created", (e) => (e.environments.after.v2.exists = true)],
  [
    "HISTORICAL SQL",
    (e) => (e.environments.before.historical.sql_connections = 1),
  ],
  [
    "LIVE execution selection",
    (e) => (e.execution_environment.DARKPOOL_PG_ENV = "LIVE_EVIDENCE"),
  ],
  [
    "missing TEST acknowledgement",
    (e) => (e.execution_environment.DARKPOOL_TEST_ONLY = null),
  ],
  [
    "wrong credential identity",
    (e) => (e.execution_environment.PGUSER = "darkpool_live_watch"),
  ],
  [
    "inherited libpq override",
    (e) => (e.execution_environment.libpq_overrides = ["PGOPTIONS"]),
  ],
  [
    "protected file mutation",
    (e) =>
      (e.preservation.after.old_live_wallet_evidence["synthetic-file-0"] =
        "0".repeat(64)),
  ],
  [
    "protected file removal",
    (e) => delete e.preservation.after.historical_database["synthetic-file-0"],
  ],
  [
    "missing preservation group",
    (e) => delete e.preservation.after.private_snapshots,
  ],
  ["stage command mismatch", (e) => (e.stages[0].command = ["node", "evil"])],
  ["stage out of order", (e) => e.stages.reverse()],
  ["root exit alone", (e) => delete e.stages[0].ownership],
  ["nonzero descendants", (e) => (e.stages[0].ownership.active_processes = 1)],
  [
    "failed native query",
    (e) => (e.stages[0].ownership.query_succeeded = false),
  ],
  [
    "missing root exit",
    (e) => (e.stages[0].ownership.root_exit_observed = false),
  ],
  [
    "zero query before root exit",
    (e) => (e.stages[0].ownership.root_exit_utc = e.stages[0].ended_utc),
  ],
  [
    "missing owned process identities",
    (e) => (e.stages[0].ownership.historical.identities = []),
  ],
  [
    "ownership query outside stage",
    (e) => (e.stages[0].ownership.zero_query_utc = "2020-01-01T00:00:00Z"),
  ],
  [
    "missing native artifact",
    (e) => (e.stages[0].ownership.evidence_path = "absent.json"),
  ],
  [
    "wrong native artifact hash",
    (e) => (e.stages[0].ownership.evidence_sha256 = "0".repeat(64)),
  ],
  ["stderr hash mismatch", (e) => (e.stages[0].stderr.sha256 = "0".repeat(64))],
  ["traversal log", (e) => (e.stages[0].stdout.path = "../outside")],
  ["absolute log", (e) => (e.stages[0].stdout.path = "C:/secret")],
  [
    "overlapping stages",
    (e) => (e.stages[1].started_utc = e.stages[0].started_utc),
  ],
  [
    "application source override",
    (e) => (e.evidence_class = "application-evidence"),
  ],
])
  test("report fails closed on " + name, async () => {
    const e = copy(evidence);
    edit(e);
    const r = await report(e);
    assert.equal(r.status, "FAIL");
    assert.equal(r.application_validation_pass, false);
    assert.ok(r.first_failure);
    assert.ok(!JSON.stringify(r).includes("SYNTHETIC_SENTINEL"));
  });
test("nonzero exit stops coverage even with success-looking stdout; suffix cannot run", async () => {
  const e = copy(evidence);
  e.stages[0].exit_code = 7;
  e.stages[0].ownership.root_exit_code = 7;
  e.stages[0].ownership.historical.identities[0].exit_code = 7;
  const own = e.stages[0].ownership;
  const bytes = JSON.stringify(
    Object.fromEntries(
      Object.entries(own).filter(
        ([k]) => !["evidence_path", "evidence_sha256"].includes(k),
      ),
    ),
  );
  await writeFile(join(directory, "nonzero.native.json"), bytes, {
    flag: "wx",
  });
  own.evidence_path = "nonzero.native.json";
  own.evidence_sha256 = sha256(bytes);
  const r = await report(e);
  assert.equal(r.status, "FAIL");
  assert.equal(r.first_failure.stage, manifest.stages[0].id);
  assert.equal(r.actual.stages_executed, 1);
  assert.equal(r.actual.tests_executed, 0);
  assert.equal(r.actual.not_run, 342);
});
test("TAP skipped test is NOT RUN and makes its stage FAIL; no later stage is accepted", async () => {
  const e = copy(evidence);
  e.stages = e.stages.slice(0, 4);
  const s = manifest.stages[3],
    text = tap(s.expected_tests, { [s.expected_tests[0]]: "NOT RUN" });
  const file = "skipped.stdout";
  await writeFile(join(directory, file), text, { flag: "wx" });
  e.stages[3].stdout = { path: file, sha256: sha256(text) };
  const r = await report(e);
  assert.equal(r.status, "FAIL");
  assert.equal(r.stages[3].cases[0].status, "NOT RUN");
  assert.equal(r.actual.pass, 7);
  assert.equal(r.first_failure.stage, s.id);
});
test("malformed evidence still yields a closed FAIL with all tests NOT RUN", async () => {
  const r = await report(null);
  assert.equal(r.status, "FAIL");
  assert.equal(r.actual.tests_executed, 0);
  assert.equal(r.actual.not_run, 342);
});
test("malformed executed suite reports unknown execution count rather than an invented zero", async () => {
  const e = copy(evidence);
  e.stages = e.stages.slice(0, 4);
  await writeFile(join(directory, "truncated.stdout"), "TAP version 13\n", {
    flag: "wx",
  });
  e.stages[3].stdout = {
    path: "truncated.stdout",
    sha256: sha256("TAP version 13\n"),
  };
  const r = await report(e);
  assert.equal(r.status, "FAIL");
  assert.equal(r.actual.tests_executed, null);
  assert.equal(r.actual.tests_execution_known, false);
  assert.equal(r.stages[4].status, "NOT RUN");
});
test("unknown fields do not leak raw evidence or diagnostics and key order is irrelevant", async () => {
  const e = copy(evidence);
  e.execution_environment = Object.fromEntries(
    Object.entries(e.execution_environment).reverse(),
  );
  const r = await report(e);
  assert.equal(r.status, "PASS");
  assert.equal(r.application_validation_pass, false);
  assert.ok(!JSON.stringify(r).includes("synthetic stderr must not escape"));
});
test("bounded file reader rejects oversized logs before decoding", async () => {
  const file = "oversized.stdout";
  await writeFile(join(directory, file), Buffer.alloc(16777217), {
    flag: "wx",
  });
  const e = copy(evidence);
  e.stages = e.stages.slice(0, 1);
  e.stages[0].stdout = { path: file, sha256: hash };
  const r = await report(e);
  assert.equal(r.status, "FAIL");
  assert.equal(r.first_failure.code, "E_SIZE");
});
test("reporter CLI writes NOT RUN for plan and FAIL for malformed evidence without running a suite", async () => {
  const run1 = ".tools/phase9-focused/run-" + randomUUID().replaceAll("-", "");
  const run2 = ".tools/phase9-focused/run-" + randomUUID().replaceAll("-", "");
  const file = join(directory, "malformed.json");
  await writeFile(file, '{"claim_secret":"NEVER_ECHO",', { flag: "wx" });
  const cli = join(ROOT, "scripts/validation/phase9-focused.mjs");
  const invoke = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
  try {
    const plan = invoke(["plan", run1 + "/report.json"]);
    assert.equal(plan.status, 2, plan.stderr);
    const p = JSON.parse(
      await readFile(join(ROOT, run1, "report.json"), "utf8"),
    );
    assert.equal(p.status, "NOT RUN");
    assert.equal(p.actual.not_run, 342);
    assert.equal(p.actual.tests_executed, 0);
    assert.match(p.source.revision, /^[a-f0-9]{40}$/);
    assert.match(p.source.dirty_worktree_sha256, /^[a-f0-9]{64}$/);
    const relativeFile = file.slice(ROOT.length + 1).replaceAll("\\", "/");
    const bad = invoke(["report", relativeFile, run2 + "/report.json"]);
    assert.equal(bad.status, 1);
    const b = await readFile(join(ROOT, run2, "report.json"), "utf8");
    assert.equal(JSON.parse(b).status, "FAIL");
    assert.ok(!b.includes("NEVER_ECHO"));
    assert.ok(!bad.stdout.includes("NEVER_ECHO"));
    assert.ok(!bad.stderr.includes("NEVER_ECHO"));
    const collision = invoke(["plan", run1 + "/report.json"]);
    assert.equal(collision.status, 1);
    assert.equal(
      JSON.parse(await readFile(join(ROOT, run1, "report.json"), "utf8"))
        .status,
      "NOT RUN",
    );
  } finally {
    for (const run of [run1, run2]) {
      const actual = await realpath(join(ROOT, run));
      assert.equal(
        dirname(actual),
        await realpath(join(ROOT, ".tools/phase9-focused")),
      );
      assert.equal((await lstat(actual)).isSymbolicLink(), false);
      await rm(actual, { recursive: true });
    }
  }
});
test("log symlink cannot redirect reporter reads", async () => {
  const link = join(directory, "redirect");
  await symlink(directory, link, "junction");
  try {
    const e = copy(evidence);
    e.stages[0].stdout.path = "redirect/" + e.stages[0].stdout.path;
    const r = await report(e);
    assert.equal(r.status, "FAIL");
    assert.equal(r.first_failure.code, "E_REDIRECT");
  } finally {
    await unlink(link);
  }
});
test("output reserves a new exact namespace and cannot overwrite an old report or reuse an empty run", async () => {
  const run = ".tools/phase9-focused/run-" + randomUUID().replaceAll("-", "");
  const out = run + "/report.json";
  try {
    await writeExclusive(ROOT, out, {
      version: 1,
      evidence_class: "offline-fixture",
      status: "NOT RUN",
    });
    const saved = await readFile(join(ROOT, out));
    await assert.rejects(writeExclusive(ROOT, out, { status: "PASS" }));
    assert.deepEqual(await readFile(join(ROOT, out)), saved);
    for (const path of [
      ".tools/phase9-review/new.json",
      "../outside/report.json",
      run + "/con.json",
      run + "/REPORT.JSON",
    ])
      await assert.rejects(writeExclusive(ROOT, path, {}));
  } finally {
    const actual = await realpath(join(ROOT, run));
    assert.equal(
      dirname(actual),
      await realpath(join(ROOT, ".tools/phase9-focused")),
    );
    assert.equal((await lstat(actual)).isSymbolicLink(), false);
    await rm(actual, { recursive: true });
  }
  const empty = ".tools/phase9-focused/run-" + randomUUID().replaceAll("-", "");
  await mkdir(join(ROOT, empty));
  try {
    await assert.rejects(writeExclusive(ROOT, empty + "/report.json", {}));
  } finally {
    const actual = await realpath(join(ROOT, empty));
    assert.equal(
      dirname(actual),
      await realpath(join(ROOT, ".tools/phase9-focused")),
    );
    assert.equal((await lstat(actual)).isSymbolicLink(), false);
    await rmdir(actual);
  }
});

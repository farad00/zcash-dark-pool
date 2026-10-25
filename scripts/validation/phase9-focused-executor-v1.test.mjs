// Offline tooling only. Requires retained observations from the disposable native fixture run.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ROOT, MANIFEST, sha256, reportEvidence } from "./phase9-focused.mjs";
import {
  approvedManifest,
  APPROVED_MANIFEST_SHA256,
  EXECUTION_ENVIRONMENT,
  cleanEnvironment,
  requireStage,
  verifyNative,
} from "./phase9-focused-executor-v1.mjs";

assert.ok(
  process.env.FOCUSED_OFFLINE_FIXTURES,
  "FOCUSED_OFFLINE_FIXTURES required; no silent skip",
);
const fixtureDir = path.resolve(ROOT, process.env.FOCUSED_OFFLINE_FIXTURES);
assert.ok(
  fixtureDir.startsWith(path.join(ROOT, ".tools", "phase9-focused") + path.sep),
);
const json = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const m = await approvedManifest(),
  trace = await json(path.join(fixtureDir, "success/native-trace.json"));
const good = await verifyNative(trace, path.join(fixtureDir, "success"));
const clone = (v) => structuredClone(v);
const source = {
    revision: "a".repeat(40),
    dirty_worktree_sha256: "b".repeat(64),
  },
  hash = "c".repeat(64);
const dir = path.join(
  ROOT,
  ".tools/phase9-focused/reporter-native-fixture-" +
    randomUUID().replaceAll("-", ""),
);
await fs.mkdir(dir);
const ownBytes = await fs.readFile(
  path.join(fixtureDir, "success/ownership.json"),
);
await fs.writeFile(path.join(dir, "ownership.json"), ownBytes, { flag: "wx" });
await fs.writeFile(path.join(dir, "stdout.log"), "offline process fixture\n", {
  flag: "wx",
});
await fs.writeFile(path.join(dir, "stderr.log"), "", { flag: "wx" });
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
  test: identity(m.environment_policy.test, 24984, 55433),
  old_live: identity(m.environment_policy.old_live, 22968, 55434),
  historical: { sql_connections: 0, lifecycle_actions: 0 },
  v2: { exists: false, listener: false, created: false },
};
const preservation = Object.fromEntries(
  Object.entries(m.preservation_groups).map(([g, n]) => [
    g,
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => ["fixture-" + i, hash]),
    ),
  ]),
);
// Only the ownership/timing observations are genuine native evidence here. Command,
// source, environment and preservation metadata are expressly SYNTHETIC offline scaffolding.
// This tests reporter import compatibility; it never asserts build-rust actually ran.
const envelope = {
  version: 1,
  evidence_class: "offline-fixture",
  manifest_sha256: APPROVED_MANIFEST_SHA256,
  source_before: source,
  source_after: source,
  execution_environment: EXECUTION_ENVIRONMENT,
  environments: { before: environments, after: environments },
  preservation: { before: preservation, after: preservation },
  stages: [
    {
      id: m.stages[0].id,
      command: m.stages[0].command,
      started_utc: trace.started_utc,
      ended_utc: trace.ended_utc,
      exit_code: trace.root_exit_code,
      stdout: {
        path: "stdout.log",
        sha256: sha256("offline process fixture\n"),
      },
      stderr: { path: "stderr.log", sha256: sha256("") },
      ownership: { ...good, evidence_path: "ownership.json" },
    },
  ],
};
const report = (e) =>
  reportEvidence(m, e, { evidenceRoot: dir, currentSource: source });

test("approved immutable inventory remains 66 Rust + 276 Node, 12 areas, 37 stages", () => {
  assert.equal(m.stages.length, 37);
  assert.equal(m.requirements.length, 12);
  assert.equal(
    m.stages
      .filter((s) => s.kind === "rust-libtest")
      .reduce((n, s) => n + s.expected_tests.length, 0),
    66,
  );
  assert.equal(
    m.stages
      .filter((s) => s.kind === "node-tap")
      .reduce((n, s) => n + s.expected_tests.length, 0),
    276,
  );
});
test("manifest byte digest remains approved", async () =>
  assert.equal(
    sha256(await fs.readFile(path.join(ROOT, MANIFEST))),
    APPROVED_MANIFEST_SHA256,
  ));
test("all exact commands can only advance in dependency order", () => {
  const done = [];
  for (let i = 0; i < m.stages.length; i++) {
    assert.deepEqual(
      requireStage(m, m.stages[i].id, i, done),
      m.stages[i].command,
    );
    done.push(m.stages[i].id);
  }
});
test("out-of-order stage and duplicate advance rejected", () => {
  assert.throws(() => requireStage(m, m.stages[1].id, 1, []), /STAGE_ORDER/);
  assert.throws(
    () => requireStage(m, m.stages[0].id, 0, [m.stages[0].id]),
    /STAGE_ORDER/,
  );
});
test("unknown command identity rejected", () =>
  assert.throws(
    () => requireStage(m, "arbitrary-command", 0, []),
    /STAGE_ORDER/,
  ));
test("inherited libpq, LIVE, wallet/network selectors removed", () =>
  assert.deepEqual(
    cleanEnvironment({
      PGPORT: "55434",
      PGSERVICE: "live",
      DARKPOOL_LIVE_INSTANCE: "v1",
      ZCASH_NETWORK: "mainnet",
      PATH: "ok",
      LOCALAPPDATA: "ok",
    }),
    { PATH: "ok", LOCALAPPDATA: "ok" },
  ));
test("CLI rejects arbitrary command arguments before spawning", () => {
  const p = spawnSync(
    process.execPath,
    ["scripts/validation/phase9-focused-executor-v1.mjs", "run", "cmd.exe"],
    { cwd: ROOT, encoding: "utf8", windowsHide: true },
  );
  assert.equal(p.status, 1);
  assert.match(p.stderr, /FAIL_CLOSED/);
});
test("genuine natural completion evidence passes executor verifier", async () =>
  assert.deepEqual(
    await verifyNative(trace, path.join(fixtureDir, "success")),
    good,
  ));
test("short-lived descendants have complete native identity reconciliation", async () => {
  const t = await json(
    path.join(fixtureDir, "short-descendant/native-trace.json"),
  );
  await verifyNative(t, path.join(fixtureDir, "short-descendant"));
  assert.ok(
    t.processes.some(
      (p) =>
        p.pid !== t.root_pid &&
        Date.parse(p.exit_utc) > Date.parse(t.root_exit_utc),
    ),
  );
});
test("nonzero root exit stays 17 and remains importable as failed execution", async () => {
  const t = await json(path.join(fixtureDir, "nonzero/native-trace.json"));
  await verifyNative(t, path.join(fixtureDir, "nonzero"));
  assert.equal(t.root_exit_code, 17);
  assert.equal(t.first_failure, "CHILD_EXIT_NONZERO");
});
for (const name of [
  "persistent-descendant",
  "query-failure",
  "pid-mismatch",
  "interrupt",
  "nonzero-descendant",
  "supervisor-exit",
])
  test(
    name + " cannot be presented as a completed successful stage",
    async () => {
      const t = await json(path.join(fixtureDir, name + "/native-trace.json"));
      await assert.rejects(() => verifyNative(t, path.join(fixtureDir, name)));
    },
  );
test("root failure 17 survives descendant cleanup failure path", async () => {
  const t = await json(
    path.join(fixtureDir, "nonzero-descendant/native-trace.json"),
  );
  assert.equal(t.root_exit_code, 17);
  assert.ok(t.termination_requested && t.cleanup_succeeded);
});
test("exact cmd wrapper quoting validated by non-application .cmd fixture", async () => {
  const t = await json(path.join(fixtureDir, "cmd-quoting/native-trace.json"));
  await verifyNative(t, path.join(fixtureDir, "cmd-quoting"));
  assert.equal(t.root_exit_code, 0);
});
for (const [name, mutate] of [
  [
    "missing creation time",
    (t) => {
      delete t.processes[0].creation_filetime;
    },
  ],
  [
    "creation time mismatch",
    (t) => {
      t.processes[0].creation_filetime = String(
        BigInt(t.processes[0].creation_filetime) + 10000n,
      );
    },
  ],
  [
    "duplicate PID",
    (t) => {
      t.processes.push(t.processes[0]);
      t.total_processes++;
    },
  ],
  [
    "missing handle binding",
    (t) => {
      delete t.processes[0].handle_binding;
    },
  ],
  [
    "unobserved zero",
    (t) => {
      t.zero_observed = false;
    },
  ],
  [
    "failed cleanup",
    (t) => {
      t.cleanup_succeeded = false;
    },
  ],
  [
    "fabricated root exit code",
    (t) => {
      t.root_exit_code = 18;
    },
  ],
  [
    "missing ownership",
    (t) => {
      t.ownership = null;
    },
  ],
])
  test("native verifier rejects " + name, async () => {
    const t = clone(trace);
    mutate(t);
    await assert.rejects(() =>
      verifyNative(t, path.join(fixtureDir, "success")),
    );
  });
test("reporter accepts genuine ownership projection inside explicitly synthetic offline envelope", async () => {
  const r = await report(envelope);
  assert.equal(r.stages[0].status, "PASS");
  assert.equal(r.first_failure, null);
  assert.equal(r.actual.stages_executed, 1);
  assert.equal(r.status, "NOT RUN");
  assert.equal(r.application_validation_pass, false);
  assert.equal(r.actual.tests_executed, 0);
});
for (const [name, mutate] of [
  [
    "missing zero query",
    (e) => {
      delete e.stages[0].ownership.zero_query_utc;
    },
  ],
  [
    "fabricated active-zero claim",
    (e) => {
      e.stages[0].ownership.active_processes = 1;
    },
  ],
  [
    "fabricated process identity",
    (e) => {
      e.stages[0].ownership.root_pid += 1;
    },
  ],
  [
    "unobserved completion",
    (e) => {
      e.stages[0].ownership.root_exit_observed = false;
    },
  ],
  [
    "tampered native digest",
    (e) => {
      e.stages[0].ownership.evidence_sha256 = "0".repeat(64);
    },
  ],
  [
    "missing environment identity",
    (e) => {
      delete e.environments.before.test.process_start_utc;
    },
  ],
  [
    "missing preservation",
    (e) => {
      e.preservation = null;
    },
  ],
])
  test("unchanged reporter rejects " + name, async () => {
    const e = clone(envelope);
    mutate(e);
    const r = await report(e);
    assert.equal(r.status, "FAIL");
    assert.ok(r.first_failure);
    assert.equal(r.application_validation_pass, false);
  });
test("empty executed prefix never becomes PASS", async () => {
  const e = clone(envelope);
  e.stages = [];
  const r = await report(e);
  assert.equal(r.status, "NOT RUN");
  assert.equal(r.application_validation_pass, false);
});
test("fixture-native evidence cannot claim application pass", async () => {
  const r = await report(envelope);
  assert.equal(r.live_authorized, false);
  assert.equal(r.v2_authorized, false);
  assert.equal(r.complete_gate, "BLOCKED_UNCHANGED");
});

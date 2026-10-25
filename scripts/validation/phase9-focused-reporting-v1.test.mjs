// OFFLINE ONLY: execute the actual reporting control flow in an isolated VM.
// launchStage/observe/Git/source are synthetic adapters. No process launcher is supplied.
// All retained bundles are offline-fixture; synthetic counts NEVER establish application PASS.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import * as reporter from "./phase9-focused.mjs";
import {
  approvedManifest,
  APPROVED_MANIFEST_SHA256,
  EXECUTION_ENVIRONMENT,
  requireStage,
  verifyNative,
} from "./phase9-focused-executor-v1.mjs";

import { syntheticProof } from "./phase9-focused-completion-v3-fixtures.mjs";

const { ROOT, MANIFEST, sha256, reportEvidence, writeExclusive } = reporter;
const m = await approvedManifest();
const source = {
  revision: "a".repeat(40),
  dirty_worktree_sha256: "b".repeat(64),
};
const hash = "c".repeat(64);
const executorPath = "scripts/validation/phase9-focused-executor-v1.mjs";
const executorText = await fs.readFile(path.join(ROOT, executorPath), "utf8");
function ast(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}
function declaration(file, text, name) {
  const tree = ast(file, text);
  const node = tree.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert.ok(node, "actual declaration exists: " + name);
  return node.getText(tree).replace(/^export\s+/, "");
}
const executeCode = declaration(executorPath, executorText, "execute");
const exclusiveCode = declaration(executorPath, executorText, "exclusive");
// Reuse existing pure TAP/libtest renderers, without importing any test registration/body.
const fixtureText = await fs.readFile(
  path.join(ROOT, "scripts/validation/phase9-focused.test.mjs"),
  "utf8",
);
const render = Object.fromEntries(
  ["tap", "rust"].map((name) => [
    name,
    vm.runInNewContext("(" + declaration("fixtures", fixtureText, name) + ")"),
  ]),
);
const clone = (v) => structuredClone(v);
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
const observation = {
  environments: {
    test: identity(m.environment_policy.test, 24984, 55433),
    old_live: identity(m.environment_policy.old_live, 22968, 55434),
    historical: { sql_connections: 0, lifecycle_actions: 0 },
    v2: { exists: false, listener: false, created: false },
  },
  preservation: Object.fromEntries(
    Object.entries(m.preservation_groups).map(([group, count]) => [
      group,
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => ["synthetic-" + i, hash]),
      ),
    ]),
  ),
  supervisor: { pid: 9999, creation_filetime: "1" },
};
const retained = [];

async function harness(options = {}) {
  const id = randomUUID().replaceAll("-", "");
  const dir = path.join(ROOT, ".tools/phase9-focused/executor-v1-" + id);
  const destination = `.tools/phase9-focused/run-${id}/report.json`;
  const events = new EventEmitter();
  let observeCount = 0,
    finalizing = false;
  const state = {
    id,
    dir,
    destination,
    launched: [],
    reports: [],
    messages: [],
    nativeVerified: 0,
  };
  retained.push(state);
  const fixedFs = {
    ...fs,
    mkdir: async (p, ...args) => {
      await fs.mkdir(p, ...args);
      if (p === dir)
        await fs.writeFile(
          path.join(dir, "OFFLINE_SYNTHETIC_ONLY.json"),
          JSON.stringify({
            evidence_class: "offline-fixture",
            application_commands_launched: 0,
          }),
          { flag: "wx" },
        );
    },
  };
  const actualExclusive = vm.runInNewContext("(" + exclusiveCode + ")", {
    fs: fixedFs,
    JSON,
  });
  const actualOrdinary = vm.runInNewContext(
    "(" + declaration(executorPath, executorText, "ordinary") + ")",
    {
      fs: fixedFs,
      path,
      demand: (value, code) => {
        if (!value) throw Error(code);
      },
    },
  );
  const exclusive = async (file, value) => {
    let saved = clone(value);
    if (path.basename(file) === "bundle.json") {
      finalizing = true;
      if (saved) saved.evidence_class = "offline-fixture";
    }
    await actualExclusive(file, saved);
  };
  const launchStage = async (stageId, stageDir) => {
    state.launched.push(stageId);
    const index = m.stages.findIndex((s) => s.id === stageId),
      spec = m.stages[index];
    if (options.missingNative === stageId) return { code: 0, signal: null };
    const failed = options.failedStage === stageId,
      exit = failed ? 17 : 0;
    const start = new Date(
      Date.UTC(2026, 9, 19, 0, 0, index * 4),
    ).toISOString();
    const rootExit = new Date(Date.parse(start) + 1000).toISOString(),
      zero = new Date(Date.parse(start) + 2000).toISOString(),
      end = new Date(Date.parse(start) + 3000).toISOString();
    const pid = 10000 + index;
    const ownership = await syntheticProof({
      command: spec.command,
      pid,
      start,
      exit: rootExit,
      zero,
      end,
      code: exit,
    });
    const trace = {
      version: 3,
      ordering: ownership.ordering,
      evidence_class: "application-native",
      started_utc: start,
      ended_utc: end,
      first_failure: failed ? "CHILD_EXIT_NONZERO" : null,
      root_pid: pid,
      root_creation_filetime: ownership.root_creation_filetime,
      root_exit_code: exit,
      root_exit_utc: rootExit,
      assigned_before_resume: true,
      root_exit_observed: true,
      zero_observed: true,
      cleanup_succeeded: true,
      termination_requested: false,
      tree_completion_verified: true,
      identity_inventory_complete: true,
      total_processes: 1,
      processes: ownership.historical.identities,
      accounting: ownership.accounting,
      launch: ownership.launch,
      containment: ownership.containment,
      command: spec.command,
      ownership,
    };
    if (options.auditReverse) {
      const i = ownership.historical.identities[0];
      i.observed_utc = new Date(Date.parse(i.creation_utc) - 1).toISOString();
      ownership.ordering.events.find(
        (e) => e.kind === "bind",
      ).details.observed_utc = i.observed_utc;
    }
    if (options.missingOwnership === stageId) {
      trace.ownership = null;
      trace.identity_inventory_complete = false;
    }
    const states =
      failed && spec.expected_tests.length
        ? { [spec.expected_tests[0]]: "FAIL" }
        : {};
    const stdout =
      spec.kind === "build"
        ? "synthetic build capture\n"
        : render[spec.kind === "node-tap" ? "tap" : "rust"](
            spec.expected_tests,
            states,
          );
    for (const [name, value] of [
      ["native-trace.json", JSON.stringify(trace)],
      ["stdout.log", stdout],
      ["stderr.log", ""],
    ])
      await fs.writeFile(path.join(stageDir, name), value, { flag: "wx" });
    if (trace.ownership)
      await fs.writeFile(
        path.join(stageDir, "ownership.json"),
        JSON.stringify(ownership),
        { flag: "wx" },
      );
    return {
      code: exit,
      signal: null,
      worker_pid: ownership.ordering.observer_pid,
    };
  };
  const context = {
    ROOT,
    MANIFEST,
    APPROVED_MANIFEST_SHA256,
    EXECUTION_ENVIRONMENT,
    fs: fixedFs,
    path,
    randomUUID: () => id,
    approvedManifest: async () => {
      if (options.manifestFailure) throw Error("UNAPPROVED_MANIFEST");
      return m;
    },
    captureSource: async () => {
      if (options.sourceFailure) throw Error("SOURCE_INVENTORY_UNAVAILABLE");
      return clone(source);
    },
    observe: async () => {
      observeCount++;
      if (options.preflightFailure && observeCount === 1)
        throw Error("NATIVE_IDENTITY");
      if (options.prefixFailure && observeCount === 2)
        throw Error("NATIVE_OBSERVATION_LOST");
      const value = clone(observation);
      if (
        options.finalPreservationChange &&
        observeCount === m.stages.length + 2
      )
        value.preservation.bearer_backup["synthetic-0"] = "d".repeat(64);
      return value;
    },
    exclusive,
    reportEvidence: async (manifest, evidence, settings) => {
      let value = clone(evidence);
      if (value) value.evidence_class = "offline-fixture";
      if (value?.stages.length >= 2 && options.corrupt) options.corrupt(value);
      if (options.malformedFinal && finalizing) value = { version: 1 };
      const result = await reportEvidence(manifest, value, {
        ...settings,
        currentSource: source,
      });
      assert.equal(
        result.application_validation_pass,
        false,
        "synthetic evidence never application PASS",
      );
      state.reports.push(clone(result));
      return result;
    },
    runFile: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(Array.from(args), ["diff", "--cached", "--binary"]);
      return { stdout: "" };
    },
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    demand: (v, code) => {
      if (!v) throw Error(code);
    },
    requireStage,
    launchStage,
    ordinary: actualOrdinary,
    readJson: async (file) => JSON.parse(await fs.readFile(file, "utf8")),
    verifyNative: async (...args) => {
      const value = await verifyNative(...args);
      state.nativeVerified++;
      return value;
    },
    sha256,
    writeExclusive,
    AbortController,
    process: {
      pid: 9999,
      env: {},
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    },
    console: { log: (s) => state.messages.push(JSON.parse(s)) },
  };
  // The only executable supplied to this VM is the executor function itself; all launch/observation adapters above are inert synthetic file writers.
  state.exit = await vm.runInNewContext("(" + executeCode + ")", context)();
  state.report = JSON.parse(
    await fs.readFile(path.join(ROOT, destination), "utf8"),
  );
  state.result = JSON.parse(
    await fs.readFile(path.join(dir, "executor-result.json"), "utf8"),
  );
  state.observeCount = observeCount;
  return state;
}

test("every writeExclusive call supplies root, destination and actual report data", async () => {
  for (const file of [
    "phase9-focused.mjs",
    "phase9-focused-executor-v1.mjs",
    "phase9-focused.test.mjs",
    "phase9-focused-reporting-v1.test.mjs",
  ]) {
    const text = await fs.readFile(
        path.join(ROOT, "scripts/validation", file),
        "utf8",
      ),
      tree = ast(file, text);
    let count = 0;
    function visit(n) {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "writeExclusive"
      ) {
        count++;
        assert.equal(n.arguments.length, 3, file + " argument count");
        assert.equal(
          n.arguments[0].getText(tree),
          "ROOT",
          file + " root semantics",
        );
        const destination = n.arguments[1].getText(tree),
          data = n.arguments[2].getText(tree);
        assert.notEqual(
          destination,
          data,
          file + " report cannot be destination",
        );
        if (file === "phase9-focused-executor-v1.mjs") {
          assert.match(destination, /\.tools\/phase9-focused\/run-/);
          assert.equal(data, "report");
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(tree);
    assert.ok(count > 0, file + " inspected calls");
  }
});
test("actual executor reporting lifecycle writes a complete synthetic final report exclusively", async () => {
  const h = await harness();
  assert.equal(h.launched.length, 37);
  assert.equal(h.nativeVerified, 37);
  assert.equal(h.observeCount, 39);
  assert.equal(h.report.status, "PASS");
  assert.equal(h.report.evidence_class, "offline-fixture");
  assert.equal(h.report.application_validation_pass, false);
  assert.equal(h.report.actual.tests_executed, 342);
  assert.equal(h.report.actual.pass, 342);
  assert.equal(h.report.actual.fail, 0);
  assert.equal(h.report.actual.not_run, 0);
  for (const [kind, count] of [
    ["rust-libtest", 66],
    ["node-tap", 276],
  ])
    assert.equal(
      h.report.stages
        .filter((s) => m.stages.find((x) => x.id === s.id).kind === kind)
        .reduce((n, s) => n + s.cases.length, 0),
      count,
    );
  assert.equal(h.result.exit_code, h.exit);
  assert.notEqual(
    h.exit,
    0,
    "offline evidence cannot exit application success",
  );
  for (const stage of h.report.stages)
    assert.equal(stage.ownership.active_processes, 0);
  assert.equal(h.report.preservation.status, "PASS");
  assert.equal(h.report.live_authorized, false);
  assert.equal(h.report.v2_authorized, false);
});
for (const [option, reason] of [
  ["manifestFailure", "UNAPPROVED_MANIFEST"],
  ["sourceFailure", "SOURCE_INVENTORY_UNAVAILABLE"],
  ["preflightFailure", "NATIVE_IDENTITY"],
])
  test(
    option +
      " is written with zero stage attempts and no invented native evidence",
    async () => {
      const h = await harness({ [option]: true });
      assert.equal(h.exit, 1);
      assert.deepEqual(h.launched, []);
      assert.equal(h.report.status, "FAIL");
      assert.equal(h.report.first_failure.code, "E_EXECUTOR_PREFLIGHT");
      assert.equal(h.report.actual.tests_executed, 0);
      assert.equal(h.report.actual.not_run, 342);
      assert.equal(h.result.first_failure, reason);
      assert.equal(h.report.environments, null);
      assert.equal(h.report.preservation.status, "NOT RUN");
    },
  );
const nodeStage = m.stages.find((s) => s.kind === "node-tap");
test("failed stage preserves exit 17, exact TAP failure count and stops advancement", async () => {
  const h = await harness({ failedStage: nodeStage.id });
  assert.equal(h.exit, 17);
  assert.equal(h.result.exit_code, 17);
  assert.equal(h.report.status, "FAIL");
  assert.equal(h.launched.length, 4);
  assert.equal(h.report.actual.tests_executed, nodeStage.expected_tests.length);
  assert.equal(h.report.actual.fail, 1);
  assert.equal(h.report.actual.pass, nodeStage.expected_tests.length - 1);
  assert.equal(h.report.first_failure.code, "E_STAGE_FAILED");
});
for (const option of ["missingNative", "missingOwnership"])
  test(option + " cannot disappear into an accepted prefix", async () => {
    const h = await harness({ [option]: nodeStage.id });
    assert.notEqual(h.exit, 0);
    assert.equal(h.launched.length, 4);
    assert.equal(h.report.status, "FAIL");
    assert.ok(h.report.first_failure);
    assert.equal(h.report.application_validation_pass, false);
    assert.equal(h.report.actual.tests_execution_known, false);
    assert.equal(h.report.actual.tests_executed, null);
  });
test("final preservation mismatch propagates reporter failure and consistent nonzero exit", async () => {
  const h = await harness({ finalPreservationChange: true });
  assert.equal(h.report.status, "FAIL");
  assert.ok(h.report.first_failure);
  assert.equal(h.result.first_failure, h.report.first_failure.code);
  assert.equal(h.result.exit_code, h.exit);
  assert.equal(h.exit, 1);
  assert.equal(h.report.application_validation_pass, false);
});
test("an earlier observation failure cannot be cleared by later good observations", async () => {
  const h = await harness({ prefixFailure: true });
  assert.equal(h.launched.length, 1);
  assert.equal(h.report.status, "FAIL");
  assert.equal(h.report.first_failure.code, "E_EXECUTOR_FAILURE");
  assert.equal(h.result.first_failure, "NATIVE_OBSERVATION_LOST");
  assert.equal(h.report.application_validation_pass, false);
});
test("malformed evidence produces a persisted FAIL report", async () => {
  const h = await harness({
    malformedFinal: true,
    failedStage: m.stages[0].id,
  });
  assert.equal(h.report.status, "FAIL");
  assert.ok(h.report.first_failure);
  assert.equal(h.report.application_validation_pass, false);
  assert.notEqual(h.exit, 0);
});
test("duplicate report path is rejected and the retained report bytes never change", async () => {
  const h = retained.find((h) => h.report);
  assert.ok(h);
  const file = path.join(ROOT, h.destination),
    before = await fs.readFile(file);
  await assert.rejects(
    writeExclusive(ROOT, h.destination, {
      status: "FAIL",
      evidence_class: "offline-fixture",
    }),
    { code: "EEXIST" },
  );
  assert.deepEqual(await fs.readFile(file), before);
});
test("historical destinations are rejected before any overwrite", async () => {
  const file = path.join(ROOT, "docs/PHASE9_RESULTS.md"),
    before = sha256(await fs.readFile(file));
  await assert.rejects(
    writeExclusive(ROOT, "docs/PHASE9_RESULTS.md", { status: "FAIL" }),
    /E_OUTPUT_NAMESPACE/,
  );
  assert.equal(sha256(await fs.readFile(file)), before);
});

for (const [name, corrupt] of [
  ["missing handoff", (v) => (v.stages.at(-1).handoff = null)],
  ["wrong worker identity", (v) => v.stages.at(-1).handoff.worker.pid++],
  [
    "missing predecessor acceptance",
    (v) => (v.stages.at(-1).handoff.previous = null),
  ],
  [
    "wrong predecessor digest",
    (v) => (v.stages.at(-1).handoff.previous.ownership_sha256 = "a".repeat(64)),
  ],
  [
    "wrong prefix digest",
    (v) => (v.stages.at(-1).handoff.previous.prefix_sha256 = "a".repeat(64)),
  ],
  [
    "wrong prefix path",
    (v) => (v.stages.at(-1).handoff.previous.prefix_path = "missing.json"),
  ],
  [
    "wrong persisted request",
    (v) => (v.stages.at(-1).handoff.request_sha256 = "a".repeat(64)),
  ],
  [
    "missing persisted request",
    (v) => (v.stages.at(-1).handoff.request_path = "missing.json"),
  ],
  ["missing native journal", (v) => delete v.stages.at(-1).ownership.ordering],
  [
    "wrong completion contract",
    (v) => (v.stages.at(-1).ownership.contract_version = 2),
  ],
]) {
  test(
    "v3 lifecycle rejects " + name + " and stops before next stage",
    async () => {
      const h = await harness({ corrupt });
      assert.equal(h.launched.length, 2);
      assert.equal(h.report.status, "FAIL");
      assert.equal(h.report.application_validation_pass, false);
      assert.ok(h.report.first_failure);
    },
  );
}

test("reporter exposes UTC reversal with accepted v3 causal proof", async () => {
  const h = await harness({ auditReverse: true, failedStage: m.stages[1].id });
  assert.equal(h.report.stages[0].status, "PASS");
  assert.ok(
    h.report.stages[0].utc_anomalies.some(
      (a) => a.kind === "observation_before_creation",
    ),
  );
  assert.equal(h.launched.length, 2);
  assert.equal(h.report.application_validation_pass, false);
});

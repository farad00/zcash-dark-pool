// OFFLINE ONLY. Genuine disposable native traces plus explicitly synthetic negative evidence.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, sha256, reportEvidence } from "./phase9-focused.mjs";
import {
  approvedManifest,
  verifyNative,
} from "./phase9-focused-executor-v1.mjs";
import { validateCompletionProof } from "./phase9-focused-completion-v2.mjs";
import { syntheticProof } from "./phase9-focused-completion-v2-fixtures.mjs";
assert.ok(
  process.env.FOCUSED_OFFLINE_FIXTURES,
  "native fixture evidence is required; never skip",
);
const base = path.resolve(ROOT, process.env.FOCUSED_OFFLINE_FIXTURES);
assert.ok(
  base.startsWith(path.join(ROOT, ".tools", "phase9-focused") + path.sep),
);
const read = (p) => fs.readFile(p, "utf8").then(JSON.parse);
const trace = await read(path.join(base, "success/native-trace.json"));
const incomplete = await read(
  path.join(base, "incomplete-history/native-trace.json"),
);
const m = await approvedManifest();
const clone = structuredClone;

test("1: complete native history plus zero verifies completion", async () => {
  const p = await verifyNative(trace, path.join(base, "success"));
  assert.equal(p.tree_completion_verified, true);
  assert.equal(p.historical.inventory_complete, true);
});
test("2: genuine incomplete native fixture completes with honest measured counts", async () => {
  const p = await verifyNative(
    incomplete,
    path.join(base, "incomplete-history"),
  );
  assert.equal(p.historical.lifetime_process_count, incomplete.total_processes);
  assert.equal(
    p.historical.retained_process_identities,
    incomplete.processes.length,
  );
  assert.equal(
    p.historical.missing_identity_count,
    incomplete.total_processes - incomplete.processes.length,
  );
  assert.ok(p.historical.missing_identity_count >= 4);
  assert.equal(p.historical.inventory_complete, false);
  assert.equal(p.tree_completion_verified, true);
  assert.equal(incomplete.termination_requested, false);
});
test("95 lifetime / 91 retained is representable as explicitly synthetic incomplete history", () => {
  const p = clone(trace.ownership),
    root = p.historical.identities.find(
      (i) =>
        i.pid === p.root_pid &&
        i.creation_filetime === p.root_creation_filetime,
    );
  p.historical.identities = [
    clone(root),
    ...Array.from({ length: 90 }, (_, n) => ({
      ...clone(root),
      pid: 50000 + n,
    })),
  ];
  Object.assign(p.historical, {
    lifetime_process_count: 95,
    retained_process_identities: 91,
    missing_identity_count: 4,
    inventory_complete: false,
  });
  p.accounting.forEach((q) => (q.total_processes = 95));
  validateCompletionProof(p);
  assert.equal(p.historical.inventory_complete, false);
  // This representation is not passed off as an observed native fixture or application run.
});
for (const [name, mode] of [
  ["3: nonzero active processes cannot advance", "persistent-descendant"],
  ["4: genuine accounting-query failure cannot advance", "query-failure"],
  ["5: genuine assignment failure cannot advance", "assignment-failure"],
  ["6: breakaway readback cannot advance", "breakaway"],
  ["10: forced cleanup cannot advance", "interrupt"],
  ["14: native PID/creation mismatch cannot advance", "pid-mismatch"],
])
  test(name, async () => {
    const t = await read(path.join(base, mode, "native-trace.json"));
    await assert.rejects(() => verifyNative(t, path.join(base, mode)));
    assert.ok(t.first_failure);
    if (mode === "persistent-descendant")
      assert.ok(t.accounting.some((q) => q.active_processes > 0));
  });

for (const [name, edit] of [
  ["7: root identity mismatch", (p) => p.root_pid++],
  ["8: root exit missing", (p) => (p.root_exit_observed = false)],
  ["9: unexpected root exit code", (p) => (p.root_exit_code = 23)],
  ["11: missing containment evidence", (p) => delete p.containment],
  [
    "13: claimed zero contradicting native accounting",
    (p) => p.accounting.forEach((q) => (q.active_processes = 1)),
  ],
  [
    "14: PID and creation timestamp disagree",
    (p) =>
      (p.historical.identities[0].creation_filetime = String(
        BigInt(p.historical.identities[0].creation_filetime) + 1n,
      )),
  ],
  [
    "15: retained history exceeds native lifetime",
    (p) =>
      (p.historical.lifetime_process_count =
        p.historical.retained_process_identities - 1),
  ],
  [
    "missing same-job-handle continuity",
    (p) => (p.containment.same_job_handle = false),
  ],
  [
    "breakaway advertised in projection",
    (p) => (p.containment.job_flags |= 0x800),
  ],
  ["wrong loaded root image", (p) => (p.launch.image_path = "C:/wrong.exe")],
  [
    "wrong native launch arguments",
    (p) => p.launch.arguments.push("unexpected"),
  ],
  [
    "wrong native command line",
    (p) => (p.launch.command_line += " unexpected"),
  ],
  [
    "unapproved broker policy",
    (p) => (p.launch.policy = "uncontained-external-broker"),
  ],
  [
    "missing script digest",
    (p) => (p.launch.inputs = [{ path: "C:/script.mjs" }]),
  ],
  ["incorrect missing count", (p) => (p.historical.missing_identity_count = 4)],
  [
    "incomplete history falsely labeled complete",
    (p) => {
      p.historical.lifetime_process_count++;
      p.historical.missing_identity_count = 1;
    },
  ],
  [
    "duplicate PID/creation identity",
    (p) => {
      p.historical.identities.push(clone(p.historical.identities[0]));
      p.historical.retained_process_identities++;
      p.historical.lifetime_process_count++;
    },
  ],
  ["failed cleanup", (p) => (p.cleanup_succeeded = false)],
  ["executor-forced termination", (p) => (p.termination_requested = true)],
  ["legacy proof has no automatic upgrade", (p) => (p.contract_version = 1)],
])
  test("proof rejects " + name, () => {
    const p = clone(trace.ownership);
    edit(p);
    assert.throws(() => validateCompletionProof(p));
  });

test("distinct creation identities sharing a PID are historical records, not deduplicated by PID", () => {
  const p = clone(trace.ownership),
    i = clone(p.historical.identities[0]);
  i.creation_utc = new Date(Date.parse(i.exit_utc) + 1).toISOString();
  i.creation_filetime = (
    (BigInt(Date.parse(i.creation_utc)) + 11644473600000n) *
    10000n
  ).toString();
  i.observed_utc = i.creation_utc;
  i.exit_utc = new Date(Date.parse(i.creation_utc) + 1).toISOString();
  p.zero_query_utc = new Date(
    Math.max(Date.parse(p.zero_query_utc) + 1, Date.parse(i.exit_utc) + 1),
  ).toISOString();
  p.historical.identities.push(i);
  p.historical.lifetime_process_count++;
  p.historical.retained_process_identities++;
  p.accounting.forEach((q) => {
    q.total_processes = p.historical.lifetime_process_count;
    if (q.purpose === "completion") q.observed_utc = p.zero_query_utc;
  });
  validateCompletionProof(p);
});

// Only process ownership/timing here are real. Environment/source/commands are synthetic scaffolding.
const source = {
    revision: "a".repeat(40),
    dirty_worktree_sha256: "b".repeat(64),
  },
  hash = "c".repeat(64);
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
      Array.from({ length: n }, (_, i) => ["offline-" + i, hash]),
    ),
  ]),
);
const execution_environment = {
  DARKPOOL_PG_ENV: "TEST",
  DARKPOOL_TEST_ONLY: "TEST_ONLY",
  DARKPOOL_LIVE_INSTANCE: null,
  ZCASH_NETWORK: "testnet",
  PGHOST: "127.0.0.1",
  PGPORT: "55433",
  PGUSER: "darkpool_test_maintenance",
  PGDATABASE: "postgres",
  libpq_overrides: [],
};
async function envelope(t) {
  const dir = path.join(
    ROOT,
    ".tools/phase9-focused/completion-v2-reporter-" +
      randomUUID().replaceAll("-", ""),
  );
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, "OFFLINE_SYNTHETIC_ONLY.json"),
    JSON.stringify({ application_commands_launched: 0 }),
    { flag: "wx" },
  );
  const own = await verifyNative(
    t,
    path.join(base, t === incomplete ? "incomplete-history" : "success"),
  );
  const bytes = JSON.stringify(t.ownership);
  await fs.writeFile(path.join(dir, "ownership.json"), bytes, { flag: "wx" });
  await fs.writeFile(path.join(dir, "stdout.log"), "offline fixture\n", {
    flag: "wx",
  });
  await fs.writeFile(path.join(dir, "stderr.log"), "", { flag: "wx" });
  return {
    dir,
    e: {
      version: 1,
      evidence_class: "offline-fixture",
      manifest_sha256: sha256(
        await fs.readFile(
          path.join(ROOT, "scripts/validation/phase9-focused-v1.json"),
        ),
      ),
      source_before: source,
      source_after: source,
      execution_environment,
      environments: { before: environments, after: environments },
      preservation: { before: preservation, after: preservation },
      stages: [
        {
          id: m.stages[0].id,
          command: m.stages[0].command,
          started_utc: t.started_utc,
          ended_utc: t.ended_utc,
          exit_code: t.root_exit_code,
          stdout: { path: "stdout.log", sha256: sha256("offline fixture\n") },
          stderr: { path: "stderr.log", sha256: sha256("") },
          ownership: {
            ...own,
            evidence_path: "ownership.json",
            evidence_sha256: sha256(bytes),
          },
        },
      ],
    },
  };
}
for (const [name, t] of [
  ["complete", trace],
  ["incomplete", incomplete],
])
  test(
    "reporter imports genuine " +
      name +
      " fixture completion without application PASS",
    async () => {
      const { dir, e } = await envelope(t),
        r = await reportEvidence(m, e, {
          evidenceRoot: dir,
          currentSource: source,
        });
      assert.equal(r.first_failure, null);
      assert.equal(r.stages[0].status, "PASS");
      assert.equal(
        r.stages[0].ownership.historical.inventory_complete,
        t.identity_inventory_complete,
      );
      assert.equal(r.status, "NOT RUN");
      assert.equal(r.application_validation_pass, false);
      assert.equal(r.actual.tests_executed, 0);
      assert.equal(r.actual.not_run, 342);
    },
  );
test("12: an executed stage missing a required test fails coverage", async () => {
  const { dir, e } = await envelope(incomplete);
  e.stages = [];
  for (let n = 0; n < 4; n++) {
    const spec = m.stages[n],
      start = new Date(Date.UTC(2026, 9, 19, 0, 0, n * 4)).toISOString(),
      exit = new Date(Date.parse(start) + 1000).toISOString(),
      zero = new Date(Date.parse(start) + 2000).toISOString(),
      end = new Date(Date.parse(start) + 3000).toISOString();
    const p = await syntheticProof({
      command: spec.command,
      pid: 40000 + n,
      start,
      exit,
      zero,
    });
    const names = spec.expected_tests.slice(1);
    const output =
      n === 3
        ? [
            "TAP version 13",
            ...names.flatMap((s, i) => [
              "# Subtest: " + s,
              "ok " + (i + 1) + " - " + s,
            ]),
            "1.." + names.length,
            "# tests " + names.length,
            "# suites 0",
            "# pass " + names.length,
            "# fail 0",
            "# cancelled 0",
            "# skipped 0",
            "# todo 0",
            "# duration_ms 1",
            "",
          ].join("\n")
        : "synthetic build\n";
    const bytes = JSON.stringify(p);
    await fs.writeFile(path.join(dir, n + ".json"), bytes, { flag: "wx" });
    await fs.writeFile(path.join(dir, n + ".log"), output, { flag: "wx" });
    e.stages.push({
      id: spec.id,
      command: spec.command,
      started_utc: start,
      ended_utc: end,
      exit_code: 0,
      stdout: { path: n + ".log", sha256: sha256(output) },
      stderr: { path: "stderr.log", sha256: sha256("") },
      ownership: {
        ...p,
        evidence_path: n + ".json",
        evidence_sha256: sha256(bytes),
      },
    });
  }
  const r = await reportEvidence(m, e, {
    evidenceRoot: dir,
    currentSource: source,
  });
  assert.equal(r.status, "FAIL");
  assert.equal(r.first_failure.stage, m.stages[3].id);
  assert.equal(r.coverage_complete, false);
  assert.equal(r.application_validation_pass, false);
});
test("13: fabricated zero projection fails artifact integrity", async () => {
  const { dir, e } = await envelope(trace);
  e.stages[0].ownership.zero_query_utc = new Date(
    Date.parse(e.stages[0].ownership.zero_query_utc) + 1,
  ).toISOString();
  e.stages[0].ownership.accounting.at(-1).observed_utc =
    e.stages[0].ownership.zero_query_utc;
  const r = await reportEvidence(m, e, {
    evidenceRoot: dir,
    currentSource: source,
  });
  assert.equal(r.status, "FAIL");
  assert.equal(r.application_validation_pass, false);
});
test("previous failed application run remains failed and immutable", async () => {
  const r = await read(
    path.join(
      ROOT,
      ".tools/phase9-focused/run-3621483f1a1746eea0217f61eeec04df/report.json",
    ),
  );
  assert.equal(r.status, "FAIL");
  assert.equal(r.application_validation_pass, false);
});

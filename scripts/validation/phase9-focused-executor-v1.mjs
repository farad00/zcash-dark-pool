// Dedicated focused-v1 executor. Import and `check` never launch application code.
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  ROOT,
  MANIFEST,
  sha256,
  validateManifest,
  captureSource,
  reportEvidence,
  writeExclusive,
} from "./phase9-focused.mjs";

import {
  validateCompletionProof,
  nativeTime,
  sameWindowsPath,
} from "./phase9-focused-completion-v2.mjs";
import { validateCompletionProof as validateCompletionV3 } from "./phase9-focused-completion-v3.mjs";

export const APPROVED_MANIFEST_SHA256 =
  "5e01a728d362c098303e63b27c7d578112a51a5986284e564d67ec0e049f3986";
export const EXECUTION_ENVIRONMENT = Object.freeze({
  DARKPOOL_PG_ENV: "TEST",
  DARKPOOL_TEST_ONLY: "TEST_ONLY",
  DARKPOOL_LIVE_INSTANCE: null,
  ZCASH_NETWORK: "testnet",
  PGHOST: "127.0.0.1",
  PGPORT: "55433",
  PGUSER: "darkpool_test_maintenance",
  PGDATABASE: "postgres",
  libpq_overrides: [],
});
const readJson = async (p) =>
  JSON.parse((await fs.readFile(p, "utf8")).replace(/^\uFEFF/, ""));
const runFile = promisify(execFile);
const powershell = path.join(
  process.env.SystemRoot ?? "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const psArgs = (file) => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  path.join(ROOT, "scripts/validation", file),
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const demand = (v, code) => {
  if (!v) throw Error(code);
};
async function exclusive(file, value) {
  const h = await fs.open(file, "wx");
  try {
    await h.writeFile(JSON.stringify(value, null, 2) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
}
export async function approvedManifest() {
  const b = await fs.readFile(path.join(ROOT, MANIFEST));
  demand(sha256(b) === APPROVED_MANIFEST_SHA256, "UNAPPROVED_MANIFEST");
  const m = JSON.parse(b);
  await validateManifest(m);
  return m;
}
export function cleanEnvironment(original) {
  return Object.fromEntries(
    Object.entries(original).filter(
      ([k]) => !/^(PG|DARKPOOL_|ZCASH_)/i.test(k),
    ),
  );
}
export function requireStage(m, id, index, completed) {
  demand(
    index === completed.length &&
      m.stages[index]?.id === id &&
      m.stages[index].depends_on.every((d) => completed.includes(d)),
    "STAGE_ORDER",
  );
  return [...m.stages[index].command];
}
async function ordinary(file) {
  const s = await fs.lstat(file);
  demand(s.isFile() && !s.isSymbolicLink(), "ORDINARY_FILE_REQUIRED");
  demand(
    path.resolve(await fs.realpath(file)).toLowerCase() ===
      path.resolve(file).toLowerCase(),
    "REDIRECTED_FILE",
  );
  return fs.readFile(file);
}
async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    demand(!e.isSymbolicLink(), "REDIRECTED_INVENTORY");
    if (e.isDirectory()) result.push(...(await walk(p)));
    else {
      demand(e.isFile(), "ORDINARY_INVENTORY");
      result.push(p);
    }
  }
  return result.sort();
}

// Fixed inherited inventories; no SQL and no whole-running-PG byte-identity claim.
export async function observe(m) {
  const { stdout } = await runFile(
    powershell,
    [
      ...psArgs("phase9-focused-observe-v1.ps1"),
      "-OwnerPid",
      String(process.pid),
    ],
    {
      cwd: ROOT,
      windowsHide: true,
      env: cleanEnvironment(process.env),
      maxBuffer: 1024 * 1024,
    },
  );
  const native = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  const base = path.join(process.env.LOCALAPPDATA, "ZcashDarkPoolDev"),
    environments = {};
  for (const [name, sub, pid, port] of [
    ["test", "postgres-test", 24984, 55433],
    ["old_live", "postgres-live-evidence/phase9_payment_v1", 22968, 55434],
  ]) {
    const dir = path.join(base, sub),
      data = path.join(dir, "data"),
      bytes = await ordinary(path.join(dir, "profile.json"));
    const profile = JSON.parse(bytes.toString().replace(/^\uFEFF/, "")),
      marker = await ordinary(path.join(dir, "cluster-marker.json"));
    const control = (await ordinary(path.join(data, "global/pg_control")))
      .readBigUInt64LE()
      .toString();
    const p = native.processes.find((v) => v.ProcessId === pid),
      policy = m.environment_policy[name];
    demand(
      p &&
        native.listeners.some(
          (v) =>
            v.LocalAddress === "127.0.0.1" &&
            v.LocalPort === port &&
            v.OwningProcess === pid,
        ),
      "NATIVE_IDENTITY",
    );
    demand(
      control === policy.system_identifier &&
        profile.system_identifier === control &&
        profile.cluster_id === policy.cluster_id &&
        profile.port === port &&
        path.resolve(profile.data_directory).toLowerCase() ===
          path.resolve(data).toLowerCase(),
      "PROFILE_IDENTITY",
    );
    demand(
      path.resolve(p.ExecutablePath).toLowerCase() ===
        path.join(ROOT, ".tools/pgsql/bin/postgres.exe").toLowerCase() &&
        p.CommandLine.replaceAll("\\", "/")
          .toLowerCase()
          .includes(data.replaceAll("\\", "/").toLowerCase()),
      "PROCESS_PATH_IDENTITY",
    );
    const ms = Number(/Date\(([0-9]+)\)/.exec(p.CreationDate)?.[1]);
    demand(Number.isFinite(ms), "PROCESS_CREATION_IDENTITY");
    environments[name] = {
      system_identifier: control,
      cluster_id: profile.cluster_id,
      port,
      pid,
      process_start_utc: new Date(ms).toISOString(),
      path_sha256: sha256(path.resolve(data).toLowerCase()),
      executable_sha256: sha256(await ordinary(p.ExecutablePath)),
      profile_sha256: sha256(bytes),
      marker_sha256: sha256(marker),
      evidence_class: "native-file-observation",
    };
  }
  let v2Exists = true;
  try {
    await fs.lstat(path.join(base, "postgres-live-evidence/phase9_payment_v2"));
  } catch (e) {
    if (e.code === "ENOENT") v2Exists = false;
    else throw e;
  }
  demand(
    !v2Exists && !native.listeners.some((v) => v.LocalPort === 55435),
    "V2_NOT_ABSENT",
  );
  environments.historical = { sql_connections: 0, lifecycle_actions: 0 };
  environments.v2 = { exists: false, listener: false, created: false };
  const prior = await readJson(
    path.join(ROOT, ".tools/phase9-review/r1-r2-gate-20261018-before.json"),
  );
  const snapshots = await readJson(
    path.join(
      ROOT,
      ".tools/phase9-review/pg-recovery-readiness-20261018-private-snapshot.json",
    ),
  );
  const groups = {
    historical_database: Object.keys(prior.historical_database),
    historical_artifacts: Object.keys(prior.historical_protected),
    old_live_wallet_evidence: Object.keys(prior.wallet),
    protected_pg: Object.keys(prior.pgProtected),
    private_snapshots: snapshots.files.map((v) => v.snapshot),
    bearer_backup: [
      "C:/Users/Admin/Downloads/ZcashDarkPoolBackup/darkpool-ticket-backup.json",
    ],
    test_profile_marker: [
      path.join(base, "postgres-test/profile.json"),
      path.join(base, "postgres-test/cluster-marker.json"),
    ],
    audit_support: await walk(path.join(ROOT, ".tools/phase9-review")),
  };
  // Detect added/removed historical and OLD LIVE evidence as well as changed bytes.
  for (const [group, dir] of [
    ["historical_database", "postgres/data/base/69680"],
    ["historical_artifacts", "phase9/manual_20261007_a"],
    ["old_live_wallet_evidence", "phase9/live_payment_v1"],
  ]) {
    const actual = (await walk(path.join(base, dir)))
      .map((p) => path.resolve(p).toLowerCase())
      .sort();
    demand(
      same(
        actual,
        groups[group].map((p) => path.resolve(p).toLowerCase()).sort(),
      ),
      "PROTECTED_FILE_SET",
    );
  }
  const preservation = {};
  for (const [group, files] of Object.entries(groups)) {
    demand(files.length === m.preservation_groups[group], "PRESERVATION_COUNT");
    preservation[group] = {};
    for (const file of [...files].sort())
      preservation[group][sha256(path.resolve(file).toLowerCase())] = sha256(
        await ordinary(file),
      );
  }
  return { environments, preservation, supervisor: native.supervisor };
}
export function quoteWindowsArgument(value) {
  let result = '"',
    slashes = 0;
  for (const c of value) {
    if (c === "\\") {
      slashes++;
      continue;
    }
    result += "\\".repeat(c === '"' ? slashes * 2 + 1 : slashes) + c;
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + '"';
}
export async function resolveApprovedLaunch(command) {
  const bytes = await fs.readFile(path.join(ROOT, MANIFEST));
  demand(sha256(bytes) === APPROVED_MANIFEST_SHA256, "UNAPPROVED_MANIFEST");
  const m = JSON.parse(bytes),
    spec = m.stages.find((s) => same(s.command, command));
  demand(spec, "NATIVE_COMMAND");
  const nodeDirs = (await fs.readdir(path.join(ROOT, ".tools"))).filter((n) =>
    /^node-.*-win-x64$/.test(n),
  );
  demand(nodeDirs.length === 1, "NODE_IDENTITY");
  const nodeDir = path.join(ROOT, ".tools", nodeDirs[0]);
  let executable,
    args = command.slice(1),
    inputs = [];
  if (command[0] === "cargo")
    executable = path.join(ROOT, ".tools/cargo/bin/cargo.exe");
  else if (command[0] === "node") {
    executable = path.join(nodeDir, "node.exe");
    inputs = [
      path.resolve(
        ROOT,
        command[1].startsWith("--") ? spec.source_file : command[1],
      ),
    ];
  } else if (command[0] === "npm.cmd") {
    executable = path.join(
      process.env.SystemRoot ?? "C:/Windows",
      "System32/cmd.exe",
    );
    inputs = [path.join(nodeDir, "npm.cmd")];
    args = [
      "/d",
      "/s",
      "/c",
      '"' + quoteWindowsArgument(inputs[0]) + ' run build:web"',
    ];
  } else demand(false, "NATIVE_COMMAND");
  const command_line =
    command[0] === "npm.cmd"
      ? quoteWindowsArgument(executable) + " /d /s /c " + args[3]
      : [executable, ...args].map(quoteWindowsArgument).join(" ");
  return { executable, args, inputs, command_line };
}
export async function verifyNative(trace, dir) {
  demand(
    [2, 3].includes(trace.version) &&
      trace.tree_completion_verified &&
      trace.assigned_before_resume &&
      trace.cleanup_succeeded &&
      trace.zero_observed &&
      trace.root_exit_observed &&
      !trace.termination_requested,
    "NATIVE_COMPLETION_INCOMPLETE",
  );
  demand(
    Number.isInteger(trace.root_exit_code) &&
      trace.first_failure ===
        (trace.root_exit_code === 0 ? null : "CHILD_EXIT_NONZERO") &&
      trace.accounting.every((q) => q.succeeded),
    "NATIVE_FAILURE_RETAINED",
  );
  demand(
    trace.total_processes >= trace.processes.length &&
      trace.identity_inventory_complete ===
        (trace.total_processes === trace.processes.length),
    "NATIVE_IDENTITY_INVENTORY",
  );
  const bytes = await ordinary(path.join(dir, "ownership.json")),
    own = JSON.parse(bytes);
  demand(own.contract_version === trace.version, "NATIVE_VERSION_BINDING");
  if (trace.version === 3) validateCompletionV3(own);
  else validateCompletionProof(own);
  demand(
    same(own, trace.ownership) &&
      own.root_pid === trace.root_pid &&
      own.root_creation_filetime === trace.root_creation_filetime &&
      own.root_exit_code === trace.root_exit_code &&
      own.root_exit_utc === trace.root_exit_utc &&
      same(own.command, trace.command) &&
      same(own.accounting, trace.accounting) &&
      same(own.launch, trace.launch) &&
      same(own.containment, trace.containment),
    "NATIVE_PROJECTION",
  );
  demand(
    same(own.historical.identities, trace.processes) &&
      own.historical.lifetime_process_count === trace.total_processes &&
      own.historical.inventory_complete === trace.identity_inventory_complete,
    "NATIVE_HISTORY_PROJECTION",
  );
  if (trace.version === 3)
    demand(
      same(own.ordering, trace.ordering) &&
        (!trace.supervisor_pid ||
          (own.ordering.supervisor_pid === trace.supervisor_pid &&
            own.ordering.supervisor_creation_filetime ===
              trace.supervisor_creation_filetime)) &&
        own.ordering.events[0].details.utc === trace.started_utc &&
        own.ordering.events.at(-1).details.utc === trace.ended_utc,
      "NATIVE_JOURNAL_PROJECTION",
    );
  else
    demand(
      nativeTime(trace.started_utc) <= BigInt(trace.root_creation_filetime) &&
        nativeTime(own.zero_query_utc) <= nativeTime(trace.ended_utc),
      "NATIVE_PROJECTION_TIMING",
    );
  let launch;
  if (trace.evidence_class === "offline-native-fixture") {
    const mode = trace.command[1],
      base = path.dirname(dir);
    demand(
      trace.command.length === 2 &&
        trace.command[0] === "offline-fixture" &&
        [
          "success",
          "nonzero",
          "short-descendant",
          "persistent-descendant",
          "query-failure",
          "pid-mismatch",
          "interrupt",
          "nonzero-descendant",
          "cmd-quoting",
          "supervisor-exit",
          "incomplete-history",
          "assignment-failure",
          "breakaway",
          "utc-reversal",
          "journal-overflow",
          "qpc-failure",
        ].includes(mode),
      "OFFLINE_COMMAND",
    );
    const cmd = mode === "cmd-quoting",
      executable = cmd
        ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32/cmd.exe")
        : path.join(base, "fixture.exe");
    const inputs = cmd ? [path.join(base, "fixed fixture.cmd")] : [];
    const args = cmd
      ? [
          "/d",
          "/s",
          "/c",
          '"' + quoteWindowsArgument(inputs[0]) + ' run build:web"',
        ]
      : [mode];
    launch = {
      executable,
      inputs,
      args,
      command_line: cmd
        ? quoteWindowsArgument(executable) + " /d /s /c " + args[3]
        : [executable, ...args].map(quoteWindowsArgument).join(" "),
    };
    demand(
      own.launch.policy === "offline-fixture-direct-child",
      "NATIVE_LAUNCH_POLICY",
    );
  } else {
    demand(
      trace.evidence_class === "application-native" &&
        own.launch.policy === "approved-focused-v1-direct-child",
      "NATIVE_EVIDENCE_CLASS",
    );
    launch = await resolveApprovedLaunch(trace.command);
    if (trace.version === 3)
      demand(
        own.ordering.stage_id ===
          (await approvedManifest()).stages.find((s) =>
            same(s.command, trace.command),
          )?.id,
        "NATIVE_STAGE_BINDING",
      );
  }
  demand(
    sameWindowsPath(launch.executable, own.launch.executable_path) &&
      same(launch.args, own.launch.arguments) &&
      (trace.command[0] === "npm.cmd" || trace.command[1] === "cmd-quoting"
        ? quoteWindowsArgument(own.launch.executable_path) +
          " /d /s /c " +
          launch.args[3]
        : [own.launch.executable_path, ...launch.args]
            .map(quoteWindowsArgument)
            .join(" ")) === own.launch.command_line &&
      launch.inputs.length === own.launch.inputs.length &&
      sha256(await ordinary(launch.executable)) ===
        own.launch.executable_sha256,
    "NATIVE_EXECUTABLE_COMMAND",
  );
  for (let i = 0; i < launch.inputs.length; i++)
    demand(
      sameWindowsPath(launch.inputs[i], own.launch.inputs[i].path) &&
        sha256(await ordinary(launch.inputs[i])) ===
          own.launch.inputs[i].sha256,
      "NATIVE_SCRIPT_IDENTITY",
    );
  return { ...own, evidence_sha256: sha256(bytes) };
}

async function launchStage(id, dir, stop, signal, supervisor) {
  const logs = [];
  try {
    // A fresh sibling inside this execution owns worker diagnostics. The native
    // stage directory must remain empty until the native helper takes ownership.
    const diagnostics = path.join(
      path.dirname(dir),
      `worker-diagnostics-${path.basename(dir)}`,
    );
    await fs.mkdir(diagnostics);
    demand(
      (await fs.realpath(diagnostics)).toLowerCase() ===
        diagnostics.toLowerCase(),
      "REDIRECTED_WORKER_DIAGNOSTICS",
    );
    // Both the directory and its files are exclusive; prior evidence is retained.
    for (const name of ["stdout", "stderr"])
      logs.push(
        await fs.open(path.join(diagnostics, `worker-${name}.log`), "wx"),
      );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        powershell,
        [
          ...psArgs("phase9-focused-worker-v1.ps1"),
          "-Stage",
          id,
          "-ArtifactDirectory",
          dir,
          "-StopFile",
          stop,
          "-OwnerPid",
          String(process.pid),
          "-OwnerCreation",
          supervisor.creation_filetime,
        ],
        {
          cwd: ROOT,
          windowsHide: true,
          env: cleanEnvironment(process.env),
          stdio: ["ignore", logs[0].fd, logs[1].fd],
        },
      );
      let bound;
      const cancel = () => {
        fs.writeFile(stop, "interrupted", { flag: "wx" }).catch(() => {});
        bound = setTimeout(() => child.kill(), 8000);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.once("error", reject);
      child.once("close", (code, sig) => {
        clearTimeout(bound);
        signal.removeEventListener("abort", cancel);
        resolve({ code, signal: sig, worker_pid: child.pid });
      });
    });
  } finally {
    for (const file of logs) await file.close();
  }
}
export async function execute() {
  // Retain the readable manifest only for a failure report; execution uses the approved object below.
  let m = JSON.parse(await fs.readFile(path.join(ROOT, MANIFEST), "utf8"));
  const id = randomUUID().replaceAll("-", ""),
    dir = path.join(ROOT, ".tools/phase9-focused/executor-v1-" + id);
  await fs.mkdir(dir);
  demand(
    (await fs.realpath(dir)).toLowerCase() === dir.toLowerCase(),
    "REDIRECTED_RUN_DIRECTORY",
  );
  let source = null,
    before,
    evidence;
  try {
    m = await approvedManifest();
    source = await captureSource();
    before = await observe(m);
    await exclusive(path.join(dir, "preflight.json"), {
      manifest_sha256: APPROVED_MANIFEST_SHA256,
      source,
      before,
      inventory: m.stages.map((s) => ({
        id: s.id,
        command: s.command,
        tests: s.expected_tests,
      })),
    });
    evidence = {
      version: 2,
      completion_contract: 3,
      evidence_class: "application-evidence",
      manifest_sha256: APPROVED_MANIFEST_SHA256,
      source_before: source,
      source_after: source,
      execution_environment: EXECUTION_ENVIRONMENT,
      environments: { before: before.environments, after: before.environments },
      preservation: { before: before.preservation, after: before.preservation },
      stages: [],
    };
    // Check the unchanged reporter's COMPLETE preflight schema before any application spawn.
    const preflightReport = await reportEvidence(m, evidence, {
      evidenceRoot: dir,
    });
    demand(!preflightReport.first_failure, "REPORTER_PREFLIGHT_REJECTED");
    const staged = await runFile("git", ["diff", "--cached", "--binary"], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    demand(
      staged.stdout === "" && same(source, await captureSource()),
      "SOURCE_OR_STAGING_CHANGED",
    );
  } catch (e) {
    // No stage has started. Missing evidence must produce FAIL, never an invented snapshot.
    const failure = /^[A-Z][A-Z_]+$/.test(e.message)
      ? e.message
      : "PREFLIGHT_FAILED";
    const report = await reportEvidence(m, null, { evidenceRoot: dir });
    report.first_failure = { code: "E_EXECUTOR_PREFLIGHT", stage: null };
    await exclusive(path.join(dir, "preflight-failure.json"), {
      version: 1,
      first_failure: failure,
      source,
      application_stages_started: 0,
    });
    await exclusive(path.join(dir, "bundle.json"), null);
    await exclusive(path.join(dir, "executor-result.json"), {
      version: 1,
      first_failure: failure,
      attempts: [],
      completed_stages: [],
      reporter_status: report.status,
      reporter_application_pass: false,
      exit_code: 1,
    });
    await writeExclusive(
      ROOT,
      `.tools/phase9-focused/run-${id}/report.json`,
      report,
    );
    console.log(
      JSON.stringify({
        artifacts: path.relative(ROOT, dir),
        first_failure: failure,
        status: report.status,
        application_validation_pass: false,
      }),
    );
    return 1;
  }
  let firstFailure = null,
    exit = 0,
    pending = null;
  const completed = [],
    attempts = [],
    controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    for (let index = 0; index < m.stages.length; index++) {
      demand(!controller.signal.aborted, "INTERRUPTED");
      const spec = m.stages[index],
        command = requireStage(m, spec.id, index, completed);
      const stageDir = path.join(dir, spec.id);
      await fs.mkdir(stageDir);
      const stop = path.join(dir, "stop");
      pending = {
        id: spec.id,
        command,
        started_utc: new Date().toISOString(),
        ended_utc: null,
        exit_code: null,
        stdout: null,
        stderr: null,
        ownership: null,
        handoff: null,
      };
      const attempt = {
        id: spec.id,
        started_utc: pending.started_utc,
        worker_completion: null,
        native_verified: false,
      };
      attempts.push(attempt);
      await exclusive(path.join(dir, `attempt-${index + 1}.json`), {
        id: spec.id,
        command,
        started_utc: pending.started_utc,
      });
      const predecessor = index === 0 ? null : evidence.stages[index - 1];
      const previous = predecessor
        ? {
            stage_id: predecessor.id,
            ownership_sha256: predecessor.ownership.evidence_sha256,
            session_id: predecessor.ownership.ordering.session_id,
            prefix_path: `prefix-${index}.json`,
            prefix_sha256: sha256(
              await ordinary(path.join(dir, `prefix-${index}.json`)),
            ),
          }
        : null;
      const requestPath = `request-${index + 1}.json`;
      await exclusive(path.join(dir, requestPath), {
        index,
        stage_id: spec.id,
        command,
        previous,
        controller: {
          pid: process.pid,
          creation_filetime: before.supervisor.creation_filetime,
        },
      });
      const requestHash = sha256(await ordinary(path.join(dir, requestPath)));
      const worker = await launchStage(
        spec.id,
        stageDir,
        stop,
        controller.signal,
        before.supervisor,
      );
      attempt.worker_completion = worker;
      pending.ended_utc = new Date().toISOString();
      const trace = await readJson(path.join(stageDir, "native-trace.json"));
      demand(
        trace.evidence_class === "application-native",
        "NATIVE_EVIDENCE_CLASS",
      );
      pending.started_utc = trace.started_utc;
      pending.ended_utc = trace.ended_utc;
      pending.exit_code = trace.root_exit_code;
      if (Number.isInteger(trace.root_exit_code) && trace.root_exit_code !== 0)
        exit = trace.root_exit_code;
      const ownership = await verifyNative(trace, stageDir);
      demand(
        trace.version === 3 && ownership.contract_version === 3,
        "COMPLETION_V3_REQUIRED",
      );
      attempt.native_verified = true;
      demand(same(command, trace.command), "NATIVE_COMMAND");
      demand(
        worker.signal === null &&
          worker.code ===
            (trace.root_exit_code === 0 ? 0 : trace.root_exit_code),
        "WORKER_COMPLETION",
      );
      demand(
        worker.worker_pid === ownership.ordering.observer_pid,
        "NATIVE_OBSERVER_WORKER",
      );
      const stream = async (name) => ({
        path: spec.id + "/" + name + ".log",
        sha256: sha256(await ordinary(path.join(stageDir, name + ".log"))),
      });
      evidence.stages.push({
        id: spec.id,
        command,
        started_utc: trace.started_utc,
        ended_utc: trace.ended_utc,
        exit_code: trace.root_exit_code,
        stdout: await stream("stdout"),
        stderr: await stream("stderr"),
        ownership: { ...ownership, evidence_path: spec.id + "/ownership.json" },
        handoff: {
          index,
          stage_id: spec.id,
          previous,
          request_path: requestPath,
          request_sha256: requestHash,
          worker: {
            pid: worker.worker_pid,
            exit_code: worker.code,
            signal: worker.signal,
          },
          observer_session_id: ownership.ordering.session_id,
          proof_sha256: ownership.evidence_sha256,
        },
      });
      pending = null;
      // Prefix reports must use measured after-observations, not copy the initial snapshot.
      const observed = await observe(m);
      evidence.environments.after = observed.environments;
      evidence.preservation.after = observed.preservation;
      const partial = await reportEvidence(m, evidence, { evidenceRoot: dir });
      await exclusive(path.join(dir, `prefix-${index + 1}.json`), partial);
      demand(
        !partial.first_failure,
        partial.first_failure?.code ?? "REPORTER_FAILURE",
      );
      demand(trace.first_failure === null, "NATIVE_STAGE_FAILURE");
      completed.push(spec.id);
    }
  } catch (e) {
    firstFailure = e.message;
    exit = exit || 1;
    if (pending) {
      pending.ended_utc = pending.ended_utc ?? new Date().toISOString();
      evidence.stages.push(pending);
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  // Even failure must retain after-observations; failures here cannot yield a PASS report.
  try {
    const after = await observe(m);
    evidence.environments.after = after.environments;
    evidence.preservation.after = after.preservation;
    evidence.source_after = await captureSource();
  } catch (e) {
    firstFailure = firstFailure || e.message;
    exit = exit || 1;
    evidence.environments.after = null;
    evidence.preservation.after = null;
  }
  await exclusive(path.join(dir, "bundle.json"), evidence);
  const report = await reportEvidence(m, evidence, { evidenceRoot: dir });
  firstFailure = firstFailure || report.first_failure?.code || null;
  if (firstFailure) {
    // An executor failure cannot be cleared by a later successful observation/report.
    report.first_failure ??= {
      code: "E_EXECUTOR_FAILURE",
      stage: attempts.at(-1)?.id ?? null,
    };
    report.status = "FAIL";
    report.coverage_complete = false;
    report.application_validation_pass = false;
  }
  const finalExit =
    firstFailure || !report.application_validation_pass ? exit || 1 : 0;
  await exclusive(path.join(dir, "executor-result.json"), {
    version: 1,
    first_failure: firstFailure,
    attempts,
    completed_stages: completed,
    reporter_status: report.status,
    reporter_application_pass: report.application_validation_pass,
    exit_code: finalExit,
  });
  await writeExclusive(
    ROOT,
    `.tools/phase9-focused/run-${id}/report.json`,
    report,
  );
  console.log(
    JSON.stringify({
      artifacts: path.relative(ROOT, dir),
      first_failure: firstFailure,
      status: report.status,
      application_validation_pass:
        !firstFailure && report.application_validation_pass,
    }),
  );
  return finalExit;
}
async function main() {
  demand(
    process.argv.length === 3 && ["check", "execute"].includes(process.argv[2]),
    "USAGE_CHECK_OR_EXECUTE_ONLY",
  );
  if (process.argv[2] === "check") {
    const m = await approvedManifest();
    console.log(
      JSON.stringify({
        manifest_sha256: APPROVED_MANIFEST_SHA256,
        stages: m.stages.length,
        tests: m.stages.reduce((n, s) => n + s.expected_tests.length, 0),
        application_executions: 0,
      }),
    );
    return 0;
  }
  return execute();
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("FOCUSED_EXECUTOR_FAIL_CLOSED");
      process.exitCode = 1;
    });

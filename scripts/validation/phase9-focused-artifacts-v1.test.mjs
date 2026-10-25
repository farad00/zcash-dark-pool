// OFFLINE ONLY: real worker-launch plumbing with a fixed disposable script.
// This VM adapter cannot launch a manifest stage or the application worker.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import ts from "typescript";
import { ROOT } from "./phase9-focused.mjs";
import {
  cleanEnvironment,
  verifyNative,
} from "./phase9-focused-executor-v1.mjs";

assert.ok(
  process.env.FOCUSED_V3_OFFLINE_FIXTURES,
  "genuine offline fixtures required; no skip",
);
const nativeDir = path.resolve(ROOT, process.env.FOCUSED_V3_OFFLINE_FIXTURES);
assert.ok(
  nativeDir.startsWith(path.join(ROOT, ".tools/phase9-focused") + path.sep),
);
const source = await fs.readFile(
  path.join(ROOT, "scripts/validation/phase9-focused-executor-v1.mjs"),
  "utf8",
);
const ast = ts.createSourceFile(
  "executor.mjs",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const declaration = ast.statements.find(
  (s) => ts.isFunctionDeclaration(s) && s.name?.text === "launchStage",
);
assert.ok(declaration, "exercise actual launchStage body");
const reader = ast.statements
  .filter(ts.isVariableStatement)
  .flatMap((s) => [...s.declarationList.declarations])
  .find((d) => d.name.getText(ast) === "readJson");
assert.ok(reader?.initializer, "exercise actual native trace JSON reader");
const readNativeJson = vm.runInNewContext(
  "(" + reader.initializer.getText(ast) + ")",
  { fs, JSON },
);
const dir = await fs.mkdtemp(
  path.join(ROOT, ".tools/phase9-focused/artifact-regressions-"),
);
const fixture = path.join(dir, "disposable-worker.ps1");
await fs.copyFile(
  path.join(nativeDir, "fixture.exe"),
  path.join(dir, "fixture.exe"),
  constants.COPYFILE_EXCL,
);
await fs.writeFile(
  fixture,
  `param([string]$Stage,[string]$ArtifactDirectory,[string]$StopFile,[uint32]$OwnerPid,[string]$OwnerCreation)
$ErrorActionPreference='Stop'
if($Stage -notin @('success','nonzero','startup-failure','native-success','native-preexisting','native-failure')){throw 'Unknown offline fixture'}
[Console]::Out.WriteLine('disposable worker stdout')
[Console]::Error.WriteLine('disposable worker stderr')
if($Stage -eq 'startup-failure'){throw 'OFFLINE_WORKER_STARTUP_FAILURE'}
if($Stage -eq 'nonzero'){exit 17}
if($Stage -like 'native-*'){
 $taskRepo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
 Add-Type -Path (Join-Path $taskRepo 'scripts/validation/phase9-focused-native-v1.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
 [Console]::Out.WriteLine('native_entries_before='+[IO.Directory]::GetFileSystemEntries($ArtifactDirectory).Length)
 $taskMode=if($Stage -eq 'native-failure'){'query-failure'}else{'success'}
 $taskTrace=[FocusedNativeV1]::RunFixture($taskRepo,$PSScriptRoot,$taskMode,$ArtifactDirectory,$StopFile)
 if($null -ne $taskTrace.first_failure){throw ('OFFLINE_NATIVE_FAILURE: '+$taskTrace.first_failure)}
 if($null -eq $taskTrace.ownership){throw 'OFFLINE_NATIVE_OWNERSHIP_MISSING'}
}
exit 0
`,
  { flag: "wx" },
);
const powershell = path.join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const launches = [];
function launcher(executable = powershell, fileSystem = fs) {
  return vm.runInNewContext("(" + declaration.getText(ast) + ")", {
    fs: fileSystem,
    path,
    ROOT,
    powershell: executable,
    cleanEnvironment,
    process,
    clearTimeout,
    setTimeout,
    demand: (value, code) => {
      if (!value) throw Error(code);
    },
    psArgs: () => [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fixture,
    ],
    spawn: (...args) => {
      launches.push(args);
      return spawn(...args);
    },
  });
}
async function stage(name) {
  const p = path.join(dir, name);
  await fs.mkdir(p);
  return p;
}
const diagnostics = (p) =>
  path.join(path.dirname(p), "worker-diagnostics-" + path.basename(p));
async function run(id, destination, launch = launcher()) {
  return launch(
    id,
    destination,
    path.join(destination, "never.stop"),
    new AbortController().signal,
    { creation_filetime: "1" },
  );
}
const genuine = JSON.parse(
  await fs.readFile(path.join(nativeDir, "success/native-trace.json"), "utf8"),
);

test("worker stdout/stderr persist at exact separate paths after successful exit", async () => {
  const p = await stage("success");
  const result = await run("success", p);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(result.worker_pid > 0);
  assert.match(
    await fs.readFile(path.join(diagnostics(p), "worker-stdout.log"), "utf8"),
    /disposable worker stdout/,
  );
  assert.match(
    await fs.readFile(path.join(diagnostics(p), "worker-stderr.log"), "utf8"),
    /disposable worker stderr/,
  );
  assert.equal(launches.at(-1)[2].windowsHide, true);
  assert.deepEqual(await fs.readdir(p), []);
  assert.equal(path.dirname(diagnostics(p)), dir);
  await assert.rejects(fs.stat(path.join(p, "native-trace.json")), {
    code: "ENOENT",
  });
});
test("real worker startup exception is retained without fabricated native completion", async () => {
  const p = await stage("startup-failure");
  const result = await run("startup-failure", p);
  assert.equal(result.code, 1);
  assert.match(
    await fs.readFile(path.join(diagnostics(p), "worker-stderr.log"), "utf8"),
    /OFFLINE_WORKER_STARTUP_FAILURE/,
  );
  await assert.rejects(fs.stat(path.join(p, "native-trace.json")), {
    code: "ENOENT",
  });
  await assert.rejects(() => verifyNative(genuine, p));
});
test("worker nonzero exit remains 17", async () => {
  const p = await stage("nonzero");
  assert.equal((await run("nonzero", p)).code, 17);
});
for (const name of ["stdout", "stderr"]) {
  test(
    "exclusive worker " +
      name +
      " collision preserves earlier bytes and prevents launch",
    async () => {
      const p = await stage("collision-" + name),
        before = launches.length;
      const file = path.join(diagnostics(p), "worker-" + name + ".log");
      // Simulate a destination collision after the exclusive directory reservation.
      const collisionFs = {
        ...fs,
        mkdir: async (directory) => {
          await fs.mkdir(directory);
          await fs.writeFile(file, "historical sentinel", { flag: "wx" });
        },
      };
      await assert.rejects(
        run("success", p, launcher(undefined, collisionFs)),
        {
          code: "EEXIST",
        },
      );
      assert.equal(await fs.readFile(file, "utf8"), "historical sentinel");
      assert.equal(launches.length, before);
      // Any first log opened before the second collision is closed in finally.
      await fs.rename(
        path.join(diagnostics(p), "worker-stdout.log"),
        path.join(diagnostics(p), "closed-stdout.log"),
      );
      assert.deepEqual(await fs.readdir(p), []);
    },
  );
}
test("OS worker spawn failure is surfaced and reserved diagnostics close safely", async () => {
  const p = await stage("spawn-failure");
  await assert.rejects(
    run("success", p, launcher(path.join(dir, "absent-worker.exe"))),
    { code: "ENOENT" },
  );
  await fs.rename(
    path.join(diagnostics(p), "worker-stderr.log"),
    path.join(diagnostics(p), "closed-stderr.log"),
  );
  await assert.rejects(fs.stat(path.join(p, "native-trace.json")), {
    code: "ENOENT",
  });
});
test("actual logging and native helper together accept an empty native stage and produce genuine v3 artifacts", async () => {
  const p = await stage("native-success");
  assert.deepEqual(await fs.readdir(p), []);
  const result = await run("native-success", p);
  assert.equal(result.code, 0);
  const trace = await readNativeJson(path.join(p, "native-trace.json"));
  const proof = await verifyNative(trace, p);
  assert.equal(proof.ordering.observer_pid, result.worker_pid);
  assert.equal(proof.contract_version, 3);
  assert.equal(proof.tree_completion_verified, true);
  assert.equal(proof.cleanup_succeeded, true);
  assert.equal(proof.termination_requested, false);
  assert.equal(proof.active_processes, 0);
  assert.equal(proof.query_succeeded, true);
  assert.match(
    await fs.readFile(path.join(diagnostics(p), "worker-stdout.log"), "utf8"),
    /native_entries_before=0/,
  );
  assert.deepEqual((await fs.readdir(p)).sort(), [
    "native-trace.json",
    "ownership.json",
    "stderr.log",
    "stdout.log",
  ]);
  assert.deepEqual((await fs.readdir(diagnostics(p))).sort(), [
    "worker-stderr.log",
    "worker-stdout.log",
  ]);
});
test("pre-existing native output stays rejected and intact while native helper diagnostics survive", async () => {
  const p = await stage("native-preexisting");
  const file = path.join(p, "ownership.json");
  await fs.writeFile(file, "historical native sentinel", { flag: "wx" });
  const result = await run("native-preexisting", p);
  assert.equal(result.code, 1);
  assert.match(
    await fs.readFile(path.join(diagnostics(p), "worker-stderr.log"), "utf8"),
    /FRESH_OUTPUT_REQUIRED/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "historical native sentinel");
  assert.deepEqual(await fs.readdir(p), ["ownership.json"]);
});
test("native failure after fresh-directory admission retains failure artifacts and worker diagnostics", async () => {
  const p = await stage("native-failure");
  const result = await run("native-failure", p);
  assert.equal(result.code, 1);
  assert.match(
    await fs.readFile(path.join(diagnostics(p), "worker-stderr.log"), "utf8"),
    /OFFLINE_NATIVE_FAILURE/,
  );
  const trace = await readNativeJson(path.join(p, "native-trace.json"));
  assert.ok(trace.first_failure);
  assert.equal(trace.ownership, null);
  await assert.rejects(() => verifyNative(trace, p));
});
test("historical diagnostic directory collision is rejected without launch or overwrite", async () => {
  const p = await stage("historical-diagnostics"),
    before = launches.length;
  await fs.mkdir(diagnostics(p));
  const file = path.join(diagnostics(p), "worker-stderr.log");
  await fs.writeFile(file, "earlier diagnostic bytes", { flag: "wx" });
  await assert.rejects(run("success", p), { code: "EEXIST" });
  assert.equal(launches.length, before);
  assert.equal(await fs.readFile(file, "utf8"), "earlier diagnostic bytes");
  assert.deepEqual(await fs.readdir(p), []);
});
test("worker logging failure closes already opened descriptors and prevents child launch", async () => {
  const p = await stage("logging-failure"),
    before = launches.length;
  let closed = 0;
  const failingFs = {
    ...fs,
    open: async (file, flags) => {
      if (path.basename(file) === "worker-stderr.log")
        throw Object.assign(Error("offline denied log fixture"), {
          code: "EACCES",
        });
      const opened = await fs.open(file, flags);
      return {
        fd: opened.fd,
        close: async () => {
          await opened.close();
          closed++;
        },
      };
    },
  };
  await assert.rejects(run("success", p, launcher(undefined, failingFs)), {
    code: "EACCES",
  });
  assert.equal(closed, 1);
  assert.equal(launches.length, before);
  assert.deepEqual(await fs.readdir(p), []);
});
test("redirected diagnostic resolution is rejected before file creation or launch", async () => {
  const p = await stage("redirected-diagnostics"),
    before = launches.length;
  const redirectedFs = {
    ...fs,
    realpath: async () => path.join(dir, "different-directory"),
  };
  await assert.rejects(
    run("success", p, launcher(undefined, redirectedFs)),
    /REDIRECTED_WORKER_DIAGNOSTICS/,
  );
  assert.equal(launches.length, before);
  assert.deepEqual(await fs.readdir(diagnostics(p)), []);
  assert.deepEqual(await fs.readdir(p), []);
});
test("missing ownership artifact is rejected", async () => {
  const p = await stage("missing-ownership");
  await assert.rejects(() => verifyNative(genuine, p), { code: "ENOENT" });
});
test("missing native-trace artifact fails in the actual executor reader", async () => {
  const p = await stage("missing-native-trace");
  await assert.rejects(readNativeJson(path.join(p, "native-trace.json")), {
    code: "ENOENT",
  });
});
test("empty native-trace artifact fails before native verification", async () => {
  const p = await stage("empty-native-trace");
  const file = path.join(p, "native-trace.json");
  await fs.writeFile(file, "", { flag: "wx" });
  await assert.rejects(readNativeJson(file), SyntaxError);
});
test("empty ownership artifact is rejected", async () => {
  const p = await stage("empty-ownership");
  await fs.writeFile(path.join(p, "ownership.json"), "", { flag: "wx" });
  await assert.rejects(() => verifyNative(genuine, p), SyntaxError);
});
test("genuine fresh native trace and completion-v3 projection remain compatible", async () => {
  const proof = await verifyNative(genuine, path.join(nativeDir, "success"));
  assert.equal(proof.contract_version, 3);
  assert.equal(proof.tree_completion_verified, true);
  assert.equal(proof.termination_requested, false);
  assert.ok(proof.ordering.complete);
});
test("native trace/projection contradictions still fail closed", async () => {
  const changed = structuredClone(genuine);
  changed.ordering.events[0].qpc_begin = "0";
  await assert.rejects(() =>
    verifyNative(changed, path.join(nativeDir, "success")),
  );
});

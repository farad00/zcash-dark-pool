// Disposable process fixtures only. Never invokes pg_ctl, SQL or a preserved server.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";

const node = process.execPath;
const runner = fileURLToPath(
  new URL("../../scripts/dev/run-bounded.mjs", import.meta.url),
);
const initializer = fileURLToPath(
  new URL("../../scripts/dev/postgres-isolated.ps1", import.meta.url),
);
let directory,
  base,
  fixture,
  stageFunction,
  serial = 0;
before(async () => {
  base = await realpath(tmpdir());
  directory = await mkdtemp(join(base, "darkpool-start-"));
  fixture = join(directory, "child.mjs");
  await writeFile(
    fixture,
    String.raw`
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const mode=process.argv[2],ready=process.argv[3];
if(mode==='postmaster') {if(ready!=='-')writeFileSync(ready,'READY');setTimeout(()=>{},12000);}
else if(['ready','delayed-ready','failed-ready','never-ready','unready'].includes(mode)) {
 const c=spawn(process.execPath,[process.argv[1],'postmaster',mode==='never-ready'||mode==='unready'?'-':ready],{detached:true,stdio:['ignore','inherit','inherit'],windowsHide:true});
 console.log('FIXTURE_CHILD='+c.pid);c.unref();
 const start=Date.now();const timer=setInterval(()=>{
  if(existsSync(ready)){clearInterval(timer);const finish=()=>{console.log('waiting for server to start.... done\nserver started');process.exitCode=mode==='failed-ready'?1:0;};if(mode==='delayed-ready')setTimeout(finish,900);else finish();}
  else if(mode==='unready'&&Date.now()-start>300){clearInterval(timer);console.error('synthetic server never ready');process.exitCode=1;}
 },10);
}else if(mode==='failure')process.exitCode=1;
else if(mode==='later-failure')process.exitCode=9;
else if(mode==='stderr'){console.error('synthetic nonfatal diagnostic');console.log('server started');}
else if(mode==='saturate'){process.stdout.write('o'.repeat(262144));process.stderr.write('e'.repeat(262144));setInterval(()=>{},1000);}
else if(mode==='stdin'){let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log('EOF:'+s));process.stdin.resume();}
else console.log('server started');
`,
  );
  const source = await readFile(initializer, "utf8");
  stageFunction = /function Invoke-IsolatedStage \{[\s\S]*?\r?\n\}/.exec(
    source,
  )?.[0];
  assert.ok(
    stageFunction,
    "extract only the stage function, never run cluster initialization",
  );
});
after(async () => {
  assert.equal(dirname(resolve(directory)), resolve(base));
  assert.ok(basename(directory).startsWith("darkpool-start-"));
  await rm(directory, { recursive: true, force: true });
});
const options = { timeoutMs: 5000, allowInheritedOutputAfterExit: true };
function cleanup(result) {
  for (const match of (result?.stdout ?? "").matchAll(/FIXTURE_CHILD=(\d+)/g)) {
    try {
      process.kill(Number(match[1]));
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
async function child(mode, config = {}) {
  const ready = join(directory, `ready-${serial++}`);
  return runBounded(node, [fixture, mode, ready], { ...options, ...config });
}
const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
async function powershellStage(mode, laterMode) {
  const ready = join(directory, `ready-${serial++}`);
  let functionSource = stageFunction;
  if (laterMode)
    functionSource = functionSource.replace(
      "$stageExitCode = $LASTEXITCODE",
      "$stageExitCode = $LASTEXITCODE\n  & " +
        psQuote(node) +
        " " +
        psQuote(fixture) +
        " " +
        psQuote(laterMode) +
        "\n  Write-Output 'later harmless native command completed'",
    );
  const script = join(directory, `stage-${serial++}.ps1`);
  await writeFile(
    script,
    "$ErrorActionPreference='Stop'\n$boundedRunner=" +
      psQuote(runner) +
      "\n" +
      functionSource +
      "\nInvoke-IsolatedStage 'server-start' 4000 " +
      psQuote(node) +
      " @(" +
      [fixture, mode, ready].map(psQuote).join(",") +
      ") -AllowInheritedOutputAfterExit\nexit 0\n",
  );
  return runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ],
    {
      timeoutMs: 9000,
      allowInheritedOutputAfterExit: true,
      env: {
        ...process.env,
        PATH: dirname(node) + delimiter + process.env.PATH,
      },
    },
  );
}

test("pg_ctl completion exit 0 remains stage success", async () => {
  const result = await child("success");
  assert.equal(result.code, 0);
  assert.equal(boundedExit(result), 0);
  assert.ok(result.exitObserved && Object.isFrozen(result));
  assert.throws(() => {
    result.code = 1;
  });
});
test("native exit 1 remains failure, including a child that became ready", async () => {
  for (const mode of ["failure", "failed-ready"]) {
    const result = await child(mode);
    try {
      assert.equal(result.code, 1);
      assert.equal(boundedExit(result), 1);
    } finally {
      cleanup(result);
    }
  }
});
test("unready launcher cannot succeed and a hanging launcher times out as 124", async () => {
  const failed = await child("unready");
  try {
    assert.equal(boundedExit(failed), 1);
  } finally {
    cleanup(failed);
  }
  const result = await child("never-ready", { timeoutMs: 500 });
  try {
    assert.equal(result.timedOut, true);
    assert.equal(boundedExit(result), 124);
  } finally {
    cleanup(result);
  }
});
test("ready descendant retaining streams does not overwrite successful native exit", async () => {
  const started = Date.now(),
    result = await child("ready");
  try {
    assert.equal(result.code, 0);
    assert.equal(result.drainExpired, true);
    assert.equal(result.timedOut, false);
    assert.equal(boundedExit(result), 0);
    assert.match(result.stdout, /server started/);
    assert.ok(Date.now() - started < 4000);
  } finally {
    cleanup(result);
  }
});
test("on-time native completion cannot become a later timeout during bounded drain", async () => {
  const result = await child("delayed-ready", { timeoutMs: 1800 });
  try {
    assert.equal(result.code, 0);
    assert.equal(result.drainExpired, true);
    assert.equal(result.timedOut, false);
    assert.equal(boundedExit(result), 0);
  } finally {
    cleanup(result);
  }
});
test("PowerShell captures LASTEXITCODE before later harmless commands overwrite it", async () => {
  const success = await powershellStage("success", "later-failure");
  assert.equal(success.code, 0);
  assert.equal(boundedExit(success), 0);
  const failure = await powershellStage("failure", "success");
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Isolated stage failed: server-start \(1\)/);
});
test("stderr diagnostics with native exit 0 do not fail Node or PowerShell stage", async () => {
  assert.equal(boundedExit(await child("stderr")), 0);
  assert.equal(boundedExit(await powershellStage("stderr")), 0);
});
test("stdout/stderr saturation is bounded and cannot deadlock the daemon-launch policy", async () => {
  const started = Date.now(),
    result = await child("saturate", { maxBytes: 1024 });
  assert.equal(result.overflow, true);
  assert.equal(boundedExit(result), 1);
  assert.ok(
    Buffer.byteLength(result.stdout) <= 1024 &&
      Buffer.byteLength(result.stderr) <= 1024,
  );
  assert.ok(Date.now() - started < 4000);
});
test("daemon-launch policy preserves closed stdin and finite input closure", async () => {
  assert.equal((await child("stdin")).stdout.trim(), "EOF:");
  const result = await child("stdin", { input: "bounded synthetic input" });
  assert.equal(boundedExit(result), 0);
  assert.equal(result.stdout.trim(), "EOF:bounded synthetic input");
});
test("malformed or unobserved completion evidence fails closed", async () => {
  const valid = await child("success");
  for (const invalid of [
    null,
    {},
    { code: 0 },
    { ...valid, code: "0" },
    { ...valid, exitObserved: false },
    { ...valid, drainExpired: "false" },
    { ...valid, allowInheritedOutputAfterExit: "true" },
    { ...valid, signal: "SIGTERM" },
  ])
    assert.equal(boundedExit(invalid), 1);
  assert.throws(
    () =>
      runBounded(node, [], {
        timeoutMs: 1000,
        allowInheritedOutputAfterExit: "yes",
      }),
    /Invalid initializer output policy/,
  );
});
test("actual PowerShell stage and enclosing supervisor both complete with retained fixture pipes", async () => {
  const result = await powershellStage("ready");
  try {
    assert.equal(result.code, 0);
    assert.equal(result.drainExpired, true);
    assert.equal(boundedExit(result), 0);
    assert.match(
      result.stdout,
      /STAGE server-start END.*EXIT 0.*NATIVE_EXIT 0.*DRAIN_EXPIRED true.*INHERITED_OUTPUT true/,
    );
    const source = await readFile(initializer, "utf8");
    assert.match(
      source,
      /'server-start' 30000 'pg_ctl'.*'-t','20','-w','start'.*-AllowInheritedOutputAfterExit/,
    );
    assert.match(
      source,
      /'initializer'.*-AllowInheritedOutputAfterExit:\(-not \$CompleteOnly\)/,
    );
  } finally {
    cleanup(result);
  }
});

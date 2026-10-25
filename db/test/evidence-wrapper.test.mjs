// Disposable native/PowerShell fixtures only: no wallet, network or PostgreSQL.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { runEvidence } from "../../scripts/dev/run-evidence.mjs";

const runner = fileURLToPath(
  new URL("../../scripts/dev/run-bounded.mjs", import.meta.url),
);
const capture = fileURLToPath(
  new URL("../../scripts/dev/run-evidence.mjs", import.meta.url),
);
let directory,
  base,
  fixture,
  serial = 0;
before(async () => {
  base = await realpath(tmpdir());
  directory = await mkdtemp(join(base, "darkpool-evidence-"));
  fixture = join(directory, "child.mjs");
  await writeFile(
    fixture,
    String.raw`
const mode=process.argv[2];
if(mode==='stderr')process.stderr.write('synthetic ordinary diagnostic\n');
else if(mode==='both'){console.log('{"ok":true}');console.error('synthetic ordinary diagnostic');}
else if(mode==='success-looking-failure'){console.log('{"ok":true}');process.exitCode=1;}
else if(mode==='stderr-failure'){console.error('synthetic failure');process.exitCode=1;}
else if(mode==='timeout')setInterval(()=>{},1000);
else if(mode==='large'){process.stdout.write('o'.repeat(262144));process.stderr.write('e'.repeat(262144));}
else if(mode==='stdin'){let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log('EOF:'+s));process.stdin.resume();}
else if(mode==='malformed')console.log('not JSON');
else if(mode==='missing'){}
else if(mode==='secret'){console.log(process.argv[3]);console.error(process.env.SYNTHETIC_SECRET);}
else if(mode==='later-failure')process.exitCode=9;
else console.log('{"ok":true}');
`,
  );
});
after(async () => {
  assert.equal(dirname(resolve(directory)), resolve(base));
  assert.ok(basename(directory).startsWith("darkpool-evidence-"));
  await rm(directory, { recursive: true, force: true });
});
function output() {
  return join(directory, `capture-${serial++}`);
}
async function run(mode, options = {}) {
  const destination = output();
  const result = await runEvidence(process.execPath, [fixture, mode], {
    stage: "synthetic",
    directory: destination,
    timeoutMs: 4000,
    ...options,
  });
  return { result, destination };
}
const read = (destination, name) => readFile(join(destination, name), "utf8");
const jsonRequired = ({ stdout }) => JSON.parse(stdout).ok === true;
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
async function powershell(mode, broken = false, later = false) {
  const destination = output(),
    script = join(directory, `wrapper-${serial++}.ps1`);
  const command = broken
    ? `& ${quote(process.execPath)} ${quote(runner)} synthetic 4000 ${quote(process.execPath)} ${quote(fixture)} ${quote(mode)} *> ${quote(destination + ".log")}`
    : `& ${quote(process.execPath)} ${quote(capture)} synthetic 4000 ${quote(destination)} ${quote(process.execPath)} ${quote(fixture)} ${quote(mode)}`;
  await writeFile(
    script,
    `$ErrorActionPreference='Stop'
try {
 ${command}
 $stageExit=$LASTEXITCODE
 ${later ? `& ${quote(process.execPath)} ${quote(fixture)} later-failure` : ""}
 exit $stageExit
} catch {
 [IO.File]::WriteAllText(${quote(destination + ".error.json")},(ConvertTo-Json -InputObject ([ordered]@{fqid=$_.FullyQualifiedErrorId;exception=$_.Exception.GetType().FullName;nativeExitCaptured=$false})))
 exit 91
}
`,
  );
  const result = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ],
    { timeoutMs: 9000 },
  );
  return { result, destination };
}

test("original redirected PowerShell wrapper promotes ordinary stderr to an error", async () => {
  assert.equal(
    boundedExit(
      await runBounded(process.execPath, [fixture, "stderr"], {
        timeoutMs: 4000,
      }),
    ),
    0,
  );
  const { result, destination } = await powershell("stderr", true);
  assert.equal(boundedExit(result), 91);
  const error = JSON.parse(await readFile(destination + ".error.json", "utf8"));
  assert.equal(error.fqid, "NativeCommandError");
  assert.equal(error.exception, "System.Management.Automation.RemoteException");
  assert.equal(error.nativeExitCaptured, false);
});
test("stdout only and exit0 retains separate valid evidence", async () => {
  const { result, destination } = await run("stdout", {
    validate: jsonRequired,
  });
  assert.equal(result.exit, 0);
  assert.equal(result.validation, "PASS");
  assert.equal(await read(destination, "stderr.txt"), "");
  assert.deepEqual(JSON.parse(await read(destination, "result.json")), result);
  assert.ok(Object.isFrozen(result) && result.pid > 0 && result.exitObserved);
});
test("stderr plus exit0 succeeds and preserves stderr", async () => {
  const { result, destination } = await run("stderr");
  assert.equal(result.exit, 0);
  assert.equal(await read(destination, "stdout.txt"), "");
  assert.match(await read(destination, "stderr.txt"), /ordinary diagnostic/);
});
test("stdout and stderr plus exit0 passes required result validation", async () => {
  const { result, destination } = await run("both", { validate: jsonRequired });
  assert.equal(result.exit, 0);
  assert.equal(result.validation, "PASS");
  assert.equal(JSON.parse(await read(destination, "stdout.txt")).ok, true);
  assert.match(await read(destination, "stderr.txt"), /ordinary diagnostic/);
});
test("success-looking stdout cannot turn native exit1 into success", async () => {
  const { result } = await run("success-looking-failure", {
    validate: jsonRequired,
  });
  assert.equal(result.code, 1);
  assert.equal(result.exit, 1);
  assert.equal(result.validation, "NOT_RUN");
});
test("stderr and native exit1 remains failure", async () => {
  const { result, destination } = await run("stderr-failure");
  assert.equal(result.code, 1);
  assert.equal(result.exit, 1);
  assert.match(await read(destination, "stderr.txt"), /synthetic failure/);
});
test("timeout remains failure with native termination identity retained", async () => {
  const { result } = await run("timeout", { timeoutMs: 300 });
  assert.equal(result.exit, 124);
  assert.equal(result.timedOut, true);
  assert.ok(result.pid > 0);
  assert.throws(() => process.kill(result.pid, 0));
});
test("large concurrent streams drain without deadlock and overflow fails bounded", async () => {
  const start = Date.now();
  const { result, destination } = await run("large");
  assert.equal(result.exit, 0);
  assert.equal((await read(destination, "stdout.txt")).length, 262144);
  assert.equal((await read(destination, "stderr.txt")).length, 262144);
  const capped = await run("large", { maxBytes: 1024 });
  assert.equal(capped.result.overflow, true);
  assert.equal(capped.result.exit, 1);
  assert.ok(
    capped.result.stdoutBytes <= 1024 && capped.result.stderrBytes <= 1024,
  );
  assert.ok(Date.now() - start < 7000);
});
test("stdin is closed by default and finite supplied input also reaches EOF", async () => {
  const empty = await run("stdin");
  assert.equal(empty.result.exit, 0);
  assert.equal((await read(empty.destination, "stdout.txt")).trim(), "EOF:");
  const finite = await run("stdin", { input: "finite synthetic input" });
  assert.equal(finite.result.exit, 0);
  assert.equal(
    (await read(finite.destination, "stdout.txt")).trim(),
    "EOF:finite synthetic input",
  );
});
test("missing or malformed required evidence fails despite native exit0", async () => {
  for (const mode of ["missing", "malformed"]) {
    const { result } = await run(mode, { validate: jsonRequired });
    assert.equal(result.code, 0);
    assert.equal(result.exit, 1);
    assert.equal(result.validation, "FAIL");
  }
});
test("console and result metadata omit secrets while private raw streams remain retained", async () => {
  const secret = "SYNTHETIC_SECRET_SENTINEL_8f5b",
    destination = output();
  const result = await runBounded(
    process.execPath,
    [
      capture,
      "synthetic",
      "4000",
      destination,
      process.execPath,
      fixture,
      "secret",
      secret,
    ],
    { timeoutMs: 6000, env: { ...process.env, SYNTHETIC_SECRET: secret } },
  );
  assert.equal(boundedExit(result), 0);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!(await read(destination, "result.json")).includes(secret));
  assert.ok((await read(destination, "stdout.txt")).includes(secret));
  assert.ok((await read(destination, "stderr.txt")).includes(secret));
  const failed = await run("stdout", {
    validate: () => {
      throw Error(secret);
    },
  });
  assert.equal(failed.result.exit, 1);
  assert.ok(!(await read(failed.destination, "result.json")).includes(secret));
});
test("corrected outer PowerShell accepts stderr exit0 and captures exit before later commands", async () => {
  for (const mode of ["stderr", "both"]) {
    const { result, destination } = await powershell(mode, false, true);
    assert.equal(boundedExit(result), 0);
    assert.equal(JSON.parse(await read(destination, "result.json")).code, 0);
  }
  const failed = await powershell("success-looking-failure", false, true);
  assert.equal(boundedExit(failed.result), 1);
});
test("CLI required JSON and exclusive evidence directory fail closed", async () => {
  const destination = output();
  const args = [
    capture,
    "synthetic",
    "4000",
    destination,
    "--json-object",
    process.execPath,
    fixture,
    "malformed",
  ];
  const first = await runBounded(process.execPath, args, { timeoutMs: 6000 });
  assert.equal(boundedExit(first), 1);
  const evidence = await read(destination, "result.json");
  assert.equal(JSON.parse(evidence).validation, "FAIL");
  const repeat = await runBounded(process.execPath, args, { timeoutMs: 6000 });
  assert.equal(boundedExit(repeat), 1);
  assert.equal(repeat.stdout.trim(), "EVIDENCE_CAPTURE_FAILED");
  assert.equal(await read(destination, "result.json"), evidence);
});

// Process lifecycle tests only: no PostgreSQL, fixture DB, wallet or network.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
const node = process.execPath;
const runner = fileURLToPath(
  new URL("../../scripts/dev/run-bounded.mjs", import.meta.url),
);
const run = (code, options = {}) =>
  runBounded(node, ["-e", code], { timeoutMs: 4000, ...options });
test("initializer drains both streams while a child runs", async () => {
  const result = await run(
    "process.stdout.write('a'.repeat(131072));process.stderr.write('b'.repeat(131072));",
  );
  assert.equal(boundedExit(result), 0);
  assert.equal(result.stdout, "a".repeat(131072));
  assert.equal(result.stderr, "b".repeat(131072));
});
test("initializer propagates nonzero child exit", async () => {
  assert.equal(boundedExit(await run("process.exit(7)")), 7);
});
test("initializer has closed noninteractive stdin by default", async () => {
  const result = await run(
    "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF'));",
  );
  assert.equal(boundedExit(result), 0);
  assert.match(result.stdout, /EOF/);
});
test("initializer query input is written then closed", async () => {
  const result = await run(
    "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(s));",
    { input: "synthetic input" },
  );
  assert.equal(boundedExit(result), 0);
  assert.equal(result.stdout.trim(), "synthetic input");
});
test("initializer terminates an unending child at its deadline", async () => {
  const start = Date.now();
  const result = await run("setInterval(()=>{},1000)", { timeoutMs: 400 });
  assert.equal(boundedExit(result), 124);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - start < 2500);
  assert.ok(result.pid > 0);
  assert.throws(() => process.kill(result.pid, 0));
});
test("initializer fails closed on spawn failure and invalid timeouts", async () => {
  const result = await runBounded("darkpool-does-not-exist", [], {
    timeoutMs: 1000,
  });
  assert.equal(result.spawnFailed, true);
  assert.equal(boundedExit(result), 1);
  for (const timeoutMs of [0, Infinity, 180001])
    assert.throws(
      () => runBounded(node, [], { timeoutMs }),
      /Invalid initializer timeout/,
    );
});
test("initializer bounds unexpected child output", async () => {
  const result = await run(
    "process.stdout.write('a'.repeat(131072));setInterval(()=>{},1000)",
    { maxBytes: 1024 },
  );
  assert.equal(result.overflow, true);
  assert.equal(boundedExit(result), 1);
});
test("retained descendant pipe cannot keep the initializer waiting", async () => {
  const result = await run(
    "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:['ignore','inherit','inherit'],windowsHide:true});console.log(c.pid);c.unref();",
  );
  const pid = Number(result.stdout.trim());
  try {
    assert.ok(pid > 0);
    assert.equal(result.drainExpired, true);
    assert.equal(boundedExit(result), 1);
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});
test("initializer CLI returns a failing stage's exit code", async () => {
  const result = await runBounded(
    node,
    [runner, "failure-case", "2000", node, "-e", "process.exit(7)"],
    { timeoutMs: 4000 },
  );
  assert.equal(result.code, 7);
  assert.match(result.stdout, /STAGE failure-case END.*EXIT 7/);
});
test("initializer CLI returns timeout status without asking for input", async () => {
  const result = await runBounded(
    node,
    [runner, "timeout-case", "400", node, "-e", "setInterval(()=>{},1000)"],
    { timeoutMs: 4000 },
  );
  assert.equal(result.code, 124);
  assert.match(result.stdout, /TIMEOUT true/);
});

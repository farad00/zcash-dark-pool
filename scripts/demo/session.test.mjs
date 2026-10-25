import assert from "node:assert/strict";
import { test } from "node:test";
import { MANUAL_DEMO_DURATION_MS, waitForManualStop } from "./session.mjs";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = new Map(
    ["SIGINT", "SIGTERM"].map((s) => [s, process.listeners(s)]),
  );
  let resolve,
    stops = 0,
    cleanups = 0;
  const stopped = new Promise((r) => {
    resolve = r;
  });
  const stop = () => {
    stops++;
    resolve();
  };
  const done = waitForManualStop(stopped, stop).finally(() => {
    cleanups++;
  });
  return {
    stop,
    done,
    original,
    counts: () => ({ stops, cleanups }),
    assertReleased() {
      for (const [signal, listeners] of original)
        assert.deepEqual(process.listeners(signal), listeners);
    },
  };
}

test("manual session survives the old 15-minute limit and stops exactly at 30 minutes", async (t) => {
  const f = fixture(t);
  assert.equal(MANUAL_DEMO_DURATION_MS, 1800000);
  t.mock.timers.tick(900000);
  assert.deepEqual(f.counts(), { stops: 0, cleanups: 0 });
  t.mock.timers.tick(899999);
  assert.deepEqual(f.counts(), { stops: 0, cleanups: 0 });
  t.mock.timers.tick(1);
  await f.done;
  assert.deepEqual(f.counts(), { stops: 1, cleanups: 1 });
  f.assertReleased();
});

test("early operator Stop releases the timer and runs cleanup once", async (t) => {
  const f = fixture(t);
  f.stop();
  await f.done;
  t.mock.timers.tick(3600000);
  assert.deepEqual(f.counts(), { stops: 1, cleanups: 1 });
  f.assertReleased();
});

for (const signal of ["SIGINT", "SIGTERM"])
  test(`${signal} handler releases the timer and preserves cleanup`, async (t) => {
    const f = fixture(t);
    const handlers = process
      .listeners(signal)
      .filter((fn) => !f.original.get(signal).includes(fn));
    assert.equal(handlers.length, 1);
    handlers[0](); // Invoke only this fixture's handler; do not signal the test process.
    await f.done;
    t.mock.timers.tick(3600000);
    assert.deepEqual(f.counts(), { stops: 1, cleanups: 1 });
    f.assertReleased();
  });

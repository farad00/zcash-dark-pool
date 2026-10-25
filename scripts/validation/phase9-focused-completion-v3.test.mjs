// OFFLINE ONLY: retained native fixtures and explicitly synthetic mutations.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./phase9-focused.mjs";
import { verifyNative } from "./phase9-focused-executor-v1.mjs";
import {
  validateCompletionProof,
  nativeTime,
  utcAnomalies,
} from "./phase9-focused-completion-v3.mjs";
import { validateCompletionProof as legacy } from "./phase9-focused-completion-v2.mjs";
import { syntheticProof } from "./phase9-focused-completion-v3-fixtures.mjs";
assert.ok(
  process.env.FOCUSED_V3_OFFLINE_FIXTURES,
  "genuine offline native fixtures required; no skips",
);
const base = path.resolve(ROOT, process.env.FOCUSED_V3_OFFLINE_FIXTURES);
assert.ok(
  base.startsWith(path.join(ROOT, ".tools", "phase9-focused") + path.sep),
);
const read = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const success = await read(path.join(base, "success", "native-trace.json"));
for (const mode of [
  "success",
  "short-descendant",
  "utc-reversal",
  "incomplete-history",
  "nonzero",
  "cmd-quoting",
]) {
  test(
    "genuine disposable " +
      mode +
      " preserves native identity and causal completion",
    async () => {
      const t = await read(path.join(base, mode, "native-trace.json"));
      const p = await verifyNative(t, path.join(base, mode));
      assert.equal(p.contract_version, 3);
      assert.equal(p.tree_completion_verified, true);
      assert.equal(p.termination_requested, false);
      assert.ok(p.ordering.record_count > 0);
      if (mode === "utc-reversal")
        assert.ok(
          utcAnomalies(p).some((a) => a.kind === "observation_before_creation"),
        );
      if (mode === "incomplete-history") {
        assert.equal(p.historical.inventory_complete, false);
        assert.ok(p.historical.missing_identity_count >= 4);
      }
      if (mode === "nonzero") assert.equal(p.root_exit_code, 17);
    },
  );
}
for (const mode of [
  "persistent-descendant",
  "query-failure",
  "pid-mismatch",
  "interrupt",
  "supervisor-exit",
  "assignment-failure",
  "breakaway",
  "journal-overflow",
  "qpc-failure",
]) {
  test(
    "genuine offline failure " + mode + " cannot become completion",
    async () => {
      const t = await read(path.join(base, mode, "native-trace.json"));
      assert.ok(t.first_failure);
      assert.equal(t.ownership, null);
      await assert.rejects(() => verifyNative(t, path.join(base, mode)));
    },
  );
}
const clone = structuredClone;
for (const [name, edit] of [
  [
    "missing native creation",
    (p) => delete p.historical.identities[0].creation_filetime,
  ],
  [
    "native FILETIME mismatch",
    (p) =>
      (p.historical.identities[0].creation_filetime = String(
        BigInt(p.root_creation_filetime) + 1n,
      )),
  ],
  ["root PID mismatch", (p) => p.root_pid++],
  [
    "missing real binding evidence",
    (p) => delete p.historical.identities[0].handle_binding,
  ],
  [
    "wrong journal creation result",
    (p) =>
      (p.ordering.events.find(
        (e) => e.kind === "bind",
      ).details.creation_filetime = "1"),
  ],
  ["missing monotonic evidence", (p) => delete p.ordering],
  ["missing QPC frequency", (p) => delete p.ordering.frequency],
  ["zero frequency", (p) => (p.ordering.frequency = "0")],
  ["rounded integer", (p) => (p.ordering.frequency = 10000000)],
  [
    "invalid observer identity",
    (p) => (p.ordering.observer_creation_filetime = "0"),
  ],
  ["missing observer thread", (p) => (p.ordering.thread_id = 0)],
  ["changed observer thread", (p) => p.ordering.thread_id++],
  [
    "mixed observer session",
    (p) => (p.ordering.events[1].session_id = "a".repeat(32)),
  ],
  ["malformed journal", (p) => (p.ordering.events[0].extra = true)],
  ["sequence gap", (p) => (p.ordering.events[1].sequence = "3")],
  ["duplicate sequence", (p) => (p.ordering.events[1].sequence = "1")],
  ["counter reversal", (p) => (p.ordering.events[1].qpc_begin = "0")],
  [
    "invalid bracket",
    (p) =>
      (p.ordering.events[0].qpc_end = String(
        BigInt(p.ordering.events[0].qpc_begin) - 1n,
      )),
  ],
  [
    "counter overflow",
    (p) => (p.ordering.events[0].qpc_begin = String(1n << 63n)),
  ],
  ["journal overflow", (p) => (p.ordering.overflow = true)],
  ["incomplete journal", (p) => (p.ordering.complete = false)],
  ["wrong record count", (p) => p.ordering.record_count--],
  [
    "missing native wait",
    (p) =>
      (p.ordering.events.find((e) => e.kind === "exit").details.wait_result =
        258),
  ],
  [
    "resume before assignment disguised by sorted counters",
    (p) => {
      const a = p.ordering.events.find((e) => e.kind === "assign"),
        r = p.ordering.events.find((e) => e.kind === "resume");
      [a.kind, r.kind] = [r.kind, a.kind];
      [a.subject, r.subject] = [r.subject, a.subject];
      [a.details, r.details] = [r.details, a.details];
    },
  ],
  [
    "zero before exit with increasing counters",
    (p) => {
      const x = p.ordering.events.find((e) => e.kind === "exit"),
        z = p.ordering.events.find(
          (e) => e.kind === "account" && e.details.purpose === "completion",
        );
      [x.kind, z.kind] = [z.kind, x.kind];
      [x.subject, z.subject] = [z.subject, x.subject];
      [x.details, z.details] = [z.details, x.details];
      p.accounting.find((q) => q.purpose === "completion").event_sequence =
        x.sequence;
    },
  ],
  [
    "job release before zero",
    (p) =>
      (p.ordering.events.find((e) => e.kind === "job_release").subject =
        "unrelated"),
  ],
  [
    "wrong native job limits",
    (p) =>
      (p.ordering.events.find((e) => e.kind === "job_ready").details.flags =
        0x2800),
  ],
  [
    "missing journal accounting result",
    (p) => (p.accounting.at(-1).event_sequence = "1"),
  ],
  [
    "duplicate accounting reference",
    (p) =>
      (p.accounting.at(-1).event_sequence = p.accounting[0].event_sequence),
  ],
  ["forced cleanup", (p) => (p.termination_requested = true)],
  [
    "unsafe cleanup result",
    (p) =>
      (p.ordering.events.find((e) => e.kind === "cleanup").details.succeeded =
        false),
  ],
  ["missing genuine root exit", (p) => (p.root_exit_observed = false)],
  ["active owned members", (p) => (p.active_processes = 1)],
  [
    "incomplete history dishonestly complete",
    (p) => {
      p.historical.lifetime_process_count++;
      p.historical.missing_identity_count = 1;
    },
  ],
  [
    "duplicate process binding",
    (p) =>
      (p.historical.identities[1].binding_id =
        p.historical.identities[0].binding_id),
  ],
]) {
  test("synthetic negative rejected: " + name, () => {
    const p = clone(success.ownership);
    edit(p);
    assert.throws(() => validateCompletionProof(p));
  });
}
test("equal QPC ticks still require serialized native transitions", () => {
  const p = clone(success.ownership);
  p.ordering.events.forEach((e) => {
    e.qpc_begin = "0";
    e.qpc_end = "0";
  });
  validateCompletionProof(p);
});
test("UTC adjustments remain visible without defining causal order", () => {
  const p = clone(success.ownership);
  p.ordering.events.forEach(
    (e, n) =>
      (e.utc = new Date(Date.UTC(2026, 9, 19, 0, 0, 100 - n)).toISOString()),
  );
  validateCompletionProof(p);
  assert.ok(utcAnomalies(p).some((a) => a.kind === "audit_clock_reversal"));
});
test("PID reuse with distinct native creation identities remains separate (synthetic)", () => {
  const p = clone(success.ownership),
    i = p.historical.identities[1];
  assert.notEqual(i.creation_filetime, p.root_creation_filetime);
  i.pid = p.root_pid;
  for (const e of p.ordering.events.filter(
    (e) => e.subject === i.binding_id && ["bind", "exit"].includes(e.kind),
  ))
    e.details.pid = i.pid;
  validateCompletionProof(p);
  assert.equal(p.historical.identities.length, 2);
});
for (const [creation, observed] of [
  ["2026-10-19T11:57:46.5790316Z", "2026-10-19T11:57:46.5788419Z"],
  ["2026-10-19T11:58:00.8494603Z", "2026-10-19T11:58:00.8493001Z"],
]) {
  test(
    "old UTC pair is audit-only in a fully synthetic NEW contract fixture: " +
      creation,
    async () => {
      const p = await syntheticProof({
        command: [
          "cargo",
          "build",
          "--workspace",
          "--bins",
          "--examples",
          "--locked",
          "--offline",
        ],
        pid: 12345,
        start: creation,
        exit: "2026-10-19T12:00:00.0000000Z",
        zero: "2026-10-19T12:00:01.0000000Z",
      });
      p.historical.identities[0].observed_utc = observed;
      p.ordering.events.find((e) => e.kind === "bind").details.observed_utc =
        observed;
      validateCompletionProof(p);
      assert.ok(utcAnomalies(p).length > 0);
    },
  );
}
test("previous failed web artifact cannot be upgraded or retroactively accepted", async () => {
  const old = await read(
    path.join(
      ROOT,
      ".tools/phase9-focused/executor-v1-292f884d2c7f42c88e07cefd3dbaf3ce/build-web/ownership.json",
    ),
  );
  assert.throws(() => legacy(old), /E_NATIVE_IDENTITY_TIME/);
  assert.throws(
    () => validateCompletionProof(old),
    /E_COMPLETION_CONTRACT_VERSION/,
  );
  const disguised = clone(old);
  disguised.contract_version = 3;
  assert.throws(() => validateCompletionProof(disguised));
});
test("BigInt preserves FILETIME fractional precision", () =>
  assert.equal(
    nativeTime("2026-10-19T11:57:46.5790316Z"),
    134368846665790316n,
  ));
test("one 100ns boundary is exact", () =>
  assert.equal(
    nativeTime("2026-10-19T11:57:47.0000000Z") -
      nativeTime("2026-10-19T11:57:46.9999999Z"),
    1n,
  ));
test("QPC values above safe Number range preserve exact ordered ticks", () => {
  const p = clone(success.ownership),
    offset = 1n << 54n;
  for (const e of p.ordering.events) {
    e.qpc_begin = String(BigInt(e.qpc_begin) + offset);
    e.qpc_end = String(BigInt(e.qpc_end) + offset);
  }
  validateCompletionProof(p);
});
for (const v of [
  "2026-02-30T00:00:00.0000000Z",
  "2026-10-19T11:57:46.57903161Z",
  "bad",
  "2026-10-19T11:57:46.5790316",
])
  test("malformed native timestamp rejected: " + v, () =>
    assert.throws(() => nativeTime(v)),
  );
test("native creation ISO truncation remains an identity mismatch", () => {
  const p = clone(success.ownership);
  p.historical.identities[0].creation_utc = new Date(
    p.historical.identities[0].creation_utc,
  ).toISOString();
  assert.throws(() => validateCompletionProof(p));
});

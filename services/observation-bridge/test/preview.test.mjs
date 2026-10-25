import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createObservationPreview,
  observeOnlyTransport,
  validateObservations,
} from "../preview.mjs";
import { assertContextTarget, createContextReader } from "../context.mjs";
import { reviewDeployment } from "../review.mjs";
import { scannerChild, allocatorFixture } from "./process-fixtures.mjs";
import { allocateInternal } from "../../../apps/web/src/issuance.mjs";
import { readFile } from "node:fs/promises";
const id = (n) => n.toString(16).padStart(64, "0");
const context = () => ({
  version: 1,
  network: "testnet",
  market_id: "synthetic",
  vault_context_ref: "vault",
  account_ref: "11111111-1111-4111-8111-111111111111",
  endpoint_ref: "https://testnet.example.invalid:443",
  revision: "0",
  hold: false,
  profile_ref: "phase9-exact-chainclock-3-v1",
  closes_at_us: "1800000000000000",
  anchor_height: 100,
  anchor_hash: id(100),
  receipts: [],
  unmapped: [],
});
const output = () => ({
  txid: id(1001),
  pool: "IRONWOOD",
  output_index: 0,
  amount_zat: "1000",
  is_change: false,
  key_scope: 0,
  present: true,
  receiver_verified: true,
  canonical: false,
  block_height: 101,
  block_hash: id(101),
  block_time: 1800000000,
  tx_index: 1,
  receiver_ref: "utest1qqqqqq",
  diversifier_ref: "external:" + "01".repeat(11),
  ticket_id: id(1),
  journal_commitment: id(2),
});
test("observation preview is redacted, unverified and exposes no mutation operations", async () => {
  let calls = 0;
  const p = createObservationPreview({
    readContext: async () => context(),
    observe: async () => {
      calls++;
      return { outputs: [output()] };
    },
    reconcile: () => assert.fail("write"),
  });
  assert.deepEqual(Object.keys(p), ["check"]);
  assert.deepEqual(await p.check(), {
    mode: "OBSERVATION_ONLY",
    status: "OBSERVED_UNVERIFIED",
    acceptance: "NOT_EVALUATED",
    financial_authorization: "NOT_GRANTED",
    spending_enabled: false,
  });
  assert.equal(calls, 1);
  assert(!JSON.stringify(await p.check()).includes(id(1)));
});
test("hold prevents observing; empty result cannot imply payment absence or acceptance", async () => {
  const held = createObservationPreview({
    readContext: async () => ({ ...context(), hold: true }),
    observe: () => assert.fail("held"),
  });
  assert.equal((await held.check()).status, "SAFETY_HOLD");
  assert.equal(
    (
      await createObservationPreview({
        readContext: async () => context(),
        observe: async () => ({ outputs: [] }),
      }).check()
    ).status,
    "NO_OBSERVATION",
  );
});
test("context revision/binding changes fail without automatic retry", async () => {
  let reads = 0,
    observes = 0;
  const p = createObservationPreview({
    readContext: async () => ({ ...context(), revision: String(reads++) }),
    observe: async () => {
      observes++;
      return { outputs: [] };
    },
  });
  await assert.rejects(p.check(), /OBSERVATION_RETRY_REQUIRED/);
  assert.equal(observes, 1);
  const secretBearing = createObservationPreview({
    readContext: async () => ({ ...context(), viewing_key: "forbidden" }),
    observe: () => assert.fail("unexpected field must not reach child"),
  });
  await assert.rejects(secretBearing.check(), /OBSERVATION_UNAVAILABLE/);
});
test("unchanged SQL numeric close-microseconds representation remains supported without rounding", async () => {
  const base = context();
  for (const close of ["1800000000000000", "1800000000000000.000000"]) {
    const p = createObservationPreview({
      readContext: async () => ({ ...base, closes_at_us: close }),
      observe: async () => ({ outputs: [] }),
    });
    assert.equal((await p.check()).acceptance, "NOT_EVALUATED");
  }
  for (const close of ["1800000000000000.1", "1e15", "-1", "NaN"]) {
    const p = createObservationPreview({
      readContext: async () => ({ ...base, closes_at_us: close }),
      observe: async () => ({ outputs: [] }),
    });
    await assert.rejects(p.check(), /OBSERVATION_UNAVAILABLE/);
  }
});
test("malformed, duplicate, falsely canonical, transparent and secret-bearing observations reject", () => {
  for (const o of [
    { ...output(), canonical: true },
    { ...output(), pool: "TRANSPARENT" },
    { ...output(), amount_zat: "1.2" },
    { ...output(), amount_zat: "-1" },
    { ...output(), output_index: 4294967296 },
    { ...output(), receiver_verified: true, ticket_id: null },
    { ...output(), key_scope: 1 },
    { ...output(), claim_secret: "forbidden" },
  ])
    assert.throws(
      () => validateObservations({ outputs: [o] }),
      /OBSERVATION_UNAVAILABLE/,
    );
  assert.throws(() => validateObservations({ outputs: [output(), output()] }));
  assert.throws(() =>
    validateObservations({ outputs: [], chain: { verified: true } }),
  );
  assert.throws(() =>
    validateObservations({ outputs: Array(4097).fill(output()) }),
  );
});
test("existing framed transport is observe-only and preserves private environment separation", async () => {
  const t = observeOnlyTransport(scannerChild({ observed: [output()] }));
  try {
    assert.deepEqual(Object.keys(t), ["observe", "close"]);
    assert.deepEqual(await t.observe(context()), { outputs: [output()] });
    assert.deepEqual(await t.observe(context()), { outputs: [output()] });
  } finally {
    await t.close();
  }
});
test("malformed child frame and interrupted child fail closed; a separate fresh worker recovers", async () => {
  for (const mode of ["malformed", "exit-observe"]) {
    const t = observeOnlyTransport(scannerChild({ mode }));
    try {
      await assert.rejects(t.observe(context()), /OBSERVATION_UNAVAILABLE/);
    } finally {
      await t.close();
    }
  }
  const recovered = observeOnlyTransport(scannerChild());
  try {
    assert.deepEqual(await recovered.observe(context()), { outputs: [] });
  } finally {
    await recovered.close();
  }
});
test("existing allocator TCP framing binds market/vault/ticket/commitment and same-attempt recovery", async () => {
  const a = await allocatorFixture({
    market: "synthetic",
    vault: "vault",
    addresses: ["utest1qqqqqq", "utest1pppppp"],
  });
  const env = {
    ALLOCATION_AUTH: a.auth,
    ALLOCATION_PORT: a.port,
    DARKPOOL_PG_ENV: "TEST",
  };
  const c = {
    market_id: "synthetic",
    vault_context_ref: "vault",
    ticket_id: id(1),
    claim_commitment: id(2),
  };
  try {
    a.controls.loseReply = true;
    await assert.rejects(allocateInternal(c, env));
    const original = await allocateInternal(c, env);
    assert.deepEqual(await allocateInternal(c, env), original);
    assert.equal(a.journal.size, 1);
    for (const change of [
      { market_id: "other" },
      { vault_context_ref: "other" },
      { claim_commitment: id(3) },
    ])
      await assert.rejects(allocateInternal({ ...c, ...change }, env));
    await assert.rejects(
      allocateInternal(c, { ...env, ALLOCATION_AUTH: id(99) }),
    );
    assert.equal(a.journal.size, 1);
  } finally {
    await a.close();
  }
});
test("context-only sessions reject protected/default/owner targets and environment overrides", () => {
  const env = {
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    DARKPOOL_OBSERVATION_ONLY: "1",
    DARKPOOL_LIFECYCLE_TEST_ONLY: "1",
    DARKPOOL_PG_ENV: "TEST",
    DARKPOOL_TEST_ONLY: "TEST_ONLY",
    PGHOST: "127.0.0.1",
    PGPORT: "55433",
    PGDATABASE: "darkpool_phase9_0123456789abcdef",
    PGUSER: "darkpool_observe_0123456789abcdef",
    PGPASSWORD: "synthetic",
    DARKPOOL_PG_PROFILE: "synthetic",
  };
  assert.doesNotThrow(() => assertContextTarget(env));
  for (const PGPORT of [undefined, "5432", "55432", "55434", "55435"])
    assert.throws(() => createContextReader({ ...env, PGPORT }));
  for (const change of [
    { PGUSER: "darkpool_test_maintenance" },
    { PGDATABASE: "postgres" },
    { WALLET_DB_PATH: "forbidden" },
    { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
    { PGOPTIONS: "override" },
    { DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2" },
  ])
    assert.throws(() => createContextReader({ ...env, ...change }));
});
test("readiness report cannot activate real processes or trust and runner has literal entrypoints", async () => {
  assert.equal(reviewDeployment().real_process_launch_enabled, false);
  assert.equal(reviewDeployment().production_trust, "UNAVAILABLE");
  const runner = await readFile(
    new URL(
      "../../../scripts/dev/observation-bridge-tests.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    runner,
    /watcher\.test\.mjs|issuance\.test\.mjs|cargo test|npm\s+(run\s+)?test|serve-watcher|serve-allocation/,
  );
  assert.match(runner, /db\/test\/observation-bridge\.test\.mjs/);
});

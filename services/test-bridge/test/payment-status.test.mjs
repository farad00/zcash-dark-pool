import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  paymentStatusPacket,
  paymentStatusResult,
  paymentStatusText,
} from "../../../apps/web/src/payment-status-wire.mjs";
import {
  assertBridgeTarget,
  createTestPaymentStatus,
} from "../payment-status.mjs";
import { createIssuanceServer } from "../../../apps/web/src/issuance-server.mjs";

const packet = () => ({
  market_id: "synthetic",
  ticket_id: "12".repeat(32),
  issuance_token: "34".repeat(32),
});
const result = (status) => ({
  status,
  environment: "SYNTHETIC_TEST_ONLY",
  financial_authorization: "NOT_GRANTED",
});
const env = () => ({
  APP_ENV: "development",
  ZCASH_NETWORK: "testnet",
  DARKPOOL_BRIDGE_TEST_ONLY: "1",
  DARKPOOL_LIFECYCLE_TEST_ONLY: "1",
  DARKPOOL_PG_ENV: "TEST",
  DARKPOOL_TEST_ONLY: "TEST_ONLY",
  PGHOST: "127.0.0.1",
  PGPORT: "55433",
  PGDATABASE: "darkpool_phase9_0123456789abcdef",
  PGUSER: "darkpool_e2e_other_0123456789abcdef",
  PGPASSWORD: "synthetic",
  DARKPOOL_PG_PROFILE: "synthetic",
});
test("private status uses only the existing issuance capability and bounded canonical identifiers", () => {
  assert.deepEqual(paymentStatusPacket(packet()), packet());
  for (const extra of [
    { issuance_token: "bad" },
    { ticket_id: "FF".repeat(32) },
    { market_id: "\0" },
    { market_id: "\ud800" },
    { market_id: "x".repeat(8193) },
    { side: "YES" },
    { claim_secret: "secret" },
  ])
    assert.throws(
      () => paymentStatusPacket({ ...packet(), ...extra }),
      /PAYMENT_STATUS_UNAVAILABLE/,
    );
});
test("status projection cannot carry private data or imply financial authorization", () => {
  for (const state of ["CONFIRMED", "AWAITING_PAYMENT", "UNAVAILABLE"]) {
    assert.deepEqual(paymentStatusResult(result(state)), result(state));
    assert.match(paymentStatusText(result(state)), /SYNTHETIC TEST ONLY/);
    assert.match(paymentStatusText(result(state)), /NOT_GRANTED/);
  }
  for (const extra of [
    { side: "YES" },
    { amount: "100" },
    { status: "PAID" },
    { environment: "LIVE" },
    { financial_authorization: "GRANTED" },
  ])
    assert.throws(() =>
      paymentStatusResult({ ...result("CONFIRMED"), ...extra }),
    );
});
test("TEST bridge rejects protected, default, owner, cross-fixture and unsafe targets before SQL", () => {
  assert.doesNotThrow(() => assertBridgeTarget(env()));
  for (const port of [undefined, "5432", "55432", "55434", "55435"])
    assert.throws(() => createTestPaymentStatus({ ...env(), PGPORT: port }));
  for (const extra of [
    { DARKPOOL_BRIDGE_TEST_ONLY: "0" },
    { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
    { PGUSER: "darkpool_test_maintenance" },
    { PGUSER: "darkpool_e2e_other_ffffffffffffffff" },
    { PGDATABASE: "postgres" },
    { PGOPTIONS: "-c role=owner" },
    { WALLET_DB_PATH: "forbidden" },
    { DARKPOOL_LIVE_INSTANCE: "payment_v2" },
    { PGSERVICEFILE: "forbidden" },
    { PGHOST: "localhost" },
  ])
    assert.throws(() => createTestPaymentStatus({ ...env(), ...extra }));
});
test("same-origin private POST, strict bytes, safe errors, limits, default unavailable and no private output", async () => {
  let calls = 0,
    malicious = false;
  const server = createIssuanceServer({
    issue: async () => {
      throw Error("unused");
    },
    paymentStatus: async () => {
      calls++;
      if (malicious) throw Error(JSON.stringify(packet()));
      return result("CONFIRMED");
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = packet(), extra = {}) =>
    fetch(base + "/api/payment-status", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json", ...extra },
      body:
        typeof body === "string" || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base + "/api/payment-status")).status, 405);
    assert.equal(
      (await fetch(base + "/api/payment-status?token=forbidden")).status,
      400,
    );
    assert.equal(
      (await post(packet(), { Origin: "https://other.invalid" })).status,
      403,
    );
    for (const input of [
      Buffer.from([0xff]),
      JSON.stringify(packet()) + " ",
      '{"a":1,"a":2}',
    ])
      assert.equal((await post(input)).status, 400);
    assert.equal((await post("x".repeat(16385))).status, 413);
    assert.equal(calls, 0);
    const good = await post();
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal(good.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await good.json(), result("CONFIRMED"));
    malicious = true;
    assert.deepEqual(await (await post()).json(), {
      error: "PAYMENT_STATUS_UNAVAILABLE",
    });
    for (let i = 0; i < 125; i++) {
      const r = await post();
      if (r.status === 429) {
        assert.equal(r.status, 429);
        return;
      }
    }
    assert.fail("request budget not enforced");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("unconfigured server never enables status and rejects extra private response fields", async () => {
  for (const options of [
    {},
    { paymentStatus: async () => ({ ...result("CONFIRMED"), side: "YES" }) },
  ]) {
    const s = createIssuanceServer({
      ...options,
      issue: async () => {
        throw Error("unused");
      },
    });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${s.address().port}`;
    try {
      const response = await fetch(base + "/api/payment-status", {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(packet()),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "PAYMENT_STATUS_UNAVAILABLE",
      });
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }
});
test("runner has literal wallet-free test entrypoints and no dependency test discovery", async () => {
  const source = await readFile(
    new URL(
      "../../../scripts/dev/operational-bridge-tests.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /issuance\.test\.mjs|watcher[\\/]test|watcher\.test\.mjs|npm\s+(run\s+)?test|node\s+--test\s*\*/,
  );
  assert.match(source, /db\/test\/operational-bridge\.test\.mjs/);
  assert.match(source, /wallet_initialization_authorized=\$false/);
});

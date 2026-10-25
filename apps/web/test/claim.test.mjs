import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createClaimServer, NOT_CONFIRMED } from "../src/claim-server.mjs";
import { parseClaimJson, validateClaimPacket } from "../src/claim-wire.mjs";
import {
  assertParticipantTarget,
  createParticipantClaims,
} from "../../../services/claims/participant.mjs";
import { launchBrowser } from "./vault-browser.mjs";

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
});
async function serve(options) {
  const s = createClaimServer(options);
  servers.push(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${s.address().port}`;
}
const packet = () => ({
  market_id: "synthetic",
  ticket_id: "12".repeat(32),
  claim_secret: "34".repeat(32),
  payout_ua: "utest1qqqqqq",
  idempotency_key: `participant_v1_${"12".repeat(32)}`,
});
const post = (base, path, body, extra = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("strict bounded canonical transport, original secret size and fixed retry identity", () => {
  assert.deepEqual(
    validateClaimPacket(parseClaimJson(Buffer.from(JSON.stringify(packet())))),
    packet(),
  );
  for (const text of [
    '{"x":1,"x":2}',
    JSON.stringify(packet()) + " ",
    '{"x":"\\ud800"}',
    "[]",
  ]) {
    assert.throws(() => validateClaimPacket(parseClaimJson(Buffer.from(text))));
  }
  for (const bytes of [Buffer.from([0xc0, 0x80]), Buffer.alloc(16385)])
    assert.throws(() => parseClaimJson(bytes));
  for (const change of [
    { claim_secret: "00" },
    { claim_secret: Array(64).fill(0) },
    { ticket_id: "FF".repeat(32) },
    { market_id: "a\0b" },
    { idempotency_key: "new" },
    { payout_ua: "tmTransparent" },
    { amount: "1" },
  ])
    assert.throws(() => validateClaimPacket({ ...packet(), ...change }));
});
test("protected/default targets including development V2 rejected before SQL", async () => {
  const e = {
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    DARKPOOL_PG_ENV: "TEST",
    DARKPOOL_TEST_ONLY: "TEST_ONLY",
    PGHOST: "127.0.0.1",
    PGPORT: "55433",
    PGDATABASE: "darkpool_phase9_0123456789abcdef",
    PGUSER: "darkpool_claim_0123456789abcdef",
    PGPASSWORD: "synthetic",
    DARKPOOL_PG_PROFILE: "synthetic",
  };
  assert.doesNotThrow(() => assertParticipantTarget(e));
  for (const port of [undefined, "55432", "55434", "55435", "5432"]) {
    await assert.rejects(
      createParticipantClaims({ env: { ...e, PGPORT: port } }),
      /CLAIM_NOT_CONFIRMED/,
    );
  }
  for (const extra of [
    { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
    { PGDATABASE: "darkpool_phase9_development_payment_v2" },
    { PGUSER: "darkpool_test_maintenance" },
    { PGOPTIONS: "-c role=owner" },
    { WALLET_DB_PATH: "x" },
  ])
    assert.throws(() => assertParticipantTarget({ ...e, ...extra }));
});
test("claim page headers, static dependencies and unavailable default", async () => {
  const base = await serve();
  const r = await fetch(base + "/claim");
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(
    r.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.doesNotMatch(html, /<form|https?:\/\/|analytics|style=/);
  assert.match(html, /bearer credential/);
  assert.equal((await fetch(base + "/claim-ui.mjs")).status, 200);
  assert.equal((await fetch(base + "/local-vault.mjs")).status, 200);
  assert.deepEqual(
    await (await post(base, "/api/claim", packet())).json(),
    NOT_CONFIRMED,
  );
  assert.equal(
    (await fetch(base + "/api/claim-market")).headers.get("cache-control"),
    "no-store",
  );
});
test("POST-only, exact origin, no queries, strict UTF8 and input bounds", async () => {
  let calls = 0;
  const base = await serve({
    claims: {
      mode: "EXTERNAL_REQUIRED",
      reserve: async () => {
        calls++;
        throw new Error("private diagnostics");
      },
    },
  });
  assert.equal((await fetch(base + "/api/claim")).status, 405);
  for (const [path, headers, body, status] of [
    ["/api/claim?secret=not-a-real-secret", {}, packet(), 400],
    ["/api/claim", { Origin: "https://other.invalid" }, packet(), 403],
    ["/api/claim", { "Content-Type": "text/plain" }, packet(), 403],
    ["/api/claim", { "Sec-Fetch-Site": "cross-site" }, packet(), 403],
    ["/api/claim", {}, "x".repeat(16385), 413],
    ["/api/claim", {}, '{"claim_secret":1,"claim_secret":2}', 409],
    ["/api/claim", {}, Buffer.from([0xff]), 409],
  ]) {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json", ...headers },
      body: Buffer.isBuffer(body)
        ? body
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
    });
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), NOT_CONFIRMED);
  }
  assert.equal(calls, 0);
});
test("generic errors and strict successful output projection redact private fields", async () => {
  let reject = true;
  const base = await serve({
    claims: {
      mode: "SYNTHETIC_TEST_ONLY",
      reserve: async () => {
        if (reject) throw new Error(JSON.stringify(packet()));
        return {
          status: "RESERVED",
          payment: "NOT_SENT",
          environment: "SYNTHETIC_TEST_ONLY",
          ...packet(),
          side: "YES",
          amount: "123",
        };
      },
    },
  });
  const failed = await post(base, "/api/claim", packet());
  assert.equal(failed.status, 409);
  assert.deepEqual(await failed.json(), NOT_CONFIRMED);
  reject = false;
  const good = await post(base, "/api/claim", packet());
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), {
    status: "RESERVED",
    payment: "NOT_SENT",
    environment: "SYNTHETIC_TEST_ONLY",
  });
  assert.equal(good.headers.get("cache-control"), "no-store");
});
test("global bounded rate limiter cannot be bypassed with forwarded IP", async () => {
  const base = await serve();
  for (let i = 0; i < 60; i++)
    assert.equal((await fetch(base + "/api/claim-market")).status, 200);
  assert.equal(
    (await post(base, "/api/claim", packet(), { "X-Forwarded-For": "new" }))
      .status,
    429,
  );
});
test("four in-flight limit rejects excess without invoking a fifth service", async () => {
  const waiting = [];
  let count = 0;
  const base = await serve({
    claims: {
      mode: "EXTERNAL_REQUIRED",
      reserve: () =>
        new Promise((r) => {
          count++;
          waiting.push(r);
        }),
    },
  });
  const pending = Array.from({ length: 4 }, () =>
    post(base, "/api/claim", packet()),
  );
  for (let i = 0; i < 100 && count < 4; i++)
    await new Promise((r) => setTimeout(r, 10));
  try {
    assert.equal(count, 4);
    assert.equal((await post(base, "/api/claim", packet())).status, 429);
    assert.equal(count, 4);
  } finally {
    waiting.forEach((r) =>
      r({
        status: "RESERVED",
        payment: "NOT_SENT",
        environment: "EXTERNAL_REQUIRED",
      }),
    );
    await Promise.all(pending);
  }
});

test(
  "browser vault selection, original backup import, pending status and review before private POST",
  { timeout: 45000 },
  async () => {
    let state = "LOCKED",
      submitted = 0;
    const captured = [];
    const market = {
      market_id: "synthetic-browser",
      version: 1,
      network: "testnet",
      question: "Synthetic event?",
      yes_definition: "Yes",
      no_definition: "No",
      opens_at: "2026-10-01T00:00:00.000000Z",
      closes_at: "2026-10-02T00:00:00.000000Z",
      resolution_rule: "Synthetic rule",
      resolution_sources: ["synthetic"],
      void_conditions: ["void"],
    };
    const base = await serve({
      readMarket: async () => [{ ...market, status: state }],
      claims: {
        mode: "SYNTHETIC_TEST_ONLY",
        reserve: async (p) => {
          submitted++;
          captured.push(p);
          return {
            status: "RESERVED",
            payment: "NOT_SENT",
            environment: "SYNTHETIC_TEST_ONLY",
          };
        },
      },
    });
    const browser = await launchBrowser();
    const run = (body) => browser.evaluate(`(async()=>{${body}})()`);
    const wait = async (expr) => {
      for (let i = 0; i < 100; i++) {
        if (await browser.evaluate(expr)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("Browser UI timeout");
    };
    try {
      await browser.navigate(base + "/claim");
      await wait("!document.getElementById('import').disabled");
      await run(
        `const v=await (await import('/local-vault.mjs')).openLocalVault();const id=await v.createDraft();await v.finalize(id,{version:1,network:'testnet',market_id:'synthetic-browser',ticket_id:'12'.repeat(32)});await v.recordIssued(id,{version:1,network:'testnet',market_id:'synthetic-browser',ticket_id:'12'.repeat(32)});v.close();`,
      );
      await browser.navigate(base + "/claim");
      await wait("document.querySelectorAll('#ticket option').length===2");
      assert.match(
        await browser.evaluate(
          "document.getElementById('market-status').textContent",
        ),
        /pending/,
      );
      await run(
        `document.getElementById('ticket').value='1';document.getElementById('address').value='utest1qqqqqq';document.getElementById('check').click();`,
      );
      await wait("!document.getElementById('check').disabled");
      assert.equal(submitted, 0);
      assert.equal(
        await browser.evaluate("document.getElementById('submit').disabled"),
        true,
      );
      state = "PAYING";
      await run("document.getElementById('refresh-market').click()");
      await wait(
        "document.getElementById('market-status').textContent.includes('PAYING') && !document.getElementById('refresh-market').disabled",
      );
      assert.match(
        await browser.evaluate(
          "document.getElementById('eligibility').textContent",
        ),
        /Market ready for private claims/,
      );
      // Import uses the actual original backup codec and File input; no secret URL.
      await run(
        `const {encodeTicketBackup}=await import('/ticket-backup.mjs');const content=encodeTicketBackup({version:1,network:'testnet',market_id:'synthetic-browser',ticket_id:'56'.repeat(32),claim_secret:new Uint8Array(32).fill(7)});const dt=new DataTransfer();dt.items.add(new File([content],'synthetic.json',{type:'application/json'}));document.getElementById('backup').files=dt.files;document.getElementById('import').click();`,
      );
      await wait("document.querySelectorAll('#ticket option').length===3");
      await run(
        `const dt=new DataTransfer();dt.items.add(new File(['invalid'],'bad.json'));document.getElementById('backup').files=dt.files;document.getElementById('import').click();`,
      );
      await wait("!document.getElementById('import').disabled");
      assert.equal(
        await browser.evaluate(
          "document.querySelectorAll('#ticket option').length",
        ),
        3,
      );
      // Stateless native fixture produces synthetic UAs only, no wallet initialization.
      const { privateProcess } =
        await import("../../../services/backup/crypto.mjs");
      const { resolve } = await import("node:path");
      const addresses = JSON.parse(
        (
          await privateProcess(
            resolve("target/debug/examples/phase14-claim-fixture.exe"),
            [],
            Buffer.alloc(0),
            16384,
            { DARKPOOL_SYNTHETIC_TEST: "1" },
          )
        ).toString(),
      );
      await run(
        `document.getElementById('ticket').value='2';document.getElementById('address').value=${JSON.stringify(addresses[3])};document.getElementById('check').click();`,
      );
      await wait("!document.getElementById('submit').disabled");
      assert.equal(submitted, 0);
      assert.match(
        await browser.evaluate(
          "document.getElementById('review-text').textContent",
        ),
        /Send the claim credential privately/,
      );
      await run("document.getElementById('submit').click();");
      await wait(
        "document.getElementById('message').textContent.includes('Claim reserved')",
      );
      assert.equal(submitted, 1);
      assert.equal(
        await browser.evaluate(
          "document.getElementById('claim-result').dataset.claimStatus",
        ),
        "RESERVED",
      );
      assert.equal(captured[0].ticket_id, "56".repeat(32));
      assert.equal(captured[0].claim_secret, "07".repeat(32));
      assert.match(
        await browser.evaluate(
          "document.getElementById('message').textContent",
        ),
        /SYNTHETIC TEST ONLY/,
      );
      assert.equal(await browser.evaluate("location.href"), base + "/claim");
      const requests = browser.events
        .filter((e) => e.method === "Network.requestWillBeSent")
        .map((e) => e.params.request);
      assert(
        requests.every(
          (r) => r.url.startsWith(base + "/") || r.url === "about:blank",
        ),
      );
      assert(
        requests.every(
          (r) =>
            !r.url.includes(captured[0].claim_secret) &&
            !r.url.includes(addresses[3]),
        ),
      );
      assert.equal(
        requests.filter((r) => r.url === base + "/api/claim")[0].method,
        "POST",
      );
    } finally {
      await browser.stop();
    }
  },
);

// Browser-only dispatch regression. Mock HTTP responses, no database or wallet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "../../apps/web/test/vault-browser.mjs";

test("Step 2 prerequisites, rejected bypass, replaced buttons and visible action results", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url));
  const script = await readFile(new URL("./ui.mjs", import.meta.url));
  const requests = [];
  const status = {
    market_id: "synthetic-ui-dispatch-test",
    closes_at: "2026-01-01T00:00:00Z",
    state: "OPEN",
    commitment: null,
    publication: "PENDING",
    resolution: "PENDING",
    simulated_deposit: false,
    financial_authorization: "NOT_GRANTED",
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'",
    );
    if (req.url === "/demo") {
      res.setHeader("Content-Type", "text/html");
      return res.end(html);
    }
    if (req.url === "/demo-ui.mjs") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(script);
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/demo-status") return res.end(JSON.stringify(status));
    if (req.url !== "/api/demo-action" || req.method !== "POST") {
      res.statusCode = 404;
      return res.end("{}");
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const packet = JSON.parse(body);
    requests.push(packet);
    await new Promise((r) => setTimeout(r, 40));
    if (packet.action === "simulate") status.simulated_deposit = true;
    if (packet.action === "lock") {
      status.state = "LOCKED";
      status.commitment = {
        accepted_ticket_count: "3",
        merkle_root: "ab".repeat(32),
      };
    }
    res.statusCode = packet.action === "YES" ? 409 : 200;
    res.end(JSON.stringify(status));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("DEMO_DISPATCH_NOT_CONFIRMED");
  };
  try {
    browser = await launchBrowser();
    await browser.navigate(`http://127.0.0.1:${server.address().port}/demo`);
    await wait(() =>
      browser.evaluate(
        "document.getElementById('status').textContent.includes('Ready')",
      ),
    );
    assert.equal(
      await browser.evaluate(
        "document.querySelector('[data-action=YES]').disabled",
      ),
      true,
    );
    assert.equal(
      await browser.evaluate(
        "document.querySelector('[data-action=lock]').disabled",
      ),
      true,
    );
    // Even a client-side bypass is rejected by the server; no guard is inferred from UI state.
    await browser.evaluate(
      "document.querySelector('[data-action=YES]').disabled=false; document.querySelector('[data-action=YES]').click()",
    );
    await wait(() =>
      browser.evaluate(
        "document.getElementById('status').dataset.actionState==='NOT_CONFIRMED'",
      ),
    );
    assert.deepEqual(requests, [{ action: "YES" }]);
    // Reproduce missing per-node listeners while status polling and YES still work.
    // No assertion is made that the operator's original DOM was replaced.
    await browser.evaluate(`for (const action of ['simulate','lock']) {
      const original=document.querySelector('[data-action='+action+']');
      const replacement=original.cloneNode(true);
      const label=document.createElement('span');label.textContent=replacement.textContent;
      replacement.replaceChildren(label);original.replaceWith(replacement);
    }`);
    for (const action of ["simulate", "lock"]) {
      await browser.evaluate(
        `document.querySelector('[data-action=${action}] span').click(); document.querySelector('[data-action=${action}] span').click()`,
      );
      await wait(() => requests.some((r) => r.action === action));
      await wait(() =>
        browser.evaluate(
          "document.getElementById('status').dataset.actionState==='COMPLETE'",
        ),
      );
    }
    assert.deepEqual(requests, [
      { action: "YES" },
      { action: "simulate" },
      { action: "lock" },
    ]);
    assert.equal(
      await browser.evaluate(
        "JSON.parse(document.getElementById('root').textContent).accepted_ticket_count",
      ),
      "3",
    );
    assert.match(
      await browser.evaluate("document.getElementById('status').textContent"),
      /Immutable ledger locked/,
    );
    assert.match(
      await browser.evaluate(
        "document.getElementById('next-action').textContent",
      ),
      /resolve YES, NO or VOID/,
    );
    assert.equal(
      await browser.evaluate(
        "document.querySelector('[data-action=simulate]').disabled",
      ),
      true,
    );
    assert.equal(
      await browser.evaluate(
        "document.querySelector('[data-action=YES]').disabled",
      ),
      false,
    );
    await browser.evaluate(
      "const b=document.createElement('button');b.dataset.action='invalid';document.body.append(b);b.click()",
    );
    assert.equal(requests.length, 3);
  } finally {
    await browser?.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("payment panel replaces waiting copy, clears stale acceptance and rejects malformed status", async () => {
  const files = new Map([
    [
      "/payment-ui.mjs",
      new URL("../../apps/web/src/payment-ui.mjs", import.meta.url),
    ],
    [
      "/payment-status-wire.mjs",
      new URL("../../apps/web/src/payment-status-wire.mjs", import.meta.url),
    ],
    [
      "/money.js",
      new URL("../../packages/protocol/dist/money.js", import.meta.url),
    ],
  ]);
  const server = createServer(async (req, res) => {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end('<!doctype html><div id="payment"></div>');
    }
    if (!files.has(req.url)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(files.get(req.url)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await launchBrowser();
    await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
    const result = await browser.evaluate(`(async()=>{
      const {createPaymentPanel}=await import('/payment-ui.mjs');
      const root=document.getElementById('payment');const panel=createPaymentPanel(root);
      try {
        panel.show({closes_at:'2099-01-01T00:00:00.000000Z',close_time_ms:Date.now()+60000,amount:'0.00001',receiving_ua:'utest1qqqqqq',uri:'zcash:utest1qqqqqq?amount=0.00001'});
        panel.updateStatus({status:'CONFIRMED',environment:'SYNTHETIC_TEST_ONLY',financial_authorization:'NOT_GRANTED'});
        const confirmed=root.dataset.paymentStatus==='CONFIRMED'&&!root.textContent.includes('Send exactly');
        panel.updateStatus({status:'DETECTED',environment:'TESTNET_OBSERVATION',financial_authorization:'NOT_GRANTED'});
        const changed=!root.textContent.includes('Accepted. Do not send')&&root.textContent.includes('not accepted');
        panel.markUnavailable();const unavailable=root.dataset.paymentStatus==='UNAVAILABLE'&&!root.textContent.includes('Accepted.');
        let rejected=false;try{panel.updateStatus({status:'CONFIRMED',environment:'SYNTHETIC_TEST_ONLY',financial_authorization:'GRANTED'});}catch{rejected=true;}
        return {confirmed,changed,unavailable,rejected};
      }finally{panel.clear();}
    })()`);
    assert.deepEqual(result, {
      confirmed: true,
      changed: true,
      unavailable: true,
      rejected: true,
    });
  } finally {
    await browser?.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

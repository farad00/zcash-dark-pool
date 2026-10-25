// Mocked HTTP only; real browser/IndexedDB, no wallet, SQL or external service.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createIssuanceServer } from "../../apps/web/src/issuance-server.mjs";
import { launchBrowser } from "../../apps/web/test/vault-browser.mjs";

test("late market discovery cannot enable controls or hide a pending private CONFIRMED result", async () => {
  let releaseMarket,
    releaseStatus,
    statusStarted = false,
    reserveCalls = 0;
  const marketGate = new Promise((r) => {
    releaseMarket = r;
  });
  const statusGate = new Promise((r) => {
    releaseStatus = r;
  });
  const mid = "synthetic-browser-render-race";
  const close = "2099-01-01T00:00:00.000000Z";
  const issuer = createIssuanceServer({
    issue: async (packet) => {
      if (packet.operation === "reserve") reserveCalls++;
      return {
        issuance_profile_version: 1,
        network: "testnet",
        market_id: mid,
        ticket_id: "31".repeat(32),
        closes_at: close,
        status: packet.operation === "reserve" ? "RESERVED" : "ISSUED",
        ...(packet.operation === "complete"
          ? { receiving_ua: "utest1qqqqqq" }
          : {}),
      };
    },
    preparePayment: async () => ({
      payment_request_profile_version: 1,
      network: "testnet",
      payment_uri: "zcash:utest1qqqqqq?amount=0.00001",
    }),
    paymentStatus: async () => {
      statusStarted = true;
      await statusGate;
      return {
        status: "CONFIRMED",
        environment: "SYNTHETIC_TEST_ONLY",
        financial_authorization: "NOT_GRANTED",
      };
    },
  });
  const server = createServer(async (req, res) => {
    if (req.url === "/api/market") {
      await marketGate;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          market: {
            network: "testnet",
            market_id: mid,
            question: "Synthetic render race?",
            closes_at: close,
            status: "OPEN",
          },
        }),
      );
    }
    issuer.emit("request", req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("PARTICIPANT_UI_NOT_CONFIRMED");
  };
  try {
    browser = await launchBrowser();
    await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
    await wait(() =>
      browser.evaluate("!document.getElementById('participate').disabled"),
    );
    await browser.evaluate(
      `document.getElementById('market').value=${JSON.stringify(mid)};document.getElementById('side').value='YES';document.getElementById('amount').value='1000';document.getElementById('participate').click()`,
    );
    await wait(() =>
      browser.evaluate(
        "!!document.querySelector('[data-action=payment-status]') && !document.querySelector('[data-action=payment-status]').disabled",
      ),
    );
    await browser.evaluate(
      "document.querySelector('[data-action=payment-status]').click()",
    );
    await wait(() => statusStarted);
    releaseMarket();
    await wait(() =>
      browser.evaluate(
        "document.querySelector('#records li')?.dataset.marketScope==='current'",
      ),
    );
    assert.equal(
      await browser.evaluate(
        "document.querySelector('[data-action=payment-status]').disabled",
      ),
      true,
    );
    assert.equal(
      await browser.evaluate("document.getElementById('participate').disabled"),
      true,
    );
    releaseStatus();
    await wait(() =>
      browser.evaluate(
        "!!document.querySelector('#records [data-payment-status=CONFIRMED]') && !document.querySelector('[data-action=payment-status]').disabled",
      ),
    );
    assert.equal(
      await browser.evaluate(
        "document.getElementById('payment').dataset.paymentStatus",
      ),
      "CONFIRMED",
    );
    assert.match(
      await browser.evaluate("document.getElementById('message').textContent"),
      /CONFIRMED/,
    );
    assert.equal(reserveCalls, 1);
    assert.equal(
      await browser.evaluate("document.querySelectorAll('#records li').length"),
      1,
    );
  } finally {
    releaseMarket();
    releaseStatus();
    await browser?.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

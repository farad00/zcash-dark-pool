import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { privateProcess } from "../../services/backup/crypto.mjs";
import { authority } from "../../services/publication/test/fixtures.mjs";
import {
  withSyntheticLifecycle,
  assertSyntheticLifecycle,
} from "../../db/test/lifecycle-fixtures.mjs";
import { createProductDemo } from "./product.mjs";
import { launchBrowser } from "../../apps/web/test/vault-browser.mjs";
import { MANUAL_DEMO_DURATION_MS, waitForManualStop } from "./session.mjs";

const interactive = process.env.DARKPOOL_SUBMISSION_DEMO === "INTERACTIVE";
const wait = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("DEMO_BROWSER_NOT_CONFIRMED");
};
test(
  "submission product composition: browser -> private status -> lock -> synthetic settlement -> private claim -> unsent intent",
  { timeout: interactive ? MANUAL_DEMO_DURATION_MS + 120000 : 180000 },
  async (t) => {
    assertSyntheticLifecycle();
    const publisher = await authority();
    try {
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
      await withSyntheticLifecycle(
        publisher,
        addresses,
        async (f) => {
          const originalIssue = f.issue;
          let lostReserve = false,
            lostComplete = false;
          if (!interactive)
            f.issue = async (packet) => {
              const result = await originalIssue(packet);
              if (packet.operation === "reserve" && !lostReserve) {
                lostReserve = true;
                throw Error("SYNTHETIC_LOST_RESERVE_REPLY");
              }
              if (packet.operation === "complete" && !lostComplete) {
                lostComplete = true;
                throw Error("SYNTHETIC_LOST_COMPLETION_REPLY");
              }
              return result;
            };
          let stop;
          const stopped = new Promise((r) => (stop = r));
          const { server, state } = await createProductDemo(
            f,
            publisher,
            addresses,
            stop,
          );
          await new Promise((done, reject) => {
            server.once("error", reject);
            server.listen(interactive ? 3002 : 0, "127.0.0.1", done);
          });
          const base = `http://127.0.0.1:${server.address().port}`;
          let browser;
          const post = (path, body, headers = {}) =>
            fetch(base + path, {
              method: "POST",
              headers: {
                Origin: base,
                "Content-Type": "application/json",
                ...headers,
              },
              body: JSON.stringify(body),
            });
          const action = async (value) => {
            const r = await post("/api/demo-action", { action: value });
            assert.equal(r.status, 200);
            return r.json();
          };
          const clickDemo = async (value, expectedStatus = 200) => {
            const previous = browser.events.length;
            const point = await browser.evaluate(`(()=>{
              const b=document.querySelector('button[data-action=${value}]');
              if(!b || b.disabled) throw Error('DEMO_BUTTON_UNAVAILABLE');
              b.scrollIntoView({block:'center'});
              const r=b.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
              if(document.elementFromPoint(x,y)!==b) throw Error('DEMO_BUTTON_OBSCURED');
              return {x,y};
            })()`);
            await browser.call("Input.dispatchMouseEvent", {
              type: "mousePressed",
              button: "left",
              clickCount: 1,
              ...point,
            });
            await browser.call("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              button: "left",
              clickCount: 1,
              ...point,
            });
            let request;
            await wait(() => {
              request = browser.events
                .slice(previous)
                .find(
                  (e) =>
                    e.method === "Network.requestWillBeSent" &&
                    e.params.request.url === base + "/api/demo-action",
                );
              return !!request;
            });
            assert.equal(request.params.request.method, "POST");
            assert.deepEqual(JSON.parse(request.params.request.postData), {
              action: value,
            });
            let response;
            await wait(() => {
              response = browser.events
                .slice(previous)
                .find(
                  (e) =>
                    e.method === "Network.responseReceived" &&
                    e.params.requestId === request.params.requestId,
                );
              return !!response;
            });
            assert.equal(response.params.response.status, expectedStatus);
            await wait(() =>
              browser.evaluate(
                "document.getElementById('status').dataset.actionState!=='SENDING'",
              ),
            );
          };
          try {
            if (interactive) {
              // This is a bounded interactive TEST case, never an operational service.
              console.log(
                `SYNTHETIC_TEST_ONLY demo: ${base}/demo; session ends after 30 minutes; the predeclared issuance close is unchanged. Use Stop for verified cleanup. Never fund requests.`,
              );
              await waitForManualStop(stopped, stop);
              return;
            }
            await t.test(
              "host/origin/method guards and public projection",
              async () => {
                assert.equal(
                  (await fetch(base + "/api/demo-action")).status,
                  405,
                );
                assert.equal(
                  (
                    await post(
                      "/api/demo-action",
                      { action: "VOID" },
                      { Origin: "https://example.invalid" },
                    )
                  ).status,
                  403,
                );
                assert.equal(
                  (await post("/api/demo-action", { action: "VOID" })).status,
                  409,
                );
                assert.equal(
                  (
                    await post("/api/demo-action", {
                      action: "simulate",
                      secret: "not-accepted",
                    })
                  ).status,
                  409,
                );
                assert.equal(
                  (await state()).financial_authorization,
                  "NOT_GRANTED",
                );
                assert.equal(
                  (await fetch(base + "/")).headers.get("cache-control"),
                  "no-store",
                );
              },
            );
            await t.test(
              "a stale market ID reproduces reserve 503 while OPEN, without creating an attempt",
              async () => {
                const r = await post("/api/issuance", {
                  operation: "reserve",
                  issuance_token: "88".repeat(32),
                  market_id: "old-demo-market",
                  side: "YES",
                  requested_amount_zat: "1000",
                });
                assert.equal(r.status, 503);
                assert.deepEqual(await r.json(), {
                  error: "ISSUANCE_UNAVAILABLE",
                });
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.issuance_attempts;",
                  ),
                  "0",
                );
                await assert.rejects(
                  originalIssue({
                    operation: "reserve",
                    issuance_token: "89".repeat(32),
                    market_id: "old-demo-market",
                    side: "YES",
                    requested_amount_zat: "1000",
                  }),
                  (e) =>
                    e.message === "ISSUANCE_UNAVAILABLE" &&
                    e.sqlstate === "P4503",
                );
              },
            );
            browser = await launchBrowser();
            await t.test(
              "1000-zatoshi YES issuance recovers lost reserve and completion replies without duplicate tickets",
              async () => {
                await browser.navigate(base + "/");
                await wait(() =>
                  browser.evaluate(
                    "!document.getElementById('create').disabled && document.getElementById('market').value !== ''",
                  ),
                );
                await browser.evaluate(
                  "document.getElementById('create').click()",
                );
                assert.equal(
                  await browser.evaluate(
                    'document.getElementById("market").value',
                  ),
                  f.mid,
                );
                assert.equal(
                  await browser.evaluate(
                    'document.getElementById("market").readOnly',
                  ),
                  true,
                );
                await wait(() =>
                  browser.evaluate(
                    "document.querySelectorAll('#records li').length===1",
                  ),
                );
                await browser.evaluate(
                  `document.getElementById('side').value='YES'; document.getElementById('amount').value='1000'; document.querySelector('#records button').click();`,
                );
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('message').textContent.includes('could not complete safely') && !document.querySelector('#records button').disabled",
                  ),
                );
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.issuance_attempts;",
                  ),
                  "1",
                );
                assert.equal(
                  await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
                  "0",
                );
                // Keep the saved attempt and original credential. This is the
                // existing recovery button, not another draft or fresh token.
                await browser.evaluate(
                  "[...document.querySelectorAll('#records button')].find(b=>b.textContent==='Retry saved attempt').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "!document.querySelector('#records button').disabled",
                  ),
                );
                assert.equal(
                  await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
                  "1",
                );
                await browser.evaluate(
                  "[...document.querySelectorAll('#records button')].find(b=>b.textContent==='Retry saved attempt').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "!!document.querySelector('[data-action=payment-status]') && !document.querySelector('[data-action=payment-status]').disabled",
                  ),
                );
                assert.equal(f.tickets.length, 1);
                assert(lostReserve && lostComplete);
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.issuance_attempts;",
                  ),
                  "1",
                );
                assert.equal(
                  await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
                  "1",
                );
                assert.match(
                  await browser.evaluate("document.body.textContent"),
                  /SYNTHETIC TEST ONLY/,
                );
              },
            );
            await t.test(
              "two more browser drafts issue independently before close with distinct receivers",
              async () => {
                for (const [index, side] of [
                  [2, "NO"],
                  [3, "YES"],
                ]) {
                  await browser.evaluate(
                    "document.getElementById('create').click()",
                  );
                  await wait(() =>
                    browser.evaluate(
                      `document.querySelectorAll('#records li').length===${index} && !document.getElementById('create').disabled && document.getElementById('market').value!==''`,
                    ),
                  );
                  assert.equal(
                    await browser.evaluate(
                      "document.getElementById('market').value",
                    ),
                    f.mid,
                  );
                  await browser.evaluate(
                    `document.getElementById('side').value=${JSON.stringify(side)}; document.getElementById('amount').value='1000'; document.querySelector('#records li:last-child button').click();`,
                  );
                  await wait(() =>
                    browser.evaluate(
                      `document.querySelectorAll('[data-action=payment-status]').length===${index} && !document.getElementById('create').disabled && document.getElementById('selection').hidden`,
                    ),
                  );
                  assert.equal(f.tickets.length, index);
                }
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.issuance_attempts;",
                  ),
                  "3",
                );
                assert.equal(
                  await f.sql(
                    "SELECT count(DISTINCT receiver_ref) FROM darkpool_private.tickets;",
                  ),
                  "3",
                );
                assert(Date.now() < f.close * 1000);
              },
            );
            await new Promise((r) =>
              setTimeout(r, Math.max(0, f.close * 1000 + 20 - Date.now())),
            );
            await t.test(
              "CONFIRMED visibly updates the active payment panel and its ticket",
              async () => {
                await action("simulate");
                await browser.evaluate(
                  "[...document.querySelectorAll('[data-action=payment-status]')].at(-1).click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "document.querySelector('#records li:last-child [data-payment-status=CONFIRMED]')!==null",
                  ),
                );
                assert.equal(
                  await browser.evaluate(
                    "document.getElementById('payment').dataset.paymentStatus",
                  ),
                  "CONFIRMED",
                );
                assert.match(
                  await browser.evaluate(
                    "document.getElementById('payment').textContent",
                  ),
                  /Do not send another payment/,
                );
                assert.doesNotMatch(
                  await browser.evaluate(
                    "document.getElementById('payment').textContent",
                  ),
                  /Send exactly|Awaiting payment verification/,
                );
              },
            );
            await t.test(
              "old tickets and pending drafts remain separate without changing credentials",
              async () => {
                const result = await browser.evaluate(`(async()=>{
                const v=await (await import('/local-vault.mjs')).openLocalVault();
                const c=await (await import('/issuance-client.mjs')).openIssuanceClient(v);
                try {
                  const old=await v.createDraft();await v.finalize(old,{version:1,network:'testnet',market_id:'saved-older-market',ticket_id:'ef'.repeat(32)});
                  const draft=await v.createDraft();let refused=false;try{await c.issue(draft,{market_id:'saved-older-market',side:'NO',requested_amount_zat:'1000'});}catch{refused=true;}
                  return {refused,market:(await c.savedSelection(draft)).market_id,count:(await v.list()).length};
                } finally {c.close();v.close();}
              })()`);
                assert.deepEqual(result, {
                  refused: true,
                  market: "saved-older-market",
                  count: 5,
                });
                await browser.navigate(base + "/");
                await wait(() =>
                  browser.evaluate(
                    "document.querySelectorAll('#saved-records li').length===2",
                  ),
                );
                assert.equal(
                  await browser.evaluate(
                    "document.querySelectorAll('#records li').length",
                  ),
                  3,
                );
                assert.equal(
                  await browser.evaluate(
                    "document.getElementById('saved-records-context').hidden",
                  ),
                  false,
                );
              },
            );
            await t.test(
              "expiry reproduces generic 503; it preserves the open policy and creates no extra attempt",
              async () => {
                const r = await post("/api/issuance", {
                  operation: "reserve",
                  issuance_token: "77".repeat(32),
                  market_id: f.mid,
                  side: "YES",
                  requested_amount_zat: "1000",
                });
                assert.equal(r.status, 503);
                assert.deepEqual(await r.json(), {
                  error: "ISSUANCE_UNAVAILABLE",
                });
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.issuance_attempts;",
                  ),
                  "3",
                );
                await browser.navigate(base + "/");
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('demo-context').textContent.includes('New issuance is CLOSED')",
                  ),
                );
              },
            );
            await t.test(
              "browser Step 2 simulate dispatches after rejected YES and replaced buttons; private status confirms",
              async () => {
                await browser.navigate(base + "/demo");
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('summary').textContent.includes('OPEN')",
                  ),
                );
                assert.equal(
                  await browser.evaluate(
                    "document.querySelector('[data-action=YES]').disabled",
                  ),
                  true,
                );
                assert.equal(
                  (await post("/api/demo-action", { action: "YES" })).status,
                  409,
                );
                await browser.evaluate(
                  "for(const action of ['simulate','lock']){const b=document.querySelector('[data-action='+action+']');b.replaceWith(b.cloneNode(true));}",
                );
                await clickDemo("simulate");
                await clickDemo("simulate");
                await browser.navigate(base + "/");
                await wait(() =>
                  browser.evaluate(
                    "!!document.querySelector('[data-action=payment-status]') && !document.querySelector('[data-action=payment-status]').disabled",
                  ),
                );
                await browser.evaluate(
                  "document.querySelector('[data-action=payment-status]').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "!!document.querySelector('#records [data-ticket-status][data-payment-status=CONFIRMED]') && !document.querySelector('[data-action=payment-status]').disabled",
                  ),
                );
                assert.match(
                  await browser.evaluate(
                    "document.getElementById('message').textContent",
                  ),
                  /accepted|confirmed/i,
                );
              },
            );
            let root;
            await t.test(
              "browser Step 2 lock displays accepted count/root; retry preserves immutable commitment",
              async () => {
                await browser.navigate(base + "/demo");
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('summary').textContent.includes('OPEN')",
                  ),
                );
                await clickDemo("lock");
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('root').textContent.includes('merkle_root')",
                  ),
                );
                const a = await state();
                const displayed = await browser.evaluate(
                  "JSON.parse(document.getElementById('root').textContent)",
                );
                assert.equal(displayed.accepted_ticket_count, "3");
                assert.match(displayed.merkle_root, /^[0-9a-f]{64}$/);
                assert.equal(a.state, "LOCKED");
                await clickDemo("lock");
                const b = await state();
                assert.deepEqual(a.commitment, b.commitment);
                root = a.commitment.merkle_root;
                assert.equal(a.publication, "PENDING");
                assert.equal(
                  (await post("/api/demo-action", { action: "simulate" }))
                    .status,
                  409,
                );
                await assert.rejects(
                  f.sql(
                    "UPDATE darkpool_private.ledger_records SET record_blinding=decode(repeat('ff',32),'hex');",
                  ),
                );
              },
            );
            await t.test(
              "existing synthetic verifier/oracle settle; contradictory outcome fails closed",
              async () => {
                await action("YES");
                await action("YES");
                assert.equal(
                  (await post("/api/demo-action", { action: "NO" })).status,
                  409,
                );
                assert.equal((await state()).state, "PAYING");
                assert.equal((await state()).spending_enabled, false);
                assert.equal(
                  await f.sql(
                    "SELECT sum(amount_zat)::text FROM darkpool_private.entitlements;",
                  ),
                  "3000",
                );
              },
            );
            await t.test(
              "browser selects original bearer ticket; claim preparation never sends payment",
              async () => {
                await browser.navigate(base + "/claim");
                await wait(() =>
                  browser.evaluate(
                    "!document.getElementById('check').disabled && document.getElementById('ticket').options.length===4",
                  ),
                );
                await browser.evaluate(
                  `document.getElementById('ticket').selectedIndex=1; document.getElementById('address').value=${JSON.stringify(addresses[3])}; document.getElementById('check').click();`,
                );
                await wait(() =>
                  browser.evaluate(
                    "!document.getElementById('submit').disabled",
                  ),
                );
                await browser.evaluate(
                  "document.getElementById('submit').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('message').textContent.includes('Claim prepared')",
                  ),
                );
                assert.match(
                  await browser.evaluate(
                    "document.getElementById('message').textContent",
                  ),
                  /NOT been sent/,
                );
                assert.equal(
                  await browser.evaluate(
                    "document.getElementById('claim-result').dataset.claimStatus",
                  ),
                  "PREPARED",
                );
                assert.match(
                  await browser.evaluate(
                    "document.getElementById('claim-result').textContent",
                  ),
                  /No transaction has been signed, broadcast or paid/,
                );
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.payout_intents;",
                  ),
                  "1",
                );
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.settlements;",
                  ),
                  "0",
                );
                assert.equal((await state()).commitment.merkle_root, root);
                const text = JSON.stringify(await state());
                for (const ticket of f.tickets)
                  assert(!text.includes(ticket.id));
                for (const ua of addresses) assert(!text.includes(ua));
              },
            );
            await t.test(
              "private claim retries race safely and conflicting destinations do not replace an intent",
              async () => {
                const result = await browser.evaluate(`(async()=>{
                  const v=await (await import('/local-vault.mjs')).openLocalVault();
                  const {submitTicket}=await import('/claim-client.mjs');
                  try {
                    const race=await Promise.allSettled([submitTicket(v,1,${JSON.stringify(addresses[3])}),submitTicket(v,1,${JSON.stringify(addresses[3])})]);
                    const retry=await submitTicket(v,1,${JSON.stringify(addresses[3])});
                    let conflict=false;try{await submitTicket(v,1,${JSON.stringify(addresses[4])});}catch{conflict=true;}
                    return {completed:race.some(x=>x.status==='fulfilled'),status:retry.status,conflict};
                  }finally{v.close();}
                })()`);
                assert.deepEqual(result, {
                  completed: true,
                  status: "PREPARED",
                  conflict: true,
                });
                const losing = f.tickets[1];
                const packet = {
                  market_id: f.mid,
                  ticket_id: losing.id,
                  claim_secret: Buffer.from(losing.secret).toString("hex"),
                  payout_ua: addresses[4],
                  idempotency_key: `participant_v1_${losing.id}`,
                };
                const a = await post("/api/claim", packet);
                const b = await post("/api/claim", {
                  ...packet,
                  claim_secret: "00".repeat(32),
                });
                assert.equal(a.ok, false);
                assert.equal(b.status, a.status);
                assert.deepEqual(await a.json(), await b.json());
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.payout_intents;",
                  ),
                  "1",
                );
              },
            );
            await t.test(
              "capture an actual synthetic demo screenshot without private ticket data",
              async () => {
                await browser.navigate(base + "/demo");
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('summary').textContent.includes('PAYING')",
                  ),
                );
                const image = await browser.call("Page.captureScreenshot", {
                  format: "png",
                  captureBeyondViewport: true,
                });
                const directory = resolve(".tools/submission-demo-screenshots");
                await mkdir(directory, { recursive: true });
                await writeFile(
                  resolve(directory, "synthetic-lifecycle.png"),
                  Buffer.from(image.data, "base64"),
                );
              },
            );
            await t.test(
              "Stop endpoint acknowledges shutdown and reaches the cleanup boundary",
              async () => {
                const result = await action("stop");
                assert.deepEqual(result, { status: "STOPPING" });
                await stopped;
              },
            );
          } finally {
            await browser?.stop();
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
          }
        },
        { closeDelaySeconds: interactive ? 600 : 45 },
      );
    } finally {
      await publisher.close();
    }
    console.log(
      "SYNTHETIC_DEMO_CLEANUP_CONFIRMED; no funds sent; financial authorization NOT_GRANTED",
    );
  },
);

if (!interactive)
  for (const count of [1, 2])
    test(
      `submission fallback: ${count} issued ticket(s) accept, lock and conserve entitlements`,
      { timeout: 90000 },
      async () => {
        assertSyntheticLifecycle();
        const publisher = await authority();
        try {
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
          await withSyntheticLifecycle(publisher, addresses, async (f) => {
            const { server } = await createProductDemo(
              f,
              publisher,
              addresses,
              () => {},
            );
            await new Promise((done, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", done);
            });
            const base = `http://127.0.0.1:${server.address().port}`;
            const action = (value) =>
              fetch(base + "/api/demo-action", {
                method: "POST",
                headers: { Origin: base, "Content-Type": "application/json" },
                body: JSON.stringify({ action: value }),
              });
            try {
              for (let i = 0; i < count; i++)
                await f.createTicket(i === 0 ? "YES" : "NO", "1000");
              assert.equal((await action("simulate")).status, 409);
              await new Promise((r) =>
                setTimeout(r, Math.max(0, f.close * 1000 + 20 - Date.now())),
              );
              assert.equal((await action("simulate")).status, 200);
              assert.equal((await action("simulate")).status, 200);
              const a = await action("lock");
              assert.equal(a.status, 200);
              const locked = await a.json();
              assert.equal(
                locked.commitment.accepted_ticket_count,
                String(count),
              );
              assert.equal(locked.publication, "PENDING");
              const retry = await action("lock");
              assert.equal(retry.status, 200);
              assert.deepEqual(
                (await retry.json()).commitment,
                locked.commitment,
              );
              assert.equal((await action("YES")).status, 200);
              assert.equal(
                await f.sql(
                  "SELECT sum(amount_zat)::text FROM darkpool_private.entitlements;",
                ),
                String(count * 1000),
              );
              assert.equal(locked.financial_authorization, "NOT_GRANTED");
              assert.equal(locked.production_trust, "UNAVAILABLE");
              assert.equal(locked.spending_enabled, false);
            } finally {
              server.closeAllConnections();
              await new Promise((r) => server.close(r));
            }
          });
        } finally {
          await publisher.close();
        }
        console.log("SYNTHETIC_DEMO_FALLBACK_CLEANUP_CONFIRMED");
      },
    );

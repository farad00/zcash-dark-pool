// Real SQL and browser; synthetic TCP/IPC only. No wallet or public-chain access.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { privateProcess } from "../../backup/crypto.mjs";
import { authority } from "../../publication/test/fixtures.mjs";
import {
  withSyntheticLifecycle,
  assertSyntheticLifecycle,
} from "../../../db/test/lifecycle-fixtures.mjs";
import { participantStatusScript } from "../../../db/participant-status-provision.mjs";
import { statusPrivileges } from "../status.mjs";
import { issuanceQuery } from "../../../db/issuance-runtime.mjs";
import { createPublicReader } from "../../../db/public-read.mjs";
import {
  allocatorFixture,
  scannerFixture,
} from "../../observation-bridge/test/process-fixtures.mjs";
import { allocateInternal } from "../../../apps/web/src/issuance.mjs";
import { composeDeposit } from "../runtime.mjs";
import { launchBrowser } from "../../../apps/web/test/vault-browser.mjs";
import { id } from "../../../db/test/lock-fixtures.mjs";
const wait = async (p) => {
  for (let i = 0; i < 250; i++) {
    if (await p()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("DEPOSIT_BROWSER_NOT_CONFIRMED");
};
function snapshot(f, tip, outputs) {
  const headers = Array.from({ length: tip - 89 }, (_, i) => ({
    height: 90 + i,
    hash: id(90 + i),
    prev_hash: id(89 + i),
    time: f.close - 6 + (90 + i - 100),
  }));
  return {
    outputs,
    chain: {
      ...f.request.chain,
      tip_height: tip,
      tip_hash: id(tip),
      scanned_height: tip,
      scanned_hash: id(tip),
      verified_at: new Date().toISOString(),
      close_proof: {
        ...f.request.chain.close_proof,
        status: tip >= 112 ? "FOUND" : "NO_CROSSING_BY_H",
        boundary_height: tip >= 112 ? 112 : null,
        window: headers.filter(
          (h) =>
            h.height >= (tip >= 112 ? 100 : tip - 11) &&
            h.height <= (tip >= 112 ? 112 : tip),
        ),
        target: headers.at(-1),
      },
      inclusion_blocks: [
        ...new Set(
          outputs
            .filter((o) => o.present && o.canonical)
            .map((o) => o.block_height),
        ),
      ]
        .sort((a, b) => a - b)
        .map((h) => headers.find((x) => x.height === h)),
    },
  };
}
test(
  "deposit connector: direct browser participation -> authenticated watcher status; no financial activation",
  { timeout: 180000 },
  async (t) => {
    assertSyntheticLifecycle();
    const publisher = await authority();
    const directory = await mkdtemp(join(tmpdir(), "darkpool-deposit-"));
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
          assert.equal(
            (
              await f.admin("create", {
                request_key: "deposit_create",
                expected_revision: null,
                configuration: f.configuration,
              })
            ).result,
            "APPLIED",
          );
          await f.register();
          assert.equal(
            (
              await f.admin("open", {
                request_key: "deposit_open",
                expected_revision: "1",
              })
            ).result,
            "APPLIED",
          );
          await f.sql(
            participantStatusScript({
              database: f.database,
              role: f.roles.other,
              environment: "DISPOSABLE_TEST",
            }),
          );
          const allocation = await allocatorFixture({
            market: f.mid,
            vault: "synthetic-vault",
            addresses,
          });
          const statusQuery = (sql) =>
            f.roleQuery(
              "other",
              `BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
${statusPrivileges} AS permitted \\gset
\\if :permitted
${sql}
\\else
SELECT 1/0;
\\endif`,
            );
          let source,
            browser,
            loseSnapshotReply = false;
          const replayed = [];
          const db = {
            context: () => f.watcher.context(),
            reconcile: async (revision, request) => {
              if (request.mode === "snapshot")
                replayed.push(request.request_id);
              const result = await f.watcher.reconcile(revision, request);
              if (request.mode === "snapshot" && loseSnapshotReply) {
                loseSnapshotReply = false;
                throw Error("SYNTHETIC_LOST_COMMIT_REPLY");
              }
              return result;
            },
          };
          const runtime = composeDeposit({
            issueQuery: (sql) => issuanceQuery(sql, f.env("issue")),
            allocate: (c) =>
              allocateInternal(c, {
                ALLOCATION_AUTH: allocation.auth,
                ALLOCATION_PORT: allocation.port,
              }),
            db,
            wallet: { request: (...args) => source.request(...args) },
            stopFile: join(directory, "stop.json"),
            statusQuery,
            readMarket: await createPublicReader(f.env("read")),
            environment: "DISPOSABLE_TEST",
          });
          await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
          const base = `http://127.0.0.1:${runtime.server.address().port}`;
          const cycle = async (snap, mode = "normal") => {
            source = scannerFixture({
              observed: snap.outputs
                .filter((o) => o.present)
                .map((o) => ({ ...o, canonical: false })),
              snapshot: snap,
              mode,
            });
            try {
              return await runtime.cycle();
            } finally {
              await source.close();
            }
          };
          const browserStatus = async (local) =>
            browser.evaluate(
              `(async()=>{const v=await(await import('/local-vault.mjs')).openLocalVault();const c=await(await import('/issuance-client.mjs')).openIssuanceClient(v);try{return await c.paymentStatus(${local});}finally{c.close();v.close();}})()`,
            );
          const accepted = () =>
            f.sql(
              "SELECT count(*) FROM darkpool_private.accepted_payment_receipts;",
            );
          try {
            browser = await launchBrowser();
            await t.test(
              "market links directly to participation; one-click issuance preserves interrupted credentials",
              async () => {
                await browser.navigate(base + "/market");
                assert.equal(
                  await browser.evaluate(
                    "document.querySelector('a[href=\"/\"]').textContent",
                  ),
                  "Make a private prediction",
                );
                await browser.navigate(base + "/");
                await wait(() =>
                  browser.evaluate(
                    "!document.getElementById('participate').disabled && document.getElementById('market').value!==''",
                  ),
                );
                assert.equal(
                  await browser.evaluate(
                    "document.getElementById('market').value",
                  ),
                  f.mid,
                );
                allocation.controls.loseReply = true;
                await browser.evaluate(
                  "document.getElementById('side').value='YES';document.getElementById('amount').value='1000';document.getElementById('participate').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "document.getElementById('message').textContent.includes('could not complete safely') && [...document.querySelectorAll('#records button')].some(b=>b.textContent==='Retry saved attempt')",
                  ),
                );
                assert.equal(allocation.journal.size, 1);
                assert.equal(
                  await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
                  "0",
                );
                await browser.evaluate(
                  "[...document.querySelectorAll('#records button')].find(b=>b.textContent==='Retry saved attempt').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "document.querySelectorAll('[data-action=payment-status]').length===1 && !document.getElementById('participate').disabled",
                  ),
                );
                for (const [index, side] of [
                  [2, "NO"],
                  [3, "YES"],
                ]) {
                  await browser.evaluate(
                    "document.getElementById('new-prediction').click()",
                  );
                  await wait(() =>
                    browser.evaluate(
                      "!document.getElementById('selection').hidden && !document.getElementById('participate').disabled",
                    ),
                  );
                  await browser.evaluate(
                    `document.getElementById('side').value=${JSON.stringify(side)};document.getElementById('amount').value='1000';document.getElementById('participate').click()`,
                  );
                  await wait(() =>
                    browser.evaluate(
                      `document.querySelectorAll('[data-action=payment-status]').length===${index} && !document.getElementById('participate').disabled`,
                    ),
                  );
                }
                assert.equal(
                  await browser.evaluate(
                    "document.querySelectorAll('#records li').length",
                  ),
                  3,
                );
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
                const rows = JSON.parse(
                  await f.sql(
                    "SELECT jsonb_agg(jsonb_build_object('id',id,'amount',requested_amount_zat::text,'receiver',receiver_ref,'commitment',encode(claim_commitment,'hex')) ORDER BY created_at,id) FROM darkpool_private.tickets;",
                  ),
                );
                for (const row of rows)
                  f.tickets.push({
                    id: row.id,
                    amount: row.amount,
                    issued: { receiving_ua: row.receiver },
                    complete: { claim_commitment: row.commitment },
                    secret: new Uint8Array(32),
                  });
              },
            );
            await t.test(
              "credential-authenticated status is private, no-store, fixture-labelled and role restricted",
              async () => {
                assert.deepEqual(await browserStatus(1), {
                  status: "AWAITING_PAYMENT",
                  environment: "DISPOSABLE_TEST",
                  financial_authorization: "NOT_GRANTED",
                });
                const request = {
                  market_id: f.mid,
                  ticket_id: f.tickets[0].id,
                  issuance_token: "ff".repeat(32),
                };
                const post = (p, origin = base) =>
                  fetch(base + "/api/payment-status", {
                    method: "POST",
                    headers: {
                      Origin: origin,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(p),
                  });
                const a = await post(request),
                  b = await post({ ...request, ticket_id: "00".repeat(32) });
                assert.equal(a.status, 503);
                assert.equal(b.status, 503);
                assert.deepEqual(await a.json(), await b.json());
                assert.equal(a.headers.get("cache-control"), "no-store");
                assert.equal(
                  (await post(request, "https://invalid.example")).status,
                  403,
                );
                for (const sql of [
                  "SELECT * FROM darkpool_private.tickets;",
                  "SELECT darkpool_watcher.reconcile(0,'{}'::jsonb);",
                  "SELECT darkpool_lock.begin_lock('{}'::jsonb);",
                ])
                  await assert.rejects(f.roleQuery("other", sql));
                assert.equal(Object.hasOwn(runtime, "resolve"), false);
                assert.equal(runtime.spending_enabled, false);
              },
            );
            const outputs = f.payment().outputs;
            await t.test(
              "interrupted sync retains detection; replay never duplicates an obligation",
              async () => {
                await assert.rejects(
                  cycle(snapshot(f, 101, [outputs[0]]), "exit-sync"),
                );
                assert.equal((await browserStatus(1)).status, "DETECTED");
                assert.equal(await accepted(), "0");
                await cycle(snapshot(f, 101, [outputs[0]]));
                await cycle(snapshot(f, 102, [outputs[0]]));
                assert.equal((await browserStatus(1)).status, "DETECTED");
                assert.equal(await accepted(), "0");
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.payment_receipts;",
                  ),
                  "1",
                );
              },
            );
            await t.test(
              "pre-finality orphan reverts pending status; remine requires all three confirmations",
              async () => {
                const orphan = {
                  ...outputs[0],
                  present: false,
                  canonical: false,
                  block_height: null,
                  block_hash: null,
                  block_time: null,
                  tx_index: null,
                };
                await cycle(snapshot(f, 102, [orphan]));
                assert.equal(
                  (await browserStatus(1)).status,
                  "AWAITING_PAYMENT",
                );
                outputs[0] = {
                  ...outputs[0],
                  block_height: 103,
                  block_hash: id(103),
                  block_time: f.close - 3,
                };
                await cycle(snapshot(f, 104, [outputs[0]]));
                assert.equal((await browserStatus(1)).status, "DETECTED");
                await cycle(snapshot(f, 105, [outputs[0]]));
                assert.equal((await browserStatus(1)).status, "CONFIRMED");
                assert.equal(await accepted(), "1");
              },
            );
            await t.test(
              "wrong receivers never accept; malformed scan rolls back; restart/replay stays unique",
              async () => {
                await cycle(
                  snapshot(f, 114, [
                    outputs[0],
                    { ...outputs[1], receiver_ref: addresses[4] },
                  ]),
                );
                assert.equal(
                  (await browserStatus(2)).status,
                  "AWAITING_PAYMENT",
                );
                assert.equal(await accepted(), "1");
                const count = await f.sql(
                  "SELECT count(*) FROM darkpool_private.watcher_evidence;",
                );
                source = scannerFixture({
                  observed: [],
                  snapshot: snapshot(f, 114, [
                    outputs[0],
                    { ...outputs[1], amount_zat: "bad" },
                  ]),
                });
                try {
                  await assert.rejects(runtime.cycle());
                } finally {
                  await source.close();
                }
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.watcher_evidence;",
                  ),
                  count,
                );
                replayed.length = 0;
                loseSnapshotReply = true;
                await cycle(snapshot(f, 114, [outputs[0], outputs[1]]));
                assert.equal(replayed.length, 2);
                assert.equal(replayed[0], replayed[1]);
                await cycle(snapshot(f, 114, [outputs[0], outputs[1]]));
                assert.equal(await accepted(), "2");
                assert.equal((await browserStatus(2)).status, "CONFIRMED");
                await browser.evaluate(
                  "document.querySelector('[data-action=payment-status]').click()",
                );
                await wait(() =>
                  browser.evaluate(
                    "[...document.querySelectorAll('[data-ticket-status]')].some(p=>p.textContent.includes('Accepted in the watcher records'))",
                  ),
                );
                const projection = await browserStatus(1);
                for (const value of [f.tickets[0].id, ...addresses])
                  assert(!JSON.stringify(projection).includes(value));
              },
            );
            await t.test(
              "concurrent scan invocation is refused and an identical scan remains idempotent",
              async () => {
                source = scannerFixture({
                  observed: [],
                  snapshot: snapshot(f, 114, [outputs[0], outputs[1]]),
                });
                try {
                  const results = await Promise.allSettled([
                    runtime.cycle(),
                    runtime.cycle(),
                  ]);
                  assert.equal(
                    results.filter((r) => r.status === "fulfilled").length,
                    1,
                  );
                  assert.equal(
                    results.filter((r) => r.status === "rejected").length,
                    1,
                  );
                  assert.equal(await accepted(), "2");
                } finally {
                  await source.close();
                }
              },
            );
            await t.test(
              "post-acceptance reorg holds immutable history and removes confirmed display; no downstream authority",
              async () => {
                const reorg = {
                  ...outputs[0],
                  present: false,
                  canonical: false,
                  block_height: null,
                  block_hash: null,
                  block_time: null,
                  tx_index: null,
                };
                await cycle(snapshot(f, 114, [reorg, outputs[1]]));
                assert.equal((await browserStatus(1)).status, "UNAVAILABLE");
                assert.equal(await accepted(), "2");
                assert.equal(
                  await f.sql(
                    "SELECT (SELECT count(*) FROM darkpool_private.ledger_records)+(SELECT count(*) FROM darkpool_private.resolution_results)+(SELECT count(*) FROM darkpool_private.claim_reservations)+(SELECT count(*) FROM darkpool_private.payout_intents);",
                  ),
                  "0",
                );
              },
            );
          } finally {
            await browser?.stop();
            await runtime.close();
            await assert.rejects(
              runtime.cycle(),
              /DEPOSIT_OBSERVATION_UNAVAILABLE/,
            );
            await allocation.close();
          }
        },
        { closeDelaySeconds: 60 },
      );
    } finally {
      await publisher.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert(basename(directory).startsWith("darkpool-deposit-"));
      await rm(directory, { recursive: true, force: true });
    }
    console.log(
      "DEPOSIT_FIXTURE_CLEANUP_CONFIRMED; GENUINE_WALLET_NOT_ACTIVATED; FINANCIAL_AUTHORIZATION_NOT_GRANTED",
    );
  },
);

// Explicit wallet-free demonstration: no wallet process, financial target or external evidence.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { resolve } from "node:path";
import { privateProcess } from "../../services/backup/crypto.mjs";
import { authority } from "../../services/publication/test/fixtures.mjs";
import {
  withSyntheticLifecycle,
  assertSyntheticLifecycle,
  resources,
} from "./lifecycle-fixtures.mjs";
import { provisionBridgeStatus } from "./bridge-provision.mjs";
import { id } from "./lock-fixtures.mjs";
import { createTestPaymentStatus } from "../../services/test-bridge/payment-status.mjs";
import { createOperationsAdapter } from "../../services/operations/commands.mjs";
import { finalizeInSession } from "../../services/lock/finalize.mts";
import { openLockSession } from "../../services/lock/db-session.mjs";
import { createPublicReader } from "../public-read.mjs";
import { createIssuanceServer } from "../../apps/web/src/issuance-server.mjs";
import { launchBrowser } from "../../apps/web/test/vault-browser.mjs";

let publisher, addresses;
before(async () => {
  assertSyntheticLifecycle();
  // Existing fixture authority is local, synthetic and never used for publication here.
  publisher = await authority();
  addresses = JSON.parse(
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
});
after(async () => {
  await publisher?.close();
});
const adapter = (f, purpose, role = purpose) =>
  createOperationsAdapter({
    purpose,
    env: { ...f.env(role), DARKPOOL_OPERATIONS_INTERNAL: "1" },
    lockResources: resources,
  });
const command = (op, request) => JSON.stringify({ operation: op, request });
const statusPacket = (f, t) => ({
  market_id: f.mid,
  ticket_id: t.id,
  issuance_token: t.complete.issuance_token,
});
const privateState = (f) =>
  f.sql(`SELECT jsonb_build_object('tickets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM darkpool_private.tickets t),
 'receipts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM darkpool_private.payment_receipts p),
 'watch',(SELECT to_jsonb(w) FROM darkpool_private.watcher_state w),
 'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY ticket_id) FROM darkpool_private.ledger_records l),
 'root',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.ledger_commitments c),
 'revision',(SELECT revision::text FROM darkpool_private.admin_revisions));`);
const waiting = async (expr) => {
  for (let i = 0; i < 150; i++) {
    if (await expr()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Bridge browser timeout");
};
// Same bounded chain proof as existing lock fixtures; only tip/output evidence varies.
let requestSequence = 20000;
function payment(f, tip, outputs) {
  const p = f.payment();
  const headers = Array.from({ length: tip - 89 }, (_, i) => ({
    height: 90 + i,
    hash: id(90 + i),
    prev_hash: id(89 + i),
    time: f.close - 6 + (90 + i - 100),
  }));
  p.request_id = id(++requestSequence);
  p.outputs = outputs;
  p.chain = {
    ...p.chain,
    tip_height: tip,
    tip_hash: id(tip),
    scanned_height: tip,
    scanned_hash: id(tip),
    verified_at: new Date().toISOString(),
    close_proof: {
      ...p.chain.close_proof,
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
          .filter((o) => o.canonical && o.present)
          .map((o) => o.block_height),
      ),
    ]
      .sort((a, b) => a - b)
      .map((h) => headers.find((x) => x.height === h)),
  };
  return p;
}

test(
  "disposable TEST bridge: browser ticket -> receiver/ZIP-321 -> watcher -> private status -> immutable lock",
  { timeout: 150000 },
  async (t) => {
    await withSyntheticLifecycle(publisher, addresses, async (f) => {
      const admin = await adapter(f, "admin");
      assert.equal(
        (
          await admin(
            command("create", {
              request_key: "bridge_create",
              expected_revision: null,
              configuration: f.configuration,
            }),
          )
        ).result,
        "APPLIED",
      );
      await f.register();
      assert.equal(
        (
          await admin(
            command("open", {
              request_key: "bridge_open",
              expected_revision: "1",
            }),
          )
        ).result,
        "APPLIED",
      );
      await provisionBridgeStatus(f);
      const status = createTestPaymentStatus({
        ...f.env("other"),
        DARKPOOL_BRIDGE_TEST_ONLY: "1",
      });
      let reserved;
      const server = createIssuanceServer({
        paymentStatus: status,
        issue: async (packet) => {
          const r = await f.issue(packet);
          if (packet.operation === "reserve") reserved = packet;
          if (
            packet.operation === "complete" &&
            !f.tickets.some((t) => t.id === r.ticket_id)
          )
            f.tickets.push({
              id: r.ticket_id,
              amount: reserved.requested_amount_zat,
              side: reserved.side,
              complete: packet,
              issued: r,
              secret: new Uint8Array(32),
              index: 0,
            });
          return r;
        },
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${server.address().port}`;
      let browser;
      try {
        browser = await launchBrowser();
        const run = (body) => browser.evaluate(`(async()=>{${body}})()`);
        const clickStatus = async () => {
          await run(
            `document.querySelector('[data-action="payment-status"]').click();`,
          );
          await waiting(() =>
            browser.evaluate(
              `!!document.querySelector('[data-action="payment-status"]') && !document.querySelector('[data-action="payment-status"]').disabled`,
            ),
          );
          return browser.evaluate(
            "document.getElementById('message').textContent",
          );
        };
        await t.test(
          "real vault/client handshake, synthetic allocator, exact ZIP-321 and authenticated pending display",
          async () => {
            await browser.navigate(base + "/");
            await waiting(() =>
              browser.evaluate("!document.getElementById('create').disabled"),
            );
            await run("document.getElementById('create').click();");
            await waiting(() =>
              browser.evaluate(
                "document.querySelectorAll('#records li').length===1",
              ),
            );
            await run(
              `document.getElementById('market').value=${JSON.stringify(f.mid)};document.getElementById('side').value='YES';document.getElementById('amount').value='1000';document.querySelector('#records button').click();`,
            );
            await waiting(() =>
              browser.evaluate(
                "!!document.querySelector('[data-action=payment-status]') && !document.querySelector('[data-action=payment-status]').disabled",
              ),
            );
            assert.equal(f.tickets.length, 1);
            assert.equal(f.tickets[0].issued.receiving_ua, addresses[0]);
            const html = await browser.evaluate(
              "document.getElementById('payment').textContent",
            );
            assert.match(html, /zcash:utest1/);
            assert.match(html, /0\.00001/);
            assert.match(await clickStatus(), /Not yet accepted/);
            await f.createTicket("NO", "1000");
            await f.createTicket("YES", "2000");
            assert.equal(
              await f.sql(
                "SELECT count(DISTINCT receiver_ref) FROM darkpool_private.tickets;",
              ),
              "3",
            );
          },
        );
        const outputs = f.payment().outputs;
        let revision = 0;
        const reconcile = async (p) => {
          const r = await f.watcher.reconcile(revision, p);
          revision++;
          return r;
        };
        await t.test(
          "wrong receiver cannot accept; duplicate scan is idempotent",
          async () => {
            const p = payment(f, 101, [
              { ...outputs[0], receiver_ref: addresses[4] },
            ]);
            const r = await reconcile(p);
            assert.deepEqual(await f.watcher.reconcile(0, p), r);
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.payment_receipts;",
              ),
              "0",
            );
            assert.equal(
              (await status(statusPacket(f, f.tickets[0]))).status,
              "AWAITING_PAYMENT",
            );
          },
        );
        await t.test(
          "pending, one and two confirmations never claim acceptance; three do",
          async () => {
            const pending = payment(f, 101, [
              { ...outputs[0], canonical: false },
            ]);
            pending.request_id = id(29000);
            await reconcile(pending);
            assert.equal(
              (await status(statusPacket(f, f.tickets[0]))).status,
              "AWAITING_PAYMENT",
            );
            for (const tip of [101, 102, 103]) {
              await reconcile(payment(f, tip, [outputs[0]]));
              assert.equal(
                (await status(statusPacket(f, f.tickets[0]))).status,
                tip === 103 ? "CONFIRMED" : "AWAITING_PAYMENT",
              );
            }
            assert.match(
              await clickStatus(),
              /Accepted by the synthetic watcher/,
            );
          },
        );
        await t.test(
          "failure rolls back, existing watcher session recovers; stale watcher revision rejects",
          async () => {
            const before = await privateState(f);
            const malformed = payment(f, 114, outputs);
            malformed.chain.inclusion_blocks[0].hash = id(90000);
            await assert.rejects(f.watcher.reconcile(revision, malformed));
            assert.equal(await privateState(f), before);
            const incomplete = payment(f, 114, outputs);
            incomplete.chain.complete = false;
            await assert.rejects(f.watcher.reconcile(revision, incomplete));
            assert.equal(await privateState(f), before);
            await assert.rejects(
              f.watcher.reconcile(0, payment(f, 114, outputs)),
            );
            assert.equal(await privateState(f), before);
          },
        );
        let finalPayment;
        await t.test(
          "close equality is late, mapping recovery accepts only the correct receiver",
          async () => {
            const late = {
              ...outputs[1],
              block_height: 106,
              block_hash: id(106),
              block_time: f.close,
            };
            await reconcile(
              payment(f, 114, [
                outputs[0],
                late,
                { ...outputs[2], receiver_ref: addresses[4] },
              ]),
            );
            assert.equal(
              (await status(statusPacket(f, f.tickets[1]))).status,
              "AWAITING_PAYMENT",
            );
            assert.equal(
              (await status(statusPacket(f, f.tickets[2]))).status,
              "AWAITING_PAYMENT",
            );
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.payment_liabilities WHERE state_policy_ref='phase9-late';",
              ),
              "1",
            );
            finalPayment = payment(f, 114, [outputs[0], late, outputs[2]]);
            finalPayment.request_id = id(29999);
            await reconcile(finalPayment);
            assert.equal(
              (await status(statusPacket(f, f.tickets[2]))).status,
              "CONFIRMED",
            );
          },
        );
        await t.test(
          "capability isolation, generic HTTP failures, no book data and status-only privileges",
          async () => {
            const post = (body) =>
              fetch(base + "/api/payment-status", {
                method: "POST",
                headers: { Origin: base, "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
            const a = await post(statusPacket(f, f.tickets[0]));
            assert.deepEqual(Object.keys(await a.json()).sort(), [
              "environment",
              "financial_authorization",
              "status",
            ]);
            for (const input of [
              { ...statusPacket(f, f.tickets[0]), issuance_token: id(42) },
              { ...statusPacket(f, f.tickets[0]), ticket_id: f.tickets[1].id },
              { ...statusPacket(f, f.tickets[0]), market_id: "other-market" },
            ]) {
              const r = await post(input);
              assert.equal(r.status, 503);
              assert.deepEqual(await r.json(), {
                error: "PAYMENT_STATUS_UNAVAILABLE",
              });
            }
            for (const query of [
              "SELECT to_jsonb(t) FROM darkpool_private.tickets t;",
              "SELECT darkpool_watcher.context();",
              "SELECT darkpool_admin.inspect();",
            ])
              await assert.rejects(f.roleQuery("other", query));
            await f.sql(
              `GRANT SELECT ON darkpool_private.tickets TO "${f.roles.other}";`,
            );
            try {
              await assert.rejects(
                status(statusPacket(f, f.tickets[0])),
                /PAYMENT_STATUS_UNAVAILABLE/,
              );
            } finally {
              await f.sql(
                `REVOKE SELECT ON darkpool_private.tickets FROM "${f.roles.other}";`,
              );
            }
            assert.equal(
              (await status(statusPacket(f, f.tickets[0]))).status,
              "CONFIRMED",
            );
            const read = await createPublicReader(f.env("read"));
            const publicBytes = JSON.stringify(await read());
            for (const ticket of f.tickets)
              for (const privateValue of [
                ticket.id,
                ticket.complete.issuance_token,
                ticket.complete.claim_commitment,
                ticket.issued.receiving_ua,
              ])
                assert(!publicBytes.includes(privateValue));
            const wrongRole = await adapter(f, "lock", "other");
            assert.equal(
              (await wrongRole(command("finalize-lock", f.lockRequest))).result,
              "UNCONFIRMED",
            );
            // Imported credentials do not gain this original-browser issuance capability.
            assert.equal(
              await run(
                `const v=await (await import('/local-vault.mjs')).openLocalVault();const c=await (await import('/issuance-client.mjs')).openIssuanceClient(v);const i=await v.createDraft();await v.finalize(i,{version:1,network:'testnet',market_id:${JSON.stringify(f.mid)},ticket_id:${JSON.stringify(f.tickets[2].id)}});try{await c.paymentStatus(i);return false;}catch{return true;}finally{c.close();v.close();}`,
              ),
              true,
            );
          },
        );
        const lock = await adapter(f, "lock");
        const lockRequest = {
          ...f.lockRequest,
          expected_watcher_revision: String(revision),
          checkpoint_ref: "reconcile:" + finalPayment.request_id,
        };
        await t.test(
          "stale revision and premature close lock fail without side effects",
          async () => {
            const before = await privateState(f);
            assert.equal(
              (
                await lock(
                  command("finalize-lock", {
                    ...lockRequest,
                    expected_revision: "1",
                  }),
                )
              ).result,
              "UNCONFIRMED",
            );
            if (Date.now() < f.close * 1000) {
              assert.equal(
                (await lock(command("finalize-lock", lockRequest))).result,
                "UNCONFIRMED",
              );
            }
            assert.equal(await privateState(f), before);
          },
        );
        await t.test(
          "commit failure rolls back and concurrent lock creates one immutable verifiable snapshot",
          async () => {
            if (Date.now() < f.close * 1000)
              await new Promise((r) =>
                setTimeout(r, f.close * 1000 - Date.now() + 20),
              );
            const before = await privateState(f);
            const s = await openLockSession(f.env("lock"));
            try {
              await assert.rejects(
                finalizeInSession(
                  {
                    query: (sql) => {
                      if (sql.startsWith("COMMIT;"))
                        throw Error("synthetic interruption");
                      return s.query(sql);
                    },
                  },
                  lockRequest,
                  resources,
                ),
              );
            } finally {
              await s.close();
            }
            assert.equal(await privateState(f), before);
            const race = await Promise.all([
              lock(command("finalize-lock", lockRequest)),
              lock(command("finalize-lock", lockRequest)),
            ]);
            const success = race.find((r) => r.result === "LOCKED");
            assert(success);
            const frozen = await privateState(f);
            // Explicit identical replay, no automatic retry; finalize re-verifies the stored blindings/root.
            assert.deepEqual(
              await lock(command("finalize-lock", lockRequest)),
              success,
            );
            assert.equal(await privateState(f), frozen);
            assert.equal(success.commitment.accepted_ticket_count, "2");
            assert.equal(success.publication, "PENDING");
            assert.equal(
              await f.sql(
                "SELECT sum(accepted_amount_zat)::text FROM darkpool_private.ledger_records;",
              ),
              "3000",
            );
            await assert.rejects(
              f.sql(
                "UPDATE darkpool_private.ledger_records SET record_blinding=decode(repeat('ff',32),'hex');",
              ),
            );
            assert.equal(await privateState(f), frozen);
            assert.equal(
              (
                await lock(
                  command("finalize-lock", {
                    ...lockRequest,
                    request_key: "conflicting_lock",
                  }),
                )
              ).result,
              "UNCONFIRMED",
            );
            assert.equal(
              await f.sql(
                "SELECT (SELECT count(*) FROM darkpool_private.ledger_publication_receipts)+(SELECT count(*) FROM darkpool_private.resolution_results)+(SELECT count(*) FROM darkpool_private.claim_reservations)+(SELECT count(*) FROM darkpool_private.payout_intents);",
              ),
              "0",
            );
            assert.match(
              await clickStatus(),
              /Financial authorization NOT_GRANTED/,
            );
            t.diagnostic(
              "SYNTHETIC_TEST_ONLY: issued -> receiver/ZIP-321 -> simulated canonical acceptance -> private browser status -> LOCKED; publication PENDING; financial authorization NOT_GRANTED.",
            );
          },
        );
      } finally {
        await browser?.stop();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    });
  },
);

test(
  "active safety hold makes private status unavailable and prevents lock",
  { timeout: 90000 },
  async () => {
    await withSyntheticLifecycle(publisher, addresses, async (f) => {
      const admin = await adapter(f, "admin");
      assert.equal(
        (
          await admin(
            command("create", {
              request_key: "create",
              expected_revision: null,
              configuration: f.configuration,
            }),
          )
        ).result,
        "APPLIED",
      );
      await f.register();
      assert.equal(
        (
          await admin(
            command("open", { request_key: "open", expected_revision: "1" }),
          )
        ).result,
        "APPLIED",
      );
      await provisionBridgeStatus(f);
      for (const side of ["YES", "NO", "YES"]) await f.createTicket(side, "1");
      await f.watcher.reconcile(0, f.payment());
      const status = createTestPaymentStatus({
        ...f.env("other"),
        DARKPOOL_BRIDGE_TEST_ONLY: "1",
      });
      assert.equal(
        (await status(statusPacket(f, f.tickets[0]))).status,
        "CONFIRMED",
      );
      const hold = {
        ...f.request,
        request_id: id(39999),
        mode: "safety_stop",
        reason: "RESTORE_REVIEW",
      };
      delete hold.outputs;
      delete hold.chain;
      await f.watcher.reconcile(1, hold);
      assert.equal(
        (await status(statusPacket(f, f.tickets[0]))).status,
        "UNAVAILABLE",
      );
      const lock = await adapter(f, "lock");
      assert.equal(
        (await lock(command("finalize-lock", f.lockRequest))).result,
        "UNCONFIRMED",
      );
      assert.equal(
        await f.sql("SELECT count(*) FROM darkpool_private.ledger_records;"),
        "0",
      );
    });
  },
);

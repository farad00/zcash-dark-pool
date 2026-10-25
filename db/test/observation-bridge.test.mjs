// Protocol/process rehearsal with real PostgreSQL, never real wallet state or chain traffic.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { privateProcess } from "../../services/backup/crypto.mjs";
import { authority } from "../../services/publication/test/fixtures.mjs";
import {
  withSyntheticLifecycle,
  assertSyntheticLifecycle,
  resources,
} from "./lifecycle-fixtures.mjs";
import { withObservationReader } from "./observation-provision.mjs";
import { provisionBridgeStatus } from "./bridge-provision.mjs";
import { createTestPaymentStatus } from "../../services/test-bridge/payment-status.mjs";
import {
  createObservationPreview,
  observeOnlyTransport,
} from "../../services/observation-bridge/preview.mjs";
import {
  allocatorFixture,
  scannerFixture,
  scannerChild,
} from "../../services/observation-bridge/test/process-fixtures.mjs";
import {
  createIssuer,
  allocateInternal,
} from "../../apps/web/src/issuance.mjs";
import { issuanceQuery } from "../issuance-runtime.mjs";
import { deriveClaimCommitment } from "../../packages/protocol/src/claim-commitment.ts";
import { createCoordinator } from "../../services/watcher/main.mjs";
import { finalizeLock } from "../../services/lock/finalize.mts";
import { id } from "./lock-fixtures.mjs";
let publisher, addresses;
before(async () => {
  assertSyntheticLifecycle();
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
async function open(f) {
  assert.equal(
    (
      await f.admin("create", {
        request_key: "create",
        expected_revision: null,
        configuration: f.configuration,
      })
    ).result,
    "APPLIED",
  );
  await f.register();
  assert.equal(
    (await f.admin("open", { request_key: "open", expected_revision: "1" }))
      .result,
    "APPLIED",
  );
}
const accepted = (f) =>
  f.sql(
    "SELECT count(*) FROM darkpool_private.tickets WHERE payment_state='CONFIRMED';",
  );
const statusPacket = (f, t) => ({
  market_id: f.mid,
  ticket_id: t.id,
  issuance_token: t.complete.issuance_token,
});
const evidence = (f) =>
  f.sql(`SELECT jsonb_build_object('receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM darkpool_private.payment_receipts r),
'accepted',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM darkpool_private.accepted_payments a),
'watch',(SELECT to_jsonb(w) FROM darkpool_private.watcher_state w));`);
const observedOutputs = (outputs) =>
  outputs.filter((o) => o.present).map((o) => ({ ...o, canonical: false }));
function snapshot(f, tip, outputs) {
  const headers = Array.from({ length: tip - 89 }, (_, i) => ({
    height: 90 + i,
    hash: id(90 + i),
    prev_hash: id(89 + i),
    time: f.close - 6 + (90 + i - 100),
  }));
  const p = structuredClone(f.request);
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
          .filter((o) => o.present && o.canonical)
          .map((o) => o.block_height),
      ),
    ]
      .sort((a, b) => a - b)
      .map((h) => headers.find((x) => x.height === h)),
  };
  return { outputs: p.outputs, chain: p.chain };
}
async function withStop(work) {
  const directory = await mkdtemp(join(tmpdir(), "darkpool-observation-"));
  try {
    await work(join(directory, "stop.json"));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(basename(directory).startsWith("darkpool-observation-"));
    await rm(directory, { recursive: true, force: true });
  }
}
async function cycle(
  f,
  stopFile,
  snap,
  {
    mode = "normal",
    db = f.watcher,
    observed = observedOutputs(snap.outputs),
  } = {},
) {
  const wallet = scannerFixture({ observed, snapshot: snap, mode });
  try {
    return await createCoordinator({ db, wallet, stopFile }).cycle();
  } finally {
    await wallet.close();
  }
}
test(
  "TCP allocator + IPC scanner + existing watcher/status/lock, isolated from financial authorization",
  { timeout: 150000 },
  async (t) => {
    await withSyntheticLifecycle(publisher, addresses, async (f) => {
      await open(f);
      await provisionBridgeStatus(f);
      const status = createTestPaymentStatus({
        ...f.env("other"),
        DARKPOOL_BRIDGE_TEST_ONLY: "1",
      });
      const allocation = await allocatorFixture({
        market: f.mid,
        vault: "synthetic-vault",
        addresses,
      });
      const issuer = createIssuer({
        query: (q) => issuanceQuery(q, f.env("issue")),
        allocate: (c) =>
          allocateInternal(c, {
            ...f.env("issue"),
            ALLOCATION_AUTH: allocation.auth,
            ALLOCATION_PORT: allocation.port,
          }),
      });
      const reserve = async () => {
        const secret = new Uint8Array(randomBytes(32));
        const request = {
          operation: "reserve",
          issuance_token: randomBytes(32).toString("hex"),
          market_id: f.mid,
          side: "YES",
          requested_amount_zat: "1000",
        };
        const pending = await issuer(request);
        const complete = {
          operation: "complete",
          issuance_token: request.issuance_token,
          ticket_id: pending.ticket_id,
          claim_commitment: deriveClaimCommitment({
            version: 1,
            market_id: f.mid,
            ticket_id: pending.ticket_id,
            claim_secret: secret,
          }),
          claim_commitment_profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1",
        };
        return { id: pending.ticket_id, amount: "1000", secret, complete };
      };
      try {
        await t.test(
          "lost allocator acknowledgement recovers same journal entry; collisions cannot create a ticket",
          async () => {
            for (let i = 0; i < 3; i++) {
              const ticket = await reserve();
              try {
                if (i === 0) {
                  allocation.controls.loseReply = true;
                  await assert.rejects(issuer(ticket.complete));
                  assert.equal(allocation.journal.size, 1);
                }
                ticket.issued = await issuer(ticket.complete);
                assert.deepEqual(await issuer(ticket.complete), ticket.issued);
                f.tickets.push(ticket);
              } catch (e) {
                ticket.secret.fill(0);
                throw e;
              }
            }
            allocation.controls.collision = true;
            const conflict = await reserve();
            try {
              await assert.rejects(issuer(conflict.complete));
              await assert.rejects(issuer(conflict.complete));
            } finally {
              conflict.secret.fill(0);
            }
            assert.equal(
              await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
              "3",
            );
            assert.equal(
              await f.sql(
                "SELECT count(DISTINCT receiver_ref) FROM darkpool_private.tickets;",
              ),
              "3",
            );
          },
        );
        await withObservationReader(f, async ({ reader, role }) => {
          const outputs = f.payment().outputs;
          await t.test(
            "context-only DB role and observe-only IPC cannot mutate or accept; preview redacts private data",
            async () => {
              const unchanged = await evidence(f);
              const transport = observeOnlyTransport(
                scannerChild({ observed: observedOutputs(outputs) }),
              );
              try {
                const report = await createObservationPreview({
                  readContext: reader,
                  observe: transport.observe,
                }).check();
                assert.deepEqual(report, {
                  mode: "OBSERVATION_ONLY",
                  status: "OBSERVED_UNVERIFIED",
                  acceptance: "NOT_EVALUATED",
                  financial_authorization: "NOT_GRANTED",
                  spending_enabled: false,
                });
                for (const value of [
                  outputs[0].receiver_ref,
                  outputs[0].ticket_id,
                  outputs[0].journal_commitment,
                ])
                  assert(!JSON.stringify(report).includes(value));
              } finally {
                await transport.close();
              }
              assert.equal(await evidence(f), unchanged);
              assert.equal(await accepted(f), "0");
              // Prove DB privileges, not just absence of methods in a JS object.
              for (const statement of [
                "SELECT darkpool_watcher.reconcile(0,'{}'::jsonb);",
                "SELECT to_jsonb(t) FROM darkpool_private.tickets t;",
                "SELECT darkpool_lock.begin_lock('{}'::jsonb);",
              ])
                await assert.rejects(
                  f.sql(
                    `BEGIN; SET LOCAL ROLE "${role}"; ${statement} ROLLBACK;`,
                  ),
                );
            },
          );
          await withStop(async (stopFile) => {
            await t.test(
              "scanner crash after pre-sync retention leaves recoverable receipt, never acceptance",
              async () => {
                await assert.rejects(
                  cycle(f, stopFile, snapshot(f, 101, [outputs[0]]), {
                    mode: "exit-sync",
                  }),
                );
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.payment_receipts;",
                  ),
                  "1",
                );
                assert.equal(await accepted(f), "0");
                await cycle(f, stopFile, snapshot(f, 101, [outputs[0]]));
                assert.equal(await accepted(f), "0");
              },
            );
            await t.test(
              "delayed confirmations and pre-finality reorg remain unaccepted; remining confirms once",
              async () => {
                await cycle(f, stopFile, snapshot(f, 102, [outputs[0]]));
                assert.equal(
                  (await status(statusPacket(f, f.tickets[0]))).status,
                  "AWAITING_PAYMENT",
                );
                const orphan = {
                  ...outputs[0],
                  present: false,
                  canonical: false,
                  block_height: null,
                  block_hash: null,
                  block_time: null,
                  tx_index: null,
                };
                await cycle(f, stopFile, snapshot(f, 102, [orphan]));
                assert.equal(await accepted(f), "0");
                outputs[0] = {
                  ...outputs[0],
                  block_height: 103,
                  block_hash: id(103),
                  block_time: f.close - 3,
                };
                await cycle(f, stopFile, snapshot(f, 105, [outputs[0]]));
                assert.equal(
                  (await status(statusPacket(f, f.tickets[0]))).status,
                  "CONFIRMED",
                );
                assert.equal(await accepted(f), "1");
              },
            );
            await t.test(
              "wrong receiver excluded; malformed observation rolls back; acknowledged replay never duplicates",
              async () => {
                const wrong = { ...outputs[1], receiver_ref: addresses[4] };
                await cycle(f, stopFile, snapshot(f, 114, [outputs[0], wrong]));
                assert.equal(await accepted(f), "1");
                const unchanged = await evidence(f);
                const bad = snapshot(f, 114, [
                  outputs[0],
                  { ...outputs[1], amount_zat: "invalid" },
                ]);
                await assert.rejects(cycle(f, stopFile, bad, { observed: [] }));
                assert.equal(await evidence(f), unchanged);
                const late = {
                  ...outputs[2],
                  block_height: 106,
                  block_hash: id(106),
                  block_time: f.close,
                };
                const final = snapshot(f, 114, [outputs[0], outputs[1], late]);
                let lost = true;
                const attempts = [];
                const db = {
                  context: () => f.watcher.context(),
                  reconcile: async (rev, p) => {
                    if (p.mode === "snapshot") attempts.push(p.request_id);
                    const r = await f.watcher.reconcile(rev, p);
                    if (p.mode === "snapshot" && lost) {
                      lost = false;
                      throw Error("synthetic lost acknowledgement");
                    }
                    return r;
                  },
                };
                await cycle(f, stopFile, final, { db });
                assert.equal(attempts.length, 2);
                assert.equal(attempts[0], attempts[1]);
                assert.equal(await accepted(f), "2");
                await cycle(f, stopFile, final); // Separate scanner process, persisted product evidence.
                assert.equal(await accepted(f), "2");
                assert.equal(
                  await f.sql(
                    "SELECT count(*) FROM darkpool_private.accepted_payment_receipts;",
                  ),
                  "2",
                );
                assert.equal(
                  (await status(statusPacket(f, f.tickets[2]))).status,
                  "AWAITING_PAYMENT",
                );
              },
            );
            await t.test(
              "lock uses canonical retained evidence and original blindings; no downstream authorization",
              async () => {
                if (Date.now() < f.close * 1000)
                  await new Promise((r) =>
                    setTimeout(r, f.close * 1000 - Date.now() + 10),
                  );
                const context = await reader();
                const checkpoint = await f.sql(
                  "SELECT checkpoint_ref FROM darkpool_private.watcher_state;",
                );
                const request = {
                  ...f.lockRequest,
                  expected_watcher_revision: context.revision,
                  checkpoint_ref: checkpoint,
                };
                const locked = await finalizeLock(
                  request,
                  resources,
                  f.env("lock"),
                );
                assert.equal(locked.publication, "PENDING");
                assert.equal(locked.commitment.accepted_ticket_count, "2");
                assert.deepEqual(
                  await finalizeLock(request, resources, f.env("lock")),
                  locked,
                );
                assert.equal(
                  await f.sql(
                    "SELECT (SELECT count(*) FROM darkpool_private.ledger_publication_receipts)+(SELECT count(*) FROM darkpool_private.resolution_results)+(SELECT count(*) FROM darkpool_private.claim_reservations)+(SELECT count(*) FROM darkpool_private.payout_intents);",
                  ),
                  "0",
                );
                await assert.rejects(
                  f.sql(
                    "UPDATE darkpool_private.ledger_records SET accepted_amount_zat=1;",
                  ),
                );
              },
            );
          });
        });
      } finally {
        await allocation.close();
      }
    });
  },
);
test(
  "post-acceptance canonical contradiction holds history and blocks locking after process restart",
  { timeout: 90000 },
  async () => {
    await withSyntheticLifecycle(publisher, addresses, async (f) => {
      await open(f);
      for (let i = 0; i < 3; i++) await f.createTicket("YES", "1000");
      await withStop(async (stopFile) => {
        const initial = {
          outputs: f.payment().outputs,
          chain: f.request.chain,
        };
        await cycle(f, stopFile, initial);
        assert.equal(await accepted(f), "3");
        const changed = structuredClone(initial);
        Object.assign(changed.outputs[0], {
          canonical: false,
          present: false,
          block_height: null,
          block_hash: null,
          block_time: null,
          tx_index: null,
        });
        assert.equal((await cycle(f, stopFile, changed)).result, "HELD");
        assert.equal(await accepted(f), "3"); // Accepted history is never silently rewritten.
        assert.equal((await f.watcher.context()).hold, true);
        await assert.rejects(
          finalizeLock(f.lockRequest, resources, f.env("lock")),
        );
        await assert.rejects(access(stopFile)); // Durable hold acknowledged before removing local pending-stop file.
        const held = await cycle(f, stopFile, initial);
        assert.equal(held.result, "HELD");
        assert.equal((await f.watcher.context()).hold, true);
      });
    });
  },
);

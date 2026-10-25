import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { resolve } from "node:path";
import { privateProcess } from "../../services/backup/crypto.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { createOperationsAdapter } from "../../services/operations/commands.mjs";
import {
  withSyntheticLifecycle,
  assertSyntheticLifecycle,
  resources,
} from "./lifecycle-fixtures.mjs";
import { id } from "./lock-fixtures.mjs";
import {
  authority,
  executable,
  syntheticRetrieval,
} from "../../services/publication/test/fixtures.mjs";
import { createPublicReader } from "../public-read.mjs";

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
const wire = (operation, request = {}) =>
  JSON.stringify({ operation, request });
const roleFor = {
  admin: "admin",
  lock: "lock",
  publication: "publication",
  oracle: "oracle",
  settlement: "coordinator",
  claim: "claim",
  planner: "planner",
};
const failed = (response) =>
  assert(
    ["REJECTED", "BLOCKED", "UNCONFIRMED"].includes(response.result),
    "operation must fail closed",
  );
const wait = async (until) => {
  if (until > Date.now())
    await new Promise((r) => setTimeout(r, until - Date.now()));
};
const state = (f) =>
  f.sql(`SELECT jsonb_build_object('market',(SELECT status FROM darkpool_private.markets),'revision',(SELECT revision::text FROM darkpool_private.admin_revisions),
 'roots',(SELECT count(*) FROM darkpool_private.ledger_commitments),'receipts',(SELECT count(*) FROM darkpool_private.ledger_publication_receipts),
 'resolutions',(SELECT count(*) FROM darkpool_private.resolution_results),'entitlements',(SELECT count(*) FROM darkpool_private.entitlements),
 'claims',(SELECT count(*) FROM darkpool_private.claim_reservations),'intents',(SELECT count(*) FROM darkpool_private.payout_intents),'audit',(SELECT count(*) FROM darkpool_private.audit_events));`);
const source = (f) =>
  f.sql(`SELECT jsonb_build_object('ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY ticket_id) FROM darkpool_private.ledger_records l),
 'roots',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.ledger_commitments c),'accepted',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM darkpool_private.accepted_payments a));`);
const resourceEnv = {
  DARKPOOL_LOCK_MAX_TICKETS: "4096",
  DARKPOOL_LOCK_MAX_TEXT_BYTES: "8192",
  DARKPOOL_LOCK_MAX_AMOUNT_BYTES: "128",
  DARKPOOL_LOCK_MAX_LEDGER_BYTES: "4194304",
};
const cli = async (f, purpose, packet, role = roleFor[purpose], extra = {}) => {
  const result = await runBounded(
    process.execPath,
    ["services/operations/cli.mjs", purpose],
    {
      timeoutMs: 20000,
      env: {
        ...f.env(role),
        DARKPOOL_OPERATIONS_INTERNAL: "1",
        ...resourceEnv,
        ...extra,
      },
      input: typeof packet === "string" ? packet : JSON.stringify(packet),
      maxBytes: 131072,
    },
  );
  assert.equal(result.stderr, "");
  assert(!result.timedOut && !result.spawnFailed);
  assert([0, 1].includes(boundedExit(result)));
  return JSON.parse(result.stdout);
};
const api = (f, purpose, extra = {}, role = roleFor[purpose]) =>
  createOperationsAdapter({
    purpose,
    env: { ...f.env(role), DARKPOOL_OPERATIONS_INTERNAL: "1" },
    ...extra,
  });
const approval = (f, locked, outcome) => ({
  request_key: "adapter_resolution",
  market_id: f.mid,
  expected_revision: locked.revision,
  expected_root: locked.commitment.merkle_root,
  resolution_id: "adapter_resolution_v1",
  outcome,
  evidence: ["synthetic-source:objective-observation"],
  rule_version: f.rule.rule_version,
  review: {
    decision: outcome === "VOID" ? "AMBIGUOUS" : "DEFENSIBLE",
    source_ref: "synthetic-source",
    observation_at: f.observation,
    rationale: "Synthetic declared objective review",
  },
  authorize_entitlements: true,
});
const cases = [
  {
    name: "YES",
    outcome: "YES",
    positions: [
      ["YES", "1"],
      ["NO", "1"],
      ["YES", "1"],
    ],
    amounts: null,
  },
  {
    name: "NO",
    outcome: "NO",
    positions: [
      ["NO", "2"],
      ["YES", "2"],
      ["NO", "1"],
    ],
    amounts: ["3", "0", "2"],
  },
  {
    name: "NO_WINNER_REFUND",
    outcome: "NO",
    positions: [
      ["YES", "2"],
      ["YES", "1"],
      ["YES", "1"],
    ],
    amounts: ["2", "1", "1"],
  },
  {
    name: "VOID",
    outcome: "VOID",
    positions: [
      ["YES", "2"],
      ["NO", "1"],
      ["YES", "3"],
    ],
    amounts: ["2", "1", "3"],
  },
];
for (const scenario of cases)
  test(
    `purpose-scoped operational adapters: ${scenario.name}`,
    { timeout: 150000 },
    async (t) => {
      await withSyntheticLifecycle(publisher, addresses, async (f) => {
        let locked, proof, seal, read;
        await t.test(
          "admin CLI creates/opens with original login, revisions and replay",
          async () => {
            const create = {
              request_key: "create",
              expected_revision: null,
              configuration: f.configuration,
            };
            const made = await cli(f, "admin", {
              operation: "create",
              request: create,
            });
            assert.equal(made.result, "APPLIED");
            assert.equal(made.control.market.status, "DRAFT");
            assert.deepEqual(
              await cli(f, "admin", { operation: "create", request: create }),
              made,
            );
            await f.register();
            const baseline = await state(f);
            failed(
              await cli(
                f,
                "admin",
                {
                  operation: "open",
                  request: {
                    request_key: "wrong_role",
                    expected_revision: "1",
                  },
                },
                "other",
              ),
            );
            failed(
              await cli(f, "admin", {
                operation: "open",
                request: { request_key: "stale", expected_revision: "9" },
              }),
            );
            assert.equal(await state(f), baseline);
            const packet = {
              operation: "open",
              request: { request_key: "open", expected_revision: "1" },
            };
            const opened = await cli(f, "admin", packet);
            assert.equal(opened.result, "APPLIED");
            assert.equal(opened.control.market.status, "OPEN");
            assert.equal(opened.control.market.payout_ready, false);
            assert.deepEqual(await cli(f, "admin", packet), opened);
            failed(
              await cli(f, "admin", {
                operation: "finalize-lock",
                request: f.lockRequest,
              }),
              "admin cannot borrow the finalizer capability",
            );
            read = await createPublicReader(f.env("read"));
            assert.equal((await read())[0].status, "OPEN");
          },
        );
        await t.test(
          "issued synthetic tickets, canonical watcher and authorized atomic lock CLI",
          async () => {
            for (const [side, amount] of scenario.positions)
              await f.createTicket(side, amount);
            await wait(f.close * 1000 + 10);
            await f.watcher.reconcile(0, f.payment());
            const baseline = await state(f);
            failed(
              await cli(
                f,
                "lock",
                { operation: "finalize-lock", request: f.lockRequest },
                "admin",
              ),
            );
            failed(
              await cli(f, "lock", {
                operation: "finalize-lock",
                request: { ...f.lockRequest, expected_revision: "1" },
              }),
            );
            assert.equal(
              (
                await cli(
                  f,
                  "lock",
                  { operation: "finalize-lock", request: f.lockRequest },
                  "lock",
                  {
                    DARKPOOL_LOCK_MAX_TICKETS: undefined,
                    DARKPOOL_LOCK_MAX_TEXT_BYTES: undefined,
                    DARKPOOL_LOCK_MAX_AMOUNT_BYTES: undefined,
                    DARKPOOL_LOCK_MAX_LEDGER_BYTES: undefined,
                  },
                )
              ).result,
              "BLOCKED",
            );
            assert.equal(await state(f), baseline);
            locked = await cli(f, "lock", {
              operation: "finalize-lock",
              request: f.lockRequest,
            });
            assert.equal(locked.result, "LOCKED");
            assert.equal(locked.revision, "3");
            assert.equal(locked.publication, "PENDING");
            seal = await source(f);
            assert.deepEqual(
              await cli(f, "lock", {
                operation: "finalize-lock",
                request: f.lockRequest,
              }),
              locked,
            );
            assert.equal(await source(f), seal);
            assert.deepEqual(Object.keys(locked.commitment).sort(), [
              "accepted_ticket_count",
              "ledger_version",
              "locked_at",
              "market_id",
              "merkle_root",
            ]);
          },
        );
        await t.test(
          "pending publication blocks resolution and claims; verified-receipt processor only",
          async () => {
            const baseline = await state(f),
              q = approval(f, locked, scenario.outcome);
            failed(
              await cli(f, "oracle", {
                operation: "approve-resolution",
                request: q,
              }),
            );
            failed(
              await cli(f, "settlement", {
                operation: "finalize-resolution",
                request: { request_key: q.request_key },
              }),
            );
            failed(
              await cli(f, "claim", {
                operation: "reserve-claim",
                request: {
                  market_id: f.mid,
                  ticket_id: f.tickets[0].id,
                  claim_secret: Buffer.from(f.tickets[0].secret).toString(
                    "hex",
                  ),
                  payout_ua: addresses[3],
                  idempotency_key: "pending",
                },
              }),
            );
            assert.equal(await state(f), baseline);
            await wait(Date.parse(locked.commitment.locked_at) + 1100);
            proof = await publisher.evidence(locked.commitment);
            const packet = {
              operation: "verify-publication",
              request: { market_id: f.mid, evidence: proof },
            };
            const unavailable = await cli(f, "publication", packet);
            assert.equal(unavailable.result, "BLOCKED");
            assert.equal(unavailable.code, "PUBLICATION_VERIFIER_UNAVAILABLE");
            const publication = {
              trust: publisher.trust,
              executable,
              retrieve: syntheticRetrieval(proof),
            };
            const verifier = await api(f, "publication", { publication });
            failed(
              await verifier(
                wire("verify-publication", {
                  ...packet.request,
                  trust: publisher.trust,
                }),
              ),
            );
            const wrong = await api(f, "publication", { publication }, "other");
            failed(await wrong(JSON.stringify(packet)));
            const changed = structuredClone(proof);
            changed.signature = "AA".repeat(44);
            failed(
              await verifier(
                wire("verify-publication", {
                  market_id: f.mid,
                  evidence: changed,
                }),
              ),
            );
            assert.equal(await state(f), baseline);
            const receipt = await verifier(JSON.stringify(packet));
            assert.equal(receipt.publication, "SYNTHETIC_TEST_ONLY");
            assert.deepEqual(await verifier(JSON.stringify(packet)), receipt);
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.ledger_publication_receipts;",
              ),
              "1",
            );
            assert.equal(await source(f), seal);
          },
        );
        await t.test(
          "manual oracle and settlement CLI preserve objective evidence and atomic PAYING/REFUNDING",
          async () => {
            const q = approval(f, locked, scenario.outcome),
              baseline = await state(f);
            failed(
              await cli(
                f,
                "oracle",
                { operation: "approve-resolution", request: q },
                "admin",
              ),
            );
            failed(
              await cli(f, "oracle", {
                operation: "approve-resolution",
                request: { ...q, expected_revision: "2" },
              }),
            );
            failed(
              await cli(f, "oracle", {
                operation: "approve-resolution",
                request: { ...q, expected_root: id(555) },
              }),
            );
            assert.equal(await state(f), baseline);
            const approved = await cli(f, "oracle", {
              operation: "approve-resolution",
              request: q,
            });
            assert.equal(approved.result, "ORACLE_APPROVAL_RECORDED");
            assert.deepEqual(
              await cli(f, "oracle", {
                operation: "approve-resolution",
                request: q,
              }),
              approved,
            );
            failed(
              await cli(f, "oracle", {
                operation: "approve-resolution",
                request: {
                  ...q,
                  outcome: scenario.outcome === "YES" ? "NO" : "YES",
                },
              }),
            );
            failed(
              await cli(f, "oracle", {
                operation: "approve-resolution",
                request: { ...q, evidence: ["synthetic-source:conflict"] },
              }),
            );
            failed(
              await cli(
                f,
                "settlement",
                {
                  operation: "finalize-resolution",
                  request: { request_key: q.request_key },
                },
                "oracle",
              ),
            );
            const packet = {
              operation: "finalize-resolution",
              request: { request_key: q.request_key },
            };
            const recorded = await cli(f, "settlement", packet);
            assert.equal(recorded.result, "RESOLUTION_RECORDED");
            assert.equal(recorded.execution_class, "SYNTHETIC_TEST");
            assert.equal(recorded.spending_authorized, false);
            assert.equal(
              recorded.recorded_state,
              scenario.outcome === "VOID" ? "REFUNDING" : "PAYING",
            );
            assert.equal(recorded.revision, "4");
            assert.deepEqual(await cli(f, "settlement", packet), recorded);
            const amounts = JSON.parse(
              await f.sql(
                "SELECT jsonb_object_agg(ticket_id,amount_zat::text) FROM darkpool_private.entitlements;",
              ),
            );
            let expected = scenario.amounts;
            if (!expected) {
              const winners = f.tickets
                .filter((x) => x.side === "YES")
                .map((x) => x.id)
                .sort();
              expected = f.tickets.map((x) =>
                x.side === "NO" ? "0" : x.id === winners[0] ? "2" : "1",
              );
            }
            assert.deepEqual(
              f.tickets.map((x) => amounts[x.id]),
              expected,
            );
            assert.equal(
              Object.values(amounts).reduce((n, x) => n + BigInt(x), 0n),
              f.tickets.reduce((n, x) => n + BigInt(x.amount), 0n),
            );
            assert.equal(await source(f), seal);
          },
        );
        await t.test(
          "private credential CLI, claim conflicts, idempotent planner and public isolation",
          async () => {
            const claims = await api(f, "claim"),
              planner = await api(f, "planner"),
              wrongClaim = await api(f, "claim", {}, "other");
            const amounts = JSON.parse(
              await f.sql(
                "SELECT jsonb_object_agg(ticket_id,amount_zat::text) FROM darkpool_private.entitlements;",
              ),
            );
            const responses = [];
            let first = true;
            for (const ticket of f.tickets) {
              const q = {
                market_id: f.mid,
                ticket_id: ticket.id,
                claim_secret: Buffer.from(ticket.secret).toString("hex"),
                payout_ua: addresses[3 + ticket.index],
                idempotency_key: "adapter_claim_" + ticket.index,
              };
              if (amounts[ticket.id] === "0") {
                failed(await claims(wire("reserve-claim", q)));
                continue;
              }
              const before = await state(f);
              failed(await wrongClaim(wire("reserve-claim", q)));
              const invalid = await claims(
                wire("reserve-claim", { ...q, claim_secret: "00".repeat(32) }),
              );
              failed(invalid);
              assert.deepEqual(Object.keys(invalid).sort(), [
                "code",
                "recovery",
                "result",
              ]);
              assert.equal(await state(f), before);
              const reserve = first
                ? await cli(f, "claim", {
                    operation: "reserve-claim",
                    request: q,
                  })
                : await claims(wire("reserve-claim", q));
              assert.equal(reserve.state, "RESERVED");
              assert.deepEqual(await claims(wire("reserve-claim", q)), reserve);
              failed(
                await claims(
                  wire("reserve-claim", {
                    ...q,
                    payout_ua: addresses[3 + ((ticket.index + 1) % 3)],
                  }),
                ),
              );
              const prepared = await claims(wire("prepare-payout", q));
              assert.equal(prepared.state, "PREPARED");
              assert.deepEqual(
                await claims(wire("prepare-payout", q)),
                prepared,
              );
              const plan = { claim_id: reserve.reservation_id };
              const intent = first
                ? await cli(f, "planner", {
                    operation: "plan-payout",
                    request: plan,
                  })
                : await planner(wire("plan-payout", plan));
              assert.equal(intent.result, "PAYOUT_INTENT");
              assert.equal(intent.spending_authorized, false);
              assert.equal(intent.submission_enabled, false);
              assert.deepEqual(
                await planner(wire("plan-payout", plan)),
                intent,
              );
              responses.push(reserve, prepared, intent);
              first = false;
            }
            const count = Object.values(amounts).filter(
              (x) => x !== "0",
            ).length;
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.claim_reservations;",
              ),
              String(count),
            );
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.payout_intents;",
              ),
              String(count),
            );
            assert.equal(
              await f.sql(
                "SELECT sum(amount_zat)::text FROM darkpool_private.payout_intents;",
              ),
              f.tickets.reduce((n, x) => n + BigInt(x.amount), 0n).toString(),
            );
            const publicText = JSON.stringify(await read()),
              responseText = JSON.stringify(responses);
            for (const ticket of f.tickets) {
              assert.equal(publicText.includes(ticket.id), false);
              assert.equal(
                responseText.includes(
                  Buffer.from(ticket.secret).toString("hex"),
                ),
                false,
              );
            }
            for (const ua of addresses) {
              assert.equal(publicText.includes(ua), false);
              assert.equal(responseText.includes(ua), false);
            }
            for (const key of [
              "payout_ua",
              "claim_secret",
              "record_blinding",
              "amount_zat",
              "side",
            ])
              assert.equal(responseText.includes('"' + key + '"'), false);
            await assert.rejects(
              f.roleQuery(
                "read",
                "SELECT to_jsonb(c) FROM darkpool_private.claim_reservations c LIMIT 1;",
              ),
            );
            assert.equal(await source(f), seal);
            for (const change of [
              { PGPORT: "55435" },
              { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
              { PGUSER: "darkpool_test_maintenance" },
            ])
              failed(
                await cli(
                  f,
                  "admin",
                  { operation: "inspect", request: {} },
                  "admin",
                  change,
                ),
              );
          },
        );
      });
    },
  );
test(
  "EXTERNAL authorization cannot consume a synthetic receipt through the new adapters",
  { timeout: 90000 },
  async () => {
    await withSyntheticLifecycle(
      publisher,
      addresses,
      async (f) => {
        const admin = await api(f, "admin"),
          lock = await api(f, "lock", { lockResources: resources }),
          oracle = await api(f, "oracle");
        assert.equal(
          (
            await admin(
              wire("create", {
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
              wire("open", { request_key: "open", expected_revision: "1" }),
            )
          ).result,
          "APPLIED",
        );
        await wait(f.close * 1000 + 10);
        await f.watcher.reconcile(0, { ...f.request, outputs: [] });
        const locked = await lock(wire("finalize-lock", f.lockRequest));
        assert.equal(locked.result, "LOCKED");
        await wait(Date.parse(locked.commitment.locked_at) + 1100);
        const proof = await publisher.evidence(locked.commitment);
        const verifier = await api(f, "publication", {
          publication: {
            trust: publisher.trust,
            executable,
            retrieve: syntheticRetrieval(proof),
          },
        });
        assert.equal(
          (
            await verifier(
              wire("verify-publication", { market_id: f.mid, evidence: proof }),
            )
          ).publication,
          "SYNTHETIC_TEST_ONLY",
        );
        const baseline = await state(f);
        failed(
          await oracle(wire("approve-resolution", approval(f, locked, "VOID"))),
        );
        assert.equal(await state(f), baseline);
        assert.equal(JSON.parse(baseline).market, "LOCKED");
        assert.equal(JSON.parse(baseline).resolutions, 0);
      },
      { oracleClass: "EXTERNAL" },
    );
  },
);

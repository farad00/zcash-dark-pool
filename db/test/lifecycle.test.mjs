import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { resolve } from "node:path";
import { privateProcess } from "../../services/backup/crypto.mjs";
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
import {
  finalizeLock,
  finalizeInSession,
} from "../../services/lock/finalize.mts";
import { openLockSession } from "../../services/lock/db-session.mjs";
import {
  persistPublication,
  persistVerifiedInSession,
} from "../../services/publication/persist.mjs";
import { verifyPublication } from "../../services/publication/verify.mjs";
import { approveResolution } from "../../services/resolution/approve.mjs";
import {
  finalizeResolution,
  resolveInSession,
} from "../../services/resolution/prepare.mjs";
import {
  reserveDurableClaim,
  prepareDurablePayout,
  claimInSession,
} from "../../services/claims/reserve.mjs";
import {
  planPayoutIntent,
  planInSession,
} from "../../services/payout/plan.mjs";
import { recordPayoutObservation } from "../../services/payout/reconcile.mjs";
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
  assert.equal(new Set(addresses).size, 6);
});
after(async () => {
  await publisher?.close();
});
const sleepUntil = async (ms) => {
  if (ms > Date.now()) await new Promise((r) => setTimeout(r, ms - Date.now()));
};
const stats = async (f) =>
  JSON.parse(
    await f.sql(`SELECT jsonb_build_object(
 'state',(SELECT status FROM darkpool_private.markets),'revision',(SELECT revision::text FROM darkpool_private.admin_revisions),
 'tickets',(SELECT count(*) FROM darkpool_private.tickets),'payments',(SELECT count(*) FROM darkpool_private.accepted_payments),
 'locks',(SELECT count(*) FROM darkpool_private.lock_requests),'ledger',(SELECT count(*) FROM darkpool_private.ledger_records),
 'publications',(SELECT count(*) FROM darkpool_private.ledger_publication_receipts),'results',(SELECT count(*) FROM darkpool_private.resolution_results),
 'entitlements',(SELECT count(*) FROM darkpool_private.entitlements),'claims',(SELECT count(*) FROM darkpool_private.claim_reservations),
 'instructions',(SELECT count(*) FROM darkpool_private.claim_instruction_outbox),'intents',(SELECT count(*) FROM darkpool_private.payout_intents),
 'audit',(SELECT count(*) FROM darkpool_private.audit_events));`),
  );
const seal = (f) =>
  f.sql(`SELECT jsonb_build_object(
 'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY ticket_id) FROM darkpool_private.ledger_records l),
 'root',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.ledger_commitments c),
 'accepted',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM darkpool_private.accepted_payments a),
 'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM darkpool_private.payment_receipts r));`);
const lockedEnv = (f, role) => ({
  ...f.env(role),
  DARKPOOL_LOCK_INTERNAL: "1",
});
// Crash immediately before COMMIT, after real durable-staging SQL. Closing the
// original connection must roll the whole operation back, with no manual repair.
async function interrupted(f, role, operation) {
  const baseline = await stats(f),
    session = await openLockSession(lockedEnv(f, role));
  let injected = false;
  try {
    await assert.rejects(
      operation({
        query: (statement) => {
          if (/^COMMIT;/.test(statement)) {
            injected = true;
            throw new Error("SYNTHETIC_PROCESS_INTERRUPTION");
          }
          return session.query(statement);
        },
      }),
    );
    assert.equal(injected, true, "must reach pre-commit interruption point");
  } finally {
    await session.close();
  }
  assert.deepEqual(
    await stats(f),
    baseline,
    "interrupted transaction must roll back all effects",
  );
}
function approval(f, locked, outcome) {
  return {
    request_key: "synthetic_resolution",
    market_id: f.mid,
    expected_revision: locked.revision,
    expected_root: locked.commitment.merkle_root,
    resolution_id: "synthetic_resolution_v1",
    outcome,
    evidence: ["synthetic-source:objective-observation"],
    rule_version: f.rule.rule_version,
    review: {
      decision: outcome === "VOID" ? "AMBIGUOUS" : "DEFENSIBLE",
      source_ref: "synthetic-source",
      observation_at: f.observation,
      rationale: "Synthetic objective manual review",
    },
    authorize_entitlements: true,
  };
}
const scenarios = [
  {
    name: "YES with lexical remainder tie",
    outcome: "YES",
    positions: [
      ["YES", "1"],
      ["NO", "1"],
      ["YES", "1"],
    ],
    mode: "WINNING_PAYOUT",
  },
  {
    name: "NO with unequal stakes and residual",
    outcome: "NO",
    positions: [
      ["NO", "2"],
      ["YES", "2"],
      ["NO", "1"],
    ],
    mode: "WINNING_PAYOUT",
  },
  {
    name: "no-winner full refunds",
    outcome: "NO",
    positions: [
      ["YES", "2"],
      ["YES", "1"],
      ["YES", "1"],
    ],
    mode: "NO_WINNER_REFUND",
  },
  {
    name: "VOID full refunds",
    outcome: "VOID",
    positions: [
      ["YES", "2"],
      ["NO", "1"],
      ["YES", "3"],
    ],
    mode: "VOID_REFUND",
  },
];
for (const scenario of scenarios)
  test(
    `SYNTHETIC_TEST lifecycle: ${scenario.name}`,
    { timeout: 120000 },
    async (t) => {
      await withSyntheticLifecycle(publisher, addresses, async (f) => {
        let opened, locked, evidence, resolution, publicRead, frozen;
        const faultInjection = scenario.outcome === "YES";
        await t.test(
          "authenticated create, DRAFT authority, OPEN/replay and stale revision",
          async () => {
            const create = {
              request_key: "create",
              expected_revision: null,
              configuration: f.configuration,
            };
            const made = await f.admin("create", create);
            assert.equal(made.result, "APPLIED");
            assert.equal(made.control.market.status, "DRAFT");
            assert.deepEqual(await f.admin("create", create), made);
            await f.register(); // Predeclared synthetic binding/authority only.
            const baseline = await stats(f);
            assert.equal(
              (
                await f.admin("open", {
                  request_key: "stale",
                  expected_revision: "9",
                })
              ).code,
              "RETRY_OR_REVISION_CONFLICT",
            );
            assert.equal(
              (
                await f.admin(
                  "open",
                  { request_key: "not_operator", expected_revision: "1" },
                  "other",
                )
              ).result,
              "REJECTED",
            );
            assert.deepEqual(await stats(f), baseline);
            const request = { request_key: "open", expected_revision: "1" };
            opened = await f.admin("open", request);
            assert.equal(opened.control.market.status, "OPEN");
            assert.equal(opened.control.market.revision, "2");
            assert.equal(opened.control.market.payout_ready, false);
            assert.deepEqual(await f.admin("open", request), opened);
            publicRead = await createPublicReader(f.env("read"));
            assert.equal((await publicRead())[0].status, "OPEN");
            assert.equal(
              (await f.admin("finalize-lock")).result,
              "BLOCKED",
              "generic admin dispatcher remains unchanged",
            );
          },
        );
        await t.test(
          "existing issuer handshake, independent bearer commitments and private projection",
          async () => {
            for (const [side, amount] of scenario.positions)
              await f.createTicket(side, amount);
            const rows = JSON.parse(
              await f.sql(
                "SELECT jsonb_agg(jsonb_build_object('id',id,'stake',requested_amount_zat::text,'accepted',accepted_amount_zat::text,'state',payment_state) ORDER BY id) FROM darkpool_private.tickets;",
              ),
            );
            assert.equal(rows.length, 3);
            assert(
              rows.every(
                (r) => r.state === "AWAITING_PAYMENT" && r.accepted === "0",
              ),
            );
            assert.equal(new Set(f.tickets.map((x) => x.id)).size, 3);
            assert.equal(
              await f.sql(
                "SELECT count(DISTINCT receiver_ref) FROM darkpool_private.tickets;",
              ),
              "3",
            );
            const sqlText = f.issuanceStatements.join("\n"),
              publicText = JSON.stringify(await publicRead());
            for (const ticket of f.tickets) {
              assert.equal(
                sqlText.includes(Buffer.from(ticket.secret).toString("hex")),
                false,
                "creation SQL must never receive bearer secret",
              );
              assert.equal(publicText.includes(ticket.id), false);
            }
            assert.equal(publicText.includes("synthetic-vault"), false);
            for (const ua of addresses)
              assert.equal(publicText.includes(ua), false);
          },
        );
        await t.test(
          "delayed canonical watcher acceptance, scan replay, conflict and close refusal",
          async () => {
            await sleepUntil(f.close * 1000 + 10);
            await assert.rejects(f.createTicket("YES", "1"));
            const payment = f.payment();
            const accepted = await f.watcher.reconcile(0, payment);
            const baseline = await stats(f);
            assert.equal(baseline.payments, 3);
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.tickets WHERE payment_state='CONFIRMED' AND accepted_amount_zat=requested_amount_zat;",
              ),
              "3",
            );
            assert.deepEqual(await f.watcher.reconcile(0, payment), accepted);
            await assert.rejects(
              f.watcher.reconcile(0, { ...payment, request_id: id(5000) }),
            );
            assert.deepEqual(await stats(f), baseline);
          },
        );
        await t.test(
          "atomic lock, authorization, stale revision, rollback and original blinding retry",
          async () => {
            const baseline = await stats(f);
            await assert.rejects(
              finalizeLock(
                { ...f.lockRequest, expected_revision: "1" },
                resources,
                f.env("lock"),
              ),
            );
            await assert.rejects(
              finalizeLock(f.lockRequest, resources, lockedEnv(f, "admin")),
            );
            assert.deepEqual(await stats(f), baseline);
            if (faultInjection)
              await interrupted(f, "lock", (s) =>
                finalizeInSession(s, f.lockRequest, resources),
              );
            locked = await finalizeLock(
              f.lockRequest,
              resources,
              f.env("lock"),
            );
            assert.equal(locked.result, "LOCKED");
            assert.equal(locked.revision, "3");
            assert.equal(locked.publication, "PENDING");
            frozen = await seal(f);
            assert.deepEqual(
              await finalizeLock(f.lockRequest, resources, f.env("lock")),
              locked,
            );
            assert.equal(await seal(f), frozen);
            await assert.rejects(
              finalizeLock(
                { ...f.lockRequest, request_key: "conflicting_lock" },
                resources,
                f.env("lock"),
              ),
            );
            await assert.rejects(
              f.sql(
                "UPDATE darkpool_private.ledger_records SET record_blinding=decode(repeat('ff',32),'hex');",
              ),
            );
            assert.equal(await seal(f), frozen);
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
          "PENDING blocks oracle/claim; cryptographic synthetic publication, tamper/EXTERNAL rejection and replay",
          async () => {
            const q = approval(f, locked, scenario.outcome),
              baseline = await stats(f);
            await assert.rejects(approveResolution(q, f.env("oracle")));
            await assert.rejects(
              reserveDurableClaim(
                {
                  market_id: f.mid,
                  ticket_id: f.tickets[0].id,
                  claim_secret: f.tickets[0].secret,
                  payout_ua: addresses[3],
                  idempotency_key: "pending",
                },
                f.env("claim"),
              ),
            );
            assert.deepEqual(await stats(f), baseline);
            await sleepUntil(Date.parse(locked.commitment.locked_at) + 1100);
            evidence = await publisher.evidence(locked.commitment);
            const retrieve = syntheticRetrieval(evidence);
            await assert.rejects(
              persistPublication(
                f.mid,
                {
                  ...evidence,
                  envelope: { ...evidence.envelope, merkle_root: id(999) },
                },
                publisher.trust,
                executable,
                f.env("publication"),
                retrieve,
              ),
            );
            await assert.rejects(
              verifyPublication(
                locked.commitment,
                evidence,
                { ...publisher.trust, evidence_class: "EXTERNAL" },
                executable,
                retrieve,
              ),
            );
            assert.deepEqual(await stats(f), baseline);
            if (faultInjection) {
              const verified = await verifyPublication(
                locked.commitment,
                evidence,
                publisher.trust,
                executable,
                retrieve,
              );
              await interrupted(f, "publication", (s) =>
                persistVerifiedInSession(s, verified),
              );
            }
            const receipt = await persistPublication(
              f.mid,
              evidence,
              publisher.trust,
              executable,
              f.env("publication"),
              retrieve,
            );
            assert.deepEqual(
              await persistPublication(
                f.mid,
                evidence,
                publisher.trust,
                executable,
                f.env("publication"),
                retrieve,
              ),
              receipt,
            );
            assert.equal(
              await f.sql(
                "SELECT evidence_class FROM darkpool_private.ledger_publication_receipts;",
              ),
              "SYNTHETIC_TEST",
            );
            assert.equal((await stats(f)).publications, 1);
            assert.equal(await seal(f), frozen);
          },
        );
        await t.test(
          "authenticated immutable oracle, exact entitlements, root/revision conflicts and rollback",
          async () => {
            const q = approval(f, locked, scenario.outcome),
              baseline = await stats(f);
            for (const changed of [
              { expected_revision: "2" },
              { expected_root: id(99) },
            ])
              await assert.rejects(
                approveResolution({ ...q, ...changed }, f.env("oracle")),
              );
            await assert.rejects(approveResolution(q, lockedEnv(f, "admin")));
            assert.deepEqual(await stats(f), baseline);
            const approved = await approveResolution(q, f.env("oracle"));
            assert.deepEqual(
              await approveResolution(q, f.env("oracle")),
              approved,
            );
            await assert.rejects(
              approveResolution(
                { ...q, evidence: ["synthetic-source:contradiction"] },
                f.env("oracle"),
              ),
            );
            if (faultInjection)
              await interrupted(f, "coordinator", (s) =>
                resolveInSession(s, q.request_key),
              );
            resolution = await finalizeResolution(
              q.request_key,
              f.env("coordinator"),
            );
            assert.equal(resolution.execution_class, "SYNTHETIC_TEST");
            assert.equal(resolution.spending_authorized, false);
            assert.equal(
              resolution.recorded_state,
              scenario.outcome === "VOID" ? "REFUNDING" : "PAYING",
            );
            assert.deepEqual(
              await finalizeResolution(q.request_key, f.env("coordinator")),
              resolution,
            );
            const stored = JSON.parse(
              await f.sql(
                "SELECT jsonb_object_agg(ticket_id,amount_zat::text) FROM darkpool_private.entitlements;",
              ),
            );
            let expected;
            if (scenario.mode !== "WINNING_PAYOUT")
              expected = Object.fromEntries(
                f.tickets.map((x) => [x.id, x.amount]),
              );
            else if (scenario.outcome === "NO")
              expected = Object.fromEntries(
                f.tickets.map((x, i) => [x.id, ["3", "0", "2"][i]]),
              );
            else {
              const winners = f.tickets
                .filter((x) => x.side === "YES")
                .map((x) => x.id)
                .sort();
              expected = Object.fromEntries(
                f.tickets.map((x) => [
                  x.id,
                  x.side === "NO" ? "0" : x.id === winners[0] ? "2" : "1",
                ]),
              );
            }
            assert.deepEqual(stored, expected);
            const total = f.tickets.reduce(
              (sum, x) => sum + BigInt(x.amount),
              0n,
            );
            assert.equal(
              Object.values(stored).reduce((sum, x) => sum + BigInt(x), 0n),
              total,
            );
            const mode = await f.sql(
              "SELECT preparation#>>'{calculation,mode}' FROM darkpool_private.resolution_results;",
            );
            assert.equal(mode, scenario.mode);
            assert.equal(await seal(f), frozen);
            await assert.rejects(
              f.sql(
                "UPDATE darkpool_private.entitlements SET amount_zat=amount_zat+1;",
              ),
            );
          },
        );
        await t.test(
          "private claims, concurrent identical retries, conflicting destinations and immutable payout planning",
          async () => {
            const entitlements = JSON.parse(
              await f.sql(
                "SELECT jsonb_object_agg(ticket_id,amount_zat::text) FROM darkpool_private.entitlements;",
              ),
            );
            let first = true;
            for (const ticket of f.tickets) {
              const q = {
                market_id: f.mid,
                ticket_id: ticket.id,
                claim_secret: ticket.secret,
                payout_ua: addresses[3 + ticket.index],
                idempotency_key: "claim_" + ticket.index,
              };
              if (entitlements[ticket.id] === "0") {
                await assert.rejects(reserveDurableClaim(q, f.env("claim")));
                continue;
              }
              const baseline = await stats(f);
              await assert.rejects(
                reserveDurableClaim(
                  { ...q, claim_secret: new Uint8Array(32) },
                  f.env("claim"),
                ),
              );
              await assert.rejects(reserveDurableClaim(q, f.env("other")));
              assert.deepEqual(await stats(f), baseline);
              if (faultInjection && first)
                await interrupted(f, "claim", (s) =>
                  claimInSession(s, q, false),
                );
              const race = await Promise.allSettled([
                reserveDurableClaim(q, f.env("claim")),
                reserveDurableClaim(q, f.env("claim")),
              ]);
              assert(race.some((x) => x.status === "fulfilled"));
              const reserved = await reserveDurableClaim(q, f.env("claim"));
              for (const x of race.filter((x) => x.status === "fulfilled"))
                assert.deepEqual(x.value, reserved);
              assert.equal(reserved.state, "RESERVED");
              await assert.rejects(
                reserveDurableClaim(
                  { ...q, payout_ua: addresses[3 + ((ticket.index + 1) % 3)] },
                  f.env("claim"),
                ),
              );
              const prepared = await prepareDurablePayout(q, f.env("claim"));
              assert.equal(prepared.state, "PREPARED");
              assert.deepEqual(
                await prepareDurablePayout(q, f.env("claim")),
                prepared,
              );
              if (faultInjection && first)
                await interrupted(f, "planner", (s) =>
                  planInSession(s, reserved.reservation_id),
                );
              await assert.rejects(
                planPayoutIntent(
                  reserved.reservation_id,
                  lockedEnv(f, "admin"),
                ),
              );
              const planned = await planPayoutIntent(
                reserved.reservation_id,
                f.env("planner"),
              );
              assert.equal(planned.spending_authorized, false);
              assert.equal(planned.submission_enabled, false);
              assert.deepEqual(
                await planPayoutIntent(
                  reserved.reservation_id,
                  f.env("planner"),
                ),
                planned,
              );
              const intent = JSON.parse(
                await f.sql(
                  `SELECT record FROM darkpool_private.payout_intents WHERE claim_id='${reserved.reservation_id}';`,
                ),
              );
              assert.equal(intent.amount_zat, entitlements[ticket.id]);
              assert.equal(intent.payout_ua, q.payout_ua);
              assert.equal(intent.ledger_root, locked.commitment.merkle_root);
              assert.equal(intent.resolution_ref, "synthetic_resolution_v1");
              assert.equal(intent.fee_mode, "EXTERNALLY_SUBSIDIZED");
              assert.equal(intent.execution_class, "SYNTHETIC_TEST");
              if (first) {
                const report = await recordPayoutObservation(
                  reserved.reservation_id,
                  {
                    report_key: "synthetic_interruption",
                    kind: "PROCESS_INTERRUPTED",
                    transaction_id: null,
                    artifact_ref: null,
                    evidence_ref: "synthetic_no_broadcast",
                  },
                  f.env("reconciler"),
                );
                assert.equal(report.planning_state, "RECONCILIATION_REQUIRED");
                assert.equal(report.confirmation_authorized, false);
                assert.equal(report.replacement_authorized, false);
              }
              first = false;
            }
            const final = await stats(f),
              payable = Object.values(entitlements).filter(
                (x) => x !== "0",
              ).length;
            assert.equal(final.claims, payable);
            assert.equal(final.instructions, payable);
            assert.equal(final.intents, payable);
            assert.equal(
              await f.sql(
                "SELECT sum(amount_zat)::text FROM darkpool_private.payout_intents;",
              ),
              f.tickets
                .reduce((sum, x) => sum + BigInt(x.amount), 0n)
                .toString(),
            );
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.claim_reservations WHERE state<>'PREPARED';",
              ),
              "0",
            );
            assert.equal(
              await f.sql("SELECT count(*) FROM darkpool_private.settlements;"),
              "0",
            );
            assert.equal(await seal(f), frozen);
          },
        );
        await t.test(
          "public reader isolation, operator attribution and no secrets in durable records",
          async () => {
            for (const table of [
              "tickets",
              "ledger_records",
              "entitlements",
              "claim_reservations",
              "payout_intents",
            ])
              await assert.rejects(
                f.roleQuery(
                  "read",
                  `SELECT to_jsonb(t) FROM darkpool_private.${table} t LIMIT 1;`,
                ),
              );
            const publicText = JSON.stringify(await publicRead());
            assert.equal(publicText.includes("synthetic-vault"), false);
            for (const ticket of f.tickets)
              assert.equal(publicText.includes(ticket.id), false);
            for (const ua of addresses)
              assert.equal(publicText.includes(ua), false);
            const durable = await f.sql(
              "SELECT jsonb_build_object('claims',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.claim_reservations c),'audit',(SELECT jsonb_agg(to_jsonb(a)) FROM darkpool_private.audit_events a),'intents',(SELECT jsonb_agg(record) FROM darkpool_private.payout_intents));",
            );
            for (const ticket of f.tickets)
              assert.equal(
                durable.includes(Buffer.from(ticket.secret).toString("hex")),
                false,
                "no durable plaintext bearer credential",
              );
            assert.equal(
              await f.sql(
                `SELECT count(*) FROM darkpool_private.audit_events WHERE event='MARKET_OPENED' AND source='${f.roles.admin}';`,
              ),
              "1",
            );
            assert.equal(
              await f.sql("SELECT count(*) FROM darkpool_migrations.applied;"),
              "13",
            );
          },
        );
      });
    },
  );

test("harness refuses protected/default/development selectors before any SQL", () => {
  for (const change of [
    { PGPORT: "55432" },
    { PGPORT: "55434" },
    { PGPORT: "55435" },
    { PGPORT: undefined },
    { PGDATABASE: "darkpool_phase9_development_payment_v2" },
    { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
    { DARKPOOL_PG_ENV: "DEVELOPMENT_ONLY" },
    { DARKPOOL_LIFECYCLE_TEST_ONLY: undefined },
    { WALLET_DB_PATH: "forbidden" },
  ])
    assert.throws(
      () => assertSyntheticLifecycle({ ...process.env, ...change }),
      { message: "SYNTHETIC_LIFECYCLE_ONLY" },
    );
});

test(
  "EXTERNAL oracle policy cannot consume a cryptographically valid synthetic publication",
  { timeout: 90000 },
  async () => {
    await withSyntheticLifecycle(
      publisher,
      addresses,
      async (f) => {
        const made = await f.admin("create", {
          request_key: "create",
          expected_revision: null,
          configuration: f.configuration,
        });
        assert.equal(made.result, "APPLIED");
        await f.register();
        assert.equal(
          (
            await f.admin("open", {
              request_key: "open",
              expected_revision: "1",
            })
          ).result,
          "APPLIED",
        );
        await sleepUntil(f.close * 1000 + 10);
        await f.watcher.reconcile(0, { ...f.request, outputs: [] });
        const locked = await finalizeLock(
          f.lockRequest,
          resources,
          f.env("lock"),
        );
        await sleepUntil(Date.parse(locked.commitment.locked_at) + 1100);
        const evidence = await publisher.evidence(locked.commitment);
        await persistPublication(
          f.mid,
          evidence,
          publisher.trust,
          executable,
          f.env("publication"),
          syntheticRetrieval(evidence),
        );
        const baseline = await stats(f);
        await assert.rejects(
          approveResolution(approval(f, locked, "VOID"), f.env("oracle")),
        );
        assert.deepEqual(await stats(f), baseline);
        assert.equal(baseline.state, "LOCKED");
        assert.equal(baseline.results, 0);
        assert.equal(baseline.entitlements, 0);
        assert.equal(baseline.claims, 0);
        assert.equal(baseline.intents, 0);
      },
      { oracleClass: "EXTERNAL" },
    );
  },
);

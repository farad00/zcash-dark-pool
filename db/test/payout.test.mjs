import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { psql } from "../test-fixtures.mjs";
import { migratePayoutPlanning } from "../payout-migrations.mjs";
import { provisionPayoutPlanningScript } from "../payout-provision.mjs";
import { authority } from "../../services/publication/test/fixtures.mjs";
import { claimFixture } from "./claim-fixtures.mjs";
import { id } from "./lock-fixtures.mjs";
import {
  planPayoutIntent,
  planInSession,
} from "../../services/payout/plan.mjs";
import {
  recordPayoutObservation,
  reportInSession,
} from "../../services/payout/reconcile.mjs";
import { openLockSession } from "../../services/lock/db-session.mjs";
const suffix = randomBytes(8).toString("hex"),
  password = randomBytes(32).toString("hex");
const roles = Object.fromEntries(
  [
    "lock",
    "publication",
    "oracle",
    "coordinator",
    "claim",
    "planner",
    "reconciler",
    "other",
  ].map((k) => [k, "darkpool_" + k + "_" + suffix]),
);
let issuer,
  addresses,
  createdRoles = false;
before(async () => {
  assert.equal(process.env.PGDATABASE, "postgres");
  issuer = await authority();
  addresses = JSON.parse(
    execFileSync(
      fileURLToPath(
        new URL(
          "../../target/debug/examples/phase14-claim-fixture.exe",
          import.meta.url,
        ),
      ),
      [],
      {
        env: {
          DARKPOOL_SYNTHETIC_TEST: "1",
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
        windowsHide: true,
        encoding: "utf8",
      },
    ),
  );
  await psql(
    "BEGIN;" +
      Object.values(roles)
        .map(
          (r) =>
            `CREATE ROLE "${r}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
        )
        .join("\n") +
      "COMMIT;",
    { database: "postgres" },
  );
  createdRoles = true;
});
after(async () => {
  try {
    if (createdRoles)
      await psql(
        Object.values(roles)
          .map((r) => `DROP ROLE "${r}";`)
          .join("\n"),
        { database: "postgres" },
      );
  } finally {
    await issuer?.close();
  }
});
const report = (
  kind = "SUBMISSION_UNCERTAIN",
  key = "report_1",
  transaction = id(700),
) => ({
  report_key: key,
  kind,
  transaction_id: transaction,
  artifact_ref: null,
  evidence_ref: "synthetic_observation",
});
const rejected = (p) =>
  assert.rejects(p, (e) => e.message === "PAYOUT_PLAN_REJECTED");
const rejectedReport = (p) =>
  assert.rejects(p, (e) => e.message === "PAYOUT_RECONCILIATION_REJECTED");
const counts = async (f) =>
  JSON.parse(
    await f.sql(
      "SELECT jsonb_build_object('intents',(SELECT count(*) FROM darkpool_private.payout_intents),'reports',(SELECT count(*) FROM darkpool_private.payout_reconciliation_reports),'transactions',(SELECT count(*) FROM darkpool_private.payout_reported_transactions));",
    ),
  );
const sourceSQL =
  "SELECT jsonb_build_object('claims',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM darkpool_private.claims c),'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY claim_id) FROM darkpool_private.claim_reservations r),'instructions',(SELECT jsonb_agg(to_jsonb(o) ORDER BY claim_id) FROM darkpool_private.claim_instruction_outbox o));";
async function isolated(work, options = {}) {
  await claimFixture(
    { roles, password, issuer, addresses },
    async (f) => {
      await migratePayoutPlanning(f.database);
      const configuration = {
        market_id: f.mid,
        execution_class: options.executionClass ?? "SYNTHETIC_TEST",
        external_funding_ref: "synthetic_external_subsidy",
        planning_fee_budget_zat: options.budget ?? "1000",
        per_intent_fee_ceiling_zat: "500",
      };
      await f.sql(
        provisionPayoutPlanningScript(
          roles.planner,
          roles.reconciler,
          configuration,
        ),
      );
      let reservation;
      if (!options.noReservation) {
        const q = options.ticket
          ? { ...f.request, ticket_id: id(options.ticket) }
          : f.request;
        reservation = await f.reserve(q);
        if (!options.reservedOnly) await f.prepare(q);
      }
      const beforeClaims = await f.sql(sourceSQL);
      const claimId =
        reservation?.reservation_id ??
        "claim:00000000-0000-4000-8000-000000000000";
      await work({
        ...f,
        claimId,
        configuration,
        plan: (cid = claimId, role = "planner") =>
          planPayoutIntent(cid, f.env(role)),
        observe: (q = report(), role = "reconciler", cid = claimId) =>
          recordPayoutObservation(cid, q, f.env(role)),
      });
      if (!options.claimsChange)
        assert.equal(
          await f.sql(sourceSQL),
          beforeClaims,
          "payout planning/reports cannot change the source claim",
        );
    },
    {
      corrupt: options.corrupt ?? false,
      pending: options.pending ?? false,
      missingResolution: options.missingResolution ?? false,
      outcome: options.outcome ?? "YES",
      count: options.count ?? 3,
    },
  );
}

test("0012 valid immutable private intent binds full prepared entitlement and native Orchard receiver", async () =>
  isolated(async (f) => {
    await migratePayoutPlanning(f.database);
    await f.sql(
      provisionPayoutPlanningScript(
        roles.planner,
        roles.reconciler,
        f.configuration,
      ),
    );
    const p = await f.plan();
    assert.equal(p.intent_id, "payout-intent:" + f.claimId);
    assert.equal(p.planning_state, "PLANNED");
    assert.equal(p.spending_authorized, false);
    assert.equal(p.submission_enabled, false);
    const stored = JSON.parse(
      await f.sql("SELECT record FROM darkpool_private.payout_intents;"),
    );
    assert.equal(stored.amount_zat, "2");
    assert.equal(stored.fee_ceiling_zat, "500");
    assert.equal(stored.ledger_root, f.locked.commitment.merkle_root);
    assert.equal(stored.payout_ua, addresses[4]);
    assert.equal(stored.fee_mode, "EXTERNALLY_SUBSIDIZED");
    assert.equal(stored.execution_class, "SYNTHETIC_TEST");
    assert.equal(
      await f.sql("SELECT count(*) FROM darkpool_private.settlements;"),
      "0",
    );
    assert.equal(
      await f.sql(
        "SELECT funding_verified FROM darkpool_private.payout_planner_scopes;",
      ),
      "f",
    );
  }));
test("duplicate and concurrent planning reserves one intent and one fee ceiling", async () =>
  isolated(async (f) => {
    const raced = await Promise.allSettled([f.plan(), f.plan()]);
    assert.ok(raced.some((r) => r.status === "fulfilled"));
    const p = raced.find((r) => r.status === "fulfilled").value;
    assert.deepEqual(await f.plan(), p);
    assert.equal((await counts(f)).intents, 1);
    assert.equal(
      await f.sql(
        "SELECT sum(fee_ceiling_zat)::text FROM darkpool_private.payout_intents;",
      ),
      "500",
    );
  }));
test("reserved-only, unknown and unbound public-request objects cannot plan", async () =>
  isolated(
    async (f) => {
      await rejected(f.plan());
      await rejected(f.plan("claim:00000000-0000-4000-8000-000000000000"));
      await rejected(
        f.plan({
          claim_id: f.claimId,
          payout_ua: addresses[5],
          amount_zat: "1",
        }),
      );
      assert.equal((await counts(f)).intents, 0);
    },
    { reservedOnly: true },
  ));
test("fee budget exhaustion cannot reduce entitlements or double-charge retries", async () =>
  isolated(
    async (f) => {
      const first = await f.plan();
      const q = {
        ...f.request,
        ticket_id: id(3),
        payout_ua: addresses[5],
        idempotency_key: "second_claim",
      };
      const second = await f.reserve(q);
      await f.prepare(q);
      await rejected(f.plan(second.reservation_id));
      assert.deepEqual(await f.plan(), first);
      assert.equal((await counts(f)).intents, 1);
      assert.equal(
        await f.sql(
          "SELECT sum(entitlement_zat)::text FROM darkpool_private.claims;",
        ),
        "3",
      );
    },
    { budget: "500", claimsChange: true },
  ));
test("insufficient initial fee budget rolls back planning", async () =>
  isolated(
    async (f) => {
      await rejected(f.plan());
      assert.equal((await counts(f)).intents, 0);
    },
    { budget: "499" },
  ));
test("VOID and no-winner refund instructions retain full entitlements", async () => {
  for (const outcome of ["VOID", "NO"]) {
    await isolated(
      async (f) => {
        await f.plan();
        const p = JSON.parse(
          await f.sql("SELECT record FROM darkpool_private.payout_intents;"),
        );
        assert.equal(p.entitlement_kind, "REFUND");
        assert.equal(p.amount_zat, "1");
        assert.equal(
          p.refund_reason,
          outcome === "VOID" ? "VOID" : "NO_WINNER_REFUND",
        );
      },
      { outcome, count: outcome === "NO" ? 1 : 3 },
    );
  }
});
test("NO winning entitlement uses the same immutable planner", async () =>
  isolated(
    async (f) => {
      await f.plan();
      assert.equal(
        await f.sql(
          "SELECT amount_zat::text FROM darkpool_private.payout_intents;",
        ),
        "3",
      );
    },
    { outcome: "NO", ticket: 2 },
  ));
test("missing publication or durable resolution cannot be replaced by a prepared request", async () => {
  for (const flag of ["pending", "missingResolution"])
    await isolated(
      async (f) => {
        await rejected(f.plan());
        assert.equal((await counts(f)).intents, 0);
      },
      { [flag]: true, noReservation: true },
    );
});
test("EXTERNAL planner policy cannot consume a synthetic authorized claim", async () =>
  isolated(
    async (f) => {
      await rejected(f.plan());
      assert.equal((await counts(f)).intents, 0);
    },
    { executionClass: "EXTERNAL" },
  ));
test("invalid native destination or receiver substitution fails closed", async () =>
  isolated(async (f) => {
    for (const ua of ["utest1malformed", addresses[5]]) {
      const s = await openLockSession(f.env("planner"));
      try {
        await rejected(
          planInSession(
            {
              query: async (q) => {
                const data = await s.query(q);
                if (q.startsWith("SELECT darkpool_payout.begin_plan"))
                  data.intent.payout_ua = ua;
                return data;
              },
            },
            f.claimId,
          ),
        );
      } finally {
        await s.close();
      }
    }
    assert.equal((await counts(f)).intents, 0);
  }));
test("root/outcome mutation, changed proposal and changed fee allocation cannot replace a bound intent", async () =>
  isolated(async (f) => {
    await f.plan();
    await assert.rejects(
      f.sql(
        "UPDATE darkpool_private.payout_planner_scopes SET per_intent_fee_ceiling_zat=1;",
      ),
    );
    await assert.rejects(f.sql("DELETE FROM darkpool_private.payout_intents;"));
    await assert.rejects(
      f.sql("TRUNCATE darkpool_private.payout_intents CASCADE;"),
    );
    const original = await f.sql(
      "SELECT encode(convert_to(record::text,'UTF8'),'hex') FROM darkpool_private.payout_intents;",
    );
    for (const [field, value] of [
      ["ledger_root", "ff".repeat(32)],
      ["outcome", "NO"],
      ["resolution_ref", "changed_resolution"],
    ]) {
      const s = await openLockSession(f.env("planner"));
      try {
        await rejected(
          planInSession(
            {
              query: async (q) => {
                const data = await s.query(q);
                if (q.startsWith("SELECT darkpool_payout.begin_plan")) {
                  data.intent[field] = value;
                  data.existing = data.intent;
                }
                return data;
              },
            },
            f.claimId,
          ),
        );
      } finally {
        await s.close();
      }
    }
    assert.equal(
      await f.sql(
        "SELECT encode(convert_to(record::text,'UTF8'),'hex') FROM darkpool_private.payout_intents;",
      ),
      original,
    );
  }));
test("a changed retained receipt or unauthorized resolution class cannot pass authoritative planning", async () => {
  await isolated(
    async (f) => {
      await f.sql(`ALTER TABLE darkpool_private.ledger_publication_receipts DISABLE TRIGGER lock_receipts_immutable;
      UPDATE darkpool_private.ledger_publication_receipts SET verified_by='${roles.other}';
      ALTER TABLE darkpool_private.ledger_publication_receipts ENABLE TRIGGER lock_receipts_immutable;`);
      await rejected(f.plan());
      assert.equal((await counts(f)).intents, 0);
    },
    { corrupt: true },
  );
  await isolated(
    async (f) => {
      await f.sql(
        "ALTER TABLE darkpool_private.resolution_results DISABLE TRIGGER resolution_immutable; UPDATE darkpool_private.resolution_results SET execution_class='EXTERNAL'; ALTER TABLE darkpool_private.resolution_results ENABLE TRIGGER resolution_immutable;",
      );
      await rejected(f.plan());
      assert.equal((await counts(f)).intents, 0);
    },
    { corrupt: true },
  );
});
test("failure after intent INSERT rolls back the planning fee obligation", async () =>
  isolated(async (f) => {
    await f.sql(
      "CREATE FUNCTION darkpool_private.fail_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail AFTER INSERT ON darkpool_private.payout_intents FOR EACH ROW EXECUTE FUNCTION darkpool_private.fail_intent();",
    );
    await rejected(f.plan());
    assert.equal((await counts(f)).intents, 0);
    await f.sql(
      "DROP TRIGGER synthetic_fail ON darkpool_private.payout_intents;",
    );
    await f.plan();
  }));
test("lost plan COMMIT acknowledgement recovers exactly one immutable identity", async () =>
  isolated(async (f) => {
    const s = await openLockSession(f.env("planner"));
    try {
      await rejected(
        planInSession(
          {
            query: async (q) => {
              const data = await s.query(q);
              if (q.startsWith("COMMIT;"))
                throw new Error("synthetic lost ack");
              return data;
            },
          },
          f.claimId,
        ),
      );
    } finally {
      await s.close();
    }
    assert.equal((await f.plan()).intent_id, "payout-intent:" + f.claimId);
    assert.equal((await counts(f)).intents, 1);
  }));
test("constructed, accepted and ambiguous submissions remain quarantined with original identity", async () =>
  isolated(async (f) => {
    const p = await f.plan();
    for (const [n, kind] of [
      "CONSTRUCTION_REPORTED",
      "SUBMISSION_ACCEPTED_REPORTED",
      "SUBMISSION_UNCERTAIN",
      "PROCESS_INTERRUPTED",
    ].entries()) {
      const r = await f.observe(report(kind, "report_" + n));
      assert.equal(r.planning_state, "RECONCILIATION_REQUIRED");
      assert.equal(r.replacement_authorized, false);
      assert.equal(r.submission_enabled, false);
    }
    const retried = await f.plan();
    assert.equal(retried.intent_id, p.intent_id);
    assert.equal(retried.planning_state, "RECONCILIATION_REQUIRED");
    assert.deepEqual(await counts(f), {
      intents: 1,
      reports: 4,
      transactions: 1,
    });
  }));
test("inclusion, reorg and spend conflict reports never confirm or release a claim", async () =>
  isolated(async (f) => {
    await f.plan();
    for (const [n, kind] of [
      "INCLUSION_REPORTED",
      "REORG_REPORTED",
      "SPEND_CONFLICT_REPORTED",
    ].entries()) {
      const r = await f.observe(report(kind, "chain_" + n));
      assert.equal(r.confirmation_authorized, false);
      assert.equal(r.replacement_authorized, false);
    }
    assert.equal(
      await f.sql("SELECT state FROM darkpool_private.claims;"),
      "TX_PREPARING",
    );
    assert.equal(
      await f.sql(
        "SELECT count(*) FROM darkpool_private.claims WHERE tx_ref IS NOT NULL OR settlement_id IS NOT NULL;",
      ),
      "0",
    );
  }));
test("report retries are durable and contradictory observations or replacement txids reject", async () =>
  isolated(async (f) => {
    await f.plan();
    const q = report();
    const r = await f.observe(q);
    assert.deepEqual(await f.observe(q), r);
    await rejectedReport(
      f.observe({ ...q, kind: "SUBMISSION_ACCEPTED_REPORTED" }),
    );
    await rejectedReport(
      f.observe({ ...q, report_key: "replacement", transaction_id: id(701) }),
    );
    assert.deepEqual(await counts(f), {
      intents: 1,
      reports: 1,
      transactions: 1,
    });
  }));
test("unknown transaction after interruption still blocks replacement, and report rollback is atomic", async () =>
  isolated(async (f) => {
    await f.plan();
    await f.sql(
      "CREATE FUNCTION darkpool_private.fail_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON darkpool_private.payout_reconciliation_reports FOR EACH ROW EXECUTE FUNCTION darkpool_private.fail_report();",
    );
    await rejectedReport(f.observe());
    assert.deepEqual(await counts(f), {
      intents: 1,
      reports: 0,
      transactions: 0,
    });
    await f.sql(
      "DROP TRIGGER synthetic_fail ON darkpool_private.payout_reconciliation_reports;",
    );
    const r = await f.observe(report("PROCESS_INTERRUPTED", "unknown", null));
    assert.equal(r.replacement_authorized, false);
    assert.deepEqual(await counts(f), {
      intents: 1,
      reports: 1,
      transactions: 0,
    });
  }));
test("lost reconciliation COMMIT acknowledgement and concurrent reports remain idempotent", async () =>
  isolated(async (f) => {
    await f.plan();
    const q = report();
    const s = await openLockSession(f.env("reconciler"));
    try {
      await rejectedReport(
        reportInSession(
          {
            query: async (statement) => {
              const data = await s.query(statement);
              if (statement.startsWith("COMMIT;"))
                throw new Error("synthetic lost ack");
              return data;
            },
          },
          f.claimId,
          q,
        ),
      );
    } finally {
      await s.close();
    }
    const r = await f.observe(q);
    const raced = await Promise.allSettled([f.observe(q), f.observe(q)]);
    assert.ok(raced.some((v) => v.status === "fulfilled"));
    assert.deepEqual(await f.observe(q), r);
    assert.deepEqual(await counts(f), {
      intents: 1,
      reports: 1,
      transactions: 1,
    });
  }));
test("safety hold blocks new planning but permits cautionary reconciliation", async () =>
  isolated(
    async (f) => {
      await f.plan();
      await f.sql(`BEGIN;INSERT INTO darkpool_private.watcher_evidence VALUES('payout-hold','${f.mid}','HOLD',NULL,NULL,NULL,NULL,'{}',now());
   UPDATE darkpool_private.watcher_state SET revision=revision+1,hold_ref='payout-hold' WHERE market_id='${f.mid}';
   UPDATE darkpool_private.markets SET status='PAUSED' WHERE id='${f.mid}';COMMIT;`);
      await rejected(f.plan());
      assert.equal(
        (await f.observe(report("REORG_REPORTED"))).planning_state,
        "RECONCILIATION_REQUIRED",
      );
    },
    { corrupt: true },
  ));
test("privileges, public projection and errors expose no private payout material", async () =>
  isolated(async (f) => {
    await rejected(f.plan(f.claimId, "other"));
    await rejected(f.plan(f.claimId, "claim"));
    await rejected(f.plan(f.claimId, "reconciler"));
    const p = await f.plan();
    await rejectedReport(f.observe(report(), "planner"));
    assert.deepEqual(
      Object.keys(p).sort(),
      [
        "result",
        "intent_id",
        "planning_state",
        "execution_class",
        "spending_authorized",
        "submission_enabled",
      ].sort(),
    );
    const r = await f.observe();
    assert.equal(JSON.stringify(r).includes(id(700)), false);
    for (const role of ["planner", "reconciler", "other"]) {
      await assert.rejects(
        f.query("SELECT record FROM darkpool_private.payout_intents;", role),
      );
      await assert.rejects(
        f.query("SELECT darkpool_lock.snapshot('phase11-synthetic');", role),
      );
    }
    await assert.rejects(
      f.sql(
        "UPDATE darkpool_private.payout_reconciliation_reports SET report='{}';",
      ),
    );
  }));

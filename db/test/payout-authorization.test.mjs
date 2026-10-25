import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { psql } from "../test-fixtures.mjs";
import { migratePayoutAuthorization } from "../payout-authorization-migrations.mjs";
import { provisionPayoutPlanningScript } from "../payout-provision.mjs";
import { provisionPayoutReviewScript } from "../payout-authorization-provision.mjs";
import { authority } from "../../services/publication/test/fixtures.mjs";
import { claimFixture } from "./claim-fixtures.mjs";
import { planPayoutIntent } from "../../services/payout/plan.mjs";
import { recordPayoutObservation } from "../../services/payout/reconcile.mjs";
import {
  previewPayoutAuthorization,
  requestPayoutAuthorizationReview,
  requestReviewInSession,
  inspectReviewPacket,
} from "../../services/payout-authorization/review.mjs";
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
    "operator",
    "other",
  ].map((k) => [k, "darkpool_" + k + "_" + suffix]),
);
let issuer,
  addresses,
  created = false;
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
  created = true;
});
after(async () => {
  try {
    if (created)
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
const rejected = (p) =>
  assert.rejects(p, (e) => e.message === "PAYOUT_REVIEW_REJECTED");
const clone = (o) => structuredClone(o);
const economicSource =
  "SELECT jsonb_build_object('claims',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM darkpool_private.claims c),'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY claim_id) FROM darkpool_private.claim_reservations r),'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY intent_id) FROM darkpool_private.payout_intents i),'scope',(SELECT jsonb_agg(to_jsonb(s)) FROM darkpool_private.payout_planner_scopes s));";
const requestCount = (f) =>
  f.sql("SELECT count(*) FROM darkpool_private.payout_operator_requests;");
async function isolated(work, options = {}) {
  await claimFixture(
    { roles, password, issuer, addresses },
    async (f) => {
      await migratePayoutAuthorization(f.database);
      await f.sql(
        provisionPayoutPlanningScript(roles.planner, roles.reconciler, {
          market_id: f.mid,
          execution_class: "SYNTHETIC_TEST",
          external_funding_ref: "synthetic_external_reserve",
          planning_fee_budget_zat: "1000",
          per_intent_fee_ceiling_zat: "500",
        }),
      );
      const claim = await f.reserve();
      await f.prepare();
      const intent = await planPayoutIntent(
        claim.reservation_id,
        f.env("planner"),
      );
      await f.sql(
        provisionPayoutReviewScript(
          roles.operator,
          f.mid,
          options.executionClass ?? "SYNTHETIC_TEST",
        ),
      );
      const source = await f.sql(economicSource);
      await work({
        ...f,
        claimId: claim.reservation_id,
        intentId: intent.intent_id,
        preview: (role = "operator") =>
          previewPayoutAuthorization(intent.intent_id, f.env(role)),
        request: (q, role = "operator") =>
          requestPayoutAuthorizationReview(q, f.env(role)),
      });
      assert.equal(
        await f.sql(economicSource),
        source,
        "review requests cannot authorize or mutate economic records",
      );
    },
    { corrupt: options.corrupt ?? false },
  );
}
const request = (f, packet) => ({
  intent_id: f.intentId,
  request_key: "synthetic_review_1",
  expected_packet: packet,
});
test("0013 authenticated explicit single-intent request remains blocked, with no verified reserve or signer", async () =>
  isolated(async (f) => {
    await migratePayoutAuthorization(f.database);
    await f.sql(
      provisionPayoutReviewScript(roles.operator, f.mid, "SYNTHETIC_TEST"),
    );
    const packet = await f.preview();
    const assessed = await inspectReviewPacket(packet);
    assert.equal(packet.declared_market_payout_confirmations, null);
    assert.equal(packet.policy.proposed_confirmations, 3);
    assert.equal(assessed.market_finality_matches_proposal, false);
    assert.ok(
      Object.values(assessed.dependencies).every((v) => v === "UNAVAILABLE"),
    );
    const result = await f.request(request(f, packet));
    assert.equal(result.state, "BLOCKED_PREREQUISITES");
    assert.equal(result.spending_authorized, false);
    assert.equal(result.signing_enabled, false);
    assert.equal(result.submission_enabled, false);
    assert.equal(await requestCount(f), "1");
    assert.equal(
      await f.sql(
        "SELECT requested_by::text FROM darkpool_private.payout_operator_requests;",
      ),
      roles.operator,
    );
    assert.equal(
      await f.sql(
        "SELECT funding_verified FROM darkpool_private.payout_planner_scopes;",
      ),
      "f",
    );
  }));
test("same request retries and concurrent sessions return one immutable review", async () =>
  isolated(async (f) => {
    const q = request(f, await f.preview());
    const raced = await Promise.allSettled([f.request(q), f.request(q)]);
    assert.ok(raced.some((r) => r.status === "fulfilled"));
    const result = raced.find((r) => r.status === "fulfilled").value;
    assert.deepEqual(await f.request(q), result);
    assert.equal(await requestCount(f), "1");
    await rejected(f.request({ ...q, request_key: "different_review" }));
  }));
test("changed root/outcome/amount/fee/destination or caller actor cannot substitute the reviewed packet", async () =>
  isolated(async (f) => {
    const original = await f.preview();
    for (const [field, value] of [
      ["ledger_root", "ff".repeat(32)],
      ["outcome", "NO"],
      ["amount_zat", "1"],
      ["fee_ceiling_zat", "1"],
      ["payout_ua", addresses[5]],
    ]) {
      const changed = clone(original);
      changed.intent[field] = value;
      await rejected(f.request(request(f, changed)));
    }
    await rejected(
      f.request({ ...request(f, original), actor: roles.operator }),
    );
    await rejected(f.request({ ...request(f, original), fee_verified: true }));
    assert.equal(await requestCount(f), "0");
  }));
test("provisional threshold and configuration cannot activate or backfill a market policy", async () =>
  isolated(async (f) => {
    const packet = await f.preview();
    for (const patch of [
      { network: "mainnet" },
      { proposed_confirmations: 1 },
      { signing_enabled: true },
      { submission_enabled: true },
      { replacement_enabled: true },
    ]) {
      const changed = clone(packet);
      Object.assign(changed.policy, patch);
      await rejected(f.request(request(f, changed)));
    }
    const forged = clone(packet);
    forged.declared_market_payout_confirmations = 3;
    const check = await inspectReviewPacket(forged);
    assert.equal(check.market_finality_matches_proposal, true);
    assert.equal(check.spending_authorized, false);
    await rejected(f.request(request(f, forged)));
    assert.equal(
      await f.sql(
        "SELECT payout_confirmations IS NULL FROM darkpool_private.markets;",
      ),
      "t",
    );
  }));
test("EXTERNAL review scope cannot reinterpret synthetic receipts or claims", async () =>
  isolated(
    async (f) => {
      await rejected(f.preview());
      assert.equal(await requestCount(f), "0");
    },
    { executionClass: "EXTERNAL" },
  ));
test("missing valid publication or mismatched durable resolution prevents operator request", async () => {
  await isolated(
    async (f) => {
      await f.sql(`ALTER TABLE darkpool_private.ledger_publication_receipts DISABLE TRIGGER lock_receipts_immutable;
      UPDATE darkpool_private.ledger_publication_receipts SET verified_by='${roles.other}';
      ALTER TABLE darkpool_private.ledger_publication_receipts ENABLE TRIGGER lock_receipts_immutable;`);
      await rejected(f.preview());
      assert.equal(await requestCount(f), "0");
    },
    { corrupt: true },
  );
  await isolated(
    async (f) => {
      await f.sql(
        "ALTER TABLE darkpool_private.resolution_results DISABLE TRIGGER resolution_immutable; UPDATE darkpool_private.resolution_results SET execution_class='EXTERNAL'; ALTER TABLE darkpool_private.resolution_results ENABLE TRIGGER resolution_immutable;",
      );
      await rejected(f.preview());
      assert.equal(await requestCount(f), "0");
    },
    { corrupt: true },
  );
});
test("quarantined intent cannot acquire an approval request or be reset", async () =>
  isolated(async (f) => {
    const packet = await f.preview();
    await recordPayoutObservation(
      f.claimId,
      {
        report_key: "synthetic_uncertain",
        kind: "SUBMISSION_UNCERTAIN",
        transaction_id: null,
        artifact_ref: null,
        evidence_ref: "synthetic_unknown",
      },
      f.env("reconciler"),
    );
    await rejected(f.preview());
    await rejected(f.request(request(f, packet)));
    assert.equal(await requestCount(f), "0");
  }));
test("safety hold blocks stale operator packets", async () =>
  isolated(
    async (f) => {
      const packet = await f.preview();
      await f.sql(`BEGIN;INSERT INTO darkpool_private.watcher_evidence VALUES('authorization-hold','${f.mid}','HOLD',NULL,NULL,NULL,NULL,'{}',now());
   UPDATE darkpool_private.watcher_state SET revision=revision+1,hold_ref='authorization-hold' WHERE market_id='${f.mid}';
   UPDATE darkpool_private.markets SET status='PAUSED' WHERE id='${f.mid}';COMMIT;`);
      await rejected(f.request(request(f, packet)));
      assert.equal(await requestCount(f), "0");
    },
    { corrupt: true },
  ));
test("write failure rolls back review; retry does not authorize a payout", async () =>
  isolated(async (f) => {
    const q = request(f, await f.preview());
    await f.sql(
      "CREATE FUNCTION darkpool_private.fail_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail AFTER INSERT ON darkpool_private.payout_operator_requests FOR EACH ROW EXECUTE FUNCTION darkpool_private.fail_review();",
    );
    await rejected(f.request(q));
    assert.equal(await requestCount(f), "0");
    await f.sql(
      "DROP TRIGGER synthetic_fail ON darkpool_private.payout_operator_requests;",
    );
    assert.equal((await f.request(q)).spending_authorized, false);
  }));
test("lost commit response recovers the same blocked request", async () =>
  isolated(async (f) => {
    const q = request(f, await f.preview());
    const s = await openLockSession(f.env("operator"));
    try {
      await rejected(
        requestReviewInSession(
          {
            query: async (statement) => {
              const data = await s.query(statement);
              if (statement.startsWith("COMMIT;"))
                throw new Error("synthetic ack loss");
              return data;
            },
          },
          q,
        ),
      );
    } finally {
      await s.close();
    }
    assert.equal((await f.request(q)).review_id, q.expected_packet.review_id);
    assert.equal(await requestCount(f), "1");
  }));
test("operator permissions, requests and public receipts cannot become signer or paid authority", async () =>
  isolated(async (f) => {
    for (const role of ["claim", "planner", "reconciler", "other"])
      await rejected(f.preview(role));
    const q = request(f, await f.preview());
    const result = await f.request(q);
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "result",
        "review_id",
        "state",
        "execution_class",
        "spending_authorized",
        "signing_enabled",
        "submission_enabled",
      ].sort(),
    );
    for (const sql of [
      "SELECT packet FROM darkpool_private.payout_operator_requests;",
      "SELECT darkpool_lock.snapshot('phase11-synthetic');",
      `SET ROLE "${roles.operator}"; SELECT darkpool_payout_review.preview('${f.intentId}');`,
    ])
      await assert.rejects(f.query(sql, "operator"));
    for (const sql of [
      "UPDATE darkpool_private.payout_operator_requests SET spending_authorized=true;",
      "DELETE FROM darkpool_private.payout_operator_requests;",
      "TRUNCATE darkpool_private.payout_operator_requests;",
      "UPDATE darkpool_private.payout_review_scopes SET spending_enabled=true;",
    ])
      await assert.rejects(f.sql(sql));
    assert.equal(
      await f.sql(
        "SELECT count(*) FROM darkpool_private.claims WHERE state='CONFIRMED' OR tx_ref IS NOT NULL OR settlement_id IS NOT NULL;",
      ),
      "0",
    );
  }));

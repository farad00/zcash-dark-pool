import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { psql } from "../test-fixtures.mjs";
import { migrateResolution } from "../resolution-migrations.mjs";
import {
  provisionResolutionScript,
  registerOracleScript,
} from "../resolution-provision.mjs";
import { provisionLockScript } from "../lock-provision.mjs";
import { provisionPublicationScript } from "../publication-provision.mjs";
import { fixture, resources, json } from "./lock-fixtures.mjs";
import { finalizeLock } from "../../services/lock/finalize.mts";
import { openLockSession } from "../../services/lock/db-session.mjs";
import { persistPublication } from "../../services/publication/persist.mjs";
import {
  authority,
  executable,
  syntheticRetrieval,
} from "../../services/publication/test/fixtures.mjs";
import { approveResolution } from "../../services/resolution/approve.mjs";
import {
  finalizeResolution,
  computeResolution,
} from "../../services/resolution/prepare.mjs";
import { begin } from "../../services/resolution/session.mjs";

const suffix = randomBytes(8).toString("hex"),
  password = randomBytes(32).toString("hex");
const roles = Object.fromEntries(
  ["lock", "publication", "oracle", "coordinator"].map((kind) => [
    kind,
    "darkpool_" + kind + "_" + suffix,
  ]),
);
let issuer,
  createdRoles = false;
before(async () => {
  assert.equal(process.env.PGDATABASE, "postgres");
  issuer = await authority();
  await psql(
    "BEGIN;\n" +
      Object.values(roles)
        .map(
          (role) =>
            `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
        )
        .join("\n") +
      "\nCOMMIT;",
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
const six = (date) => date.toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
const limits = {
  ...resources,
  max_tickets: resources.max_tickets.toString(),
  max_total_zat: ((1n << 128n) - 1n).toString(),
  max_numerator_zat_squared: ((1n << 256n) - 1n).toString(),
};
const frozen = `SELECT jsonb_build_object('ledger',(SELECT jsonb_agg(to_jsonb(r) ORDER BY ticket_id) FROM darkpool_private.ledger_records r),
 'commitment',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.ledger_commitments c),
 'locks',(SELECT jsonb_agg(to_jsonb(l)) FROM darkpool_private.lock_requests l),
 'watcher',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM darkpool_private.watcher_evidence e),
 'receipts',(SELECT jsonb_agg(to_jsonb(p)) FROM darkpool_private.ledger_publication_receipts p),
 'rules',(SELECT to_jsonb(m)-ARRAY['status','updated_at'] FROM darkpool_private.markets m));`;
async function isolated(work, options = {}) {
  const database = "darkpool_phase9_" + randomBytes(8).toString("hex");
  const sql = (q) => psql(q, { database });
  let created = false;
  try {
    await psql(
      `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
      { database: "postgres" },
    );
    created = true;
    await migrateResolution(database);
    await sql(provisionLockScript(roles.lock));
    await sql(
      provisionPublicationScript(roles.publication, database, issuer.trust),
    );
    await sql(provisionResolutionScript(roles.oracle, roles.coordinator));
    const f = fixture(Math.floor(Date.now() / 1000) + 5, options.count ?? 3);
    const observation = six(new Date(f.close * 1000));
    const rule = {
      question: "Synthetic Phase 11 question",
      yes_definition: "Yes",
      no_definition: "No",
      resolution_rule: `Observe synthetic-source at ${observation}; YES if gauge >= 10; NO if below 10; VOID if no defensible observation.`,
      resolution_sources: ["synthetic-source"],
      void_conditions: ["void"],
      rule_version: "synthetic_manual_rule_v1",
    };
    const registration = {
      market_id: f.mid,
      oracle_login: roles.oracle,
      coordinator_login: roles.coordinator,
      actor_ref: "synthetic_manual_operator",
      execution_class: options.execution_class ?? "SYNTHETIC_TEST",
      rule,
      observation_at: observation,
      resources: limits,
    };
    for (const output of f.request.outputs) output.amount_zat = "1";
    let setup =
      f.setup.slice(0, f.setup.indexOf("SELECT darkpool_watcher.reconcile")) +
      `SELECT darkpool_watcher.reconcile(0,${json(f.request)}); COMMIT;`;
    setup = setup
      .replace(
        "'Rule',ARRAY['synthetic-source']",
        `'${rule.resolution_rule}',ARRAY['synthetic-source']`,
      )
      .replaceAll(",1000,0,", ",1,0,")
      .replaceAll(",1000,decode", ",1,decode");
    if (!options.noAuthority)
      setup = setup.replace(
        "UPDATE markets SET status='OPEN';",
        registerOracleScript(registration) +
          "\nUPDATE markets SET status='OPEN';",
      );
    await sql(setup);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, f.close * 1000 - Date.now() + 10)),
    );
    const env = (kind) => ({
      ...process.env,
      PGDATABASE: database,
      PGUSER: roles[kind],
      PGPASSWORD: password,
      APP_ENV: "development",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
    });
    const lock = options.noLock
      ? null
      : await finalizeLock(f.lockRequest, resources, env("lock"));
    if (lock && !options.pending) {
      await new Promise((resolve) => setTimeout(resolve, 1010));
      const proof = await issuer.evidence(lock.commitment);
      await persistPublication(
        f.mid,
        proof,
        issuer.trust,
        executable,
        env("publication"),
        syntheticRetrieval(proof),
      );
    }
    const request = {
      request_key: "synthetic_oracle_request",
      market_id: f.mid,
      expected_revision: "2",
      expected_root: lock?.commitment.merkle_root ?? "00".repeat(32),
      resolution_id: "synthetic_resolution_v1",
      outcome: options.outcome ?? "YES",
      evidence: ["synthetic-source:objective-observation"],
      rule_version: rule.rule_version,
      review: {
        decision: options.decision ?? "DEFENSIBLE",
        source_ref: "synthetic-source",
        observation_at: observation,
        rationale:
          "Synthetic operator reviewed the declared observation and source hierarchy.",
      },
      authorize_entitlements: true,
    };
    const saved = JSON.parse(await sql(frozen));
    const context = {
      ...f,
      database,
      sql,
      env,
      lock,
      request,
      registration,
      approve: (q = request, kind = "oracle") =>
        approveResolution(q, env(kind)),
      resolve: (key = request.request_key, kind = "coordinator") =>
        finalizeResolution(key, env(kind)),
      query: async (statement, kind = "coordinator") => {
        const session = await openLockSession(env(kind));
        try {
          return await session.query(statement);
        } finally {
          await session.close();
        }
      },
    };
    await work(context);
    if (!options.corrupt)
      assert.deepEqual(
        JSON.parse(await sql(frozen)),
        saved,
        "frozen private evidence must remain unchanged",
      );
  } finally {
    if (created) {
      assert.match(database, /^darkpool_phase9_[a-f0-9]{16}$/);
      await psql(`DROP DATABASE "${database}";`, { database: "postgres" });
    }
  }
}
const state = async (f) =>
  JSON.parse(
    await f.sql(`SELECT jsonb_build_object('status',(SELECT status FROM darkpool_private.markets),
 'revision',(SELECT revision::text FROM darkpool_private.admin_revisions),'resolutions',(SELECT count(*) FROM darkpool_private.resolutions),
 'results',(SELECT count(*) FROM darkpool_private.resolution_results),'entitlements',(SELECT count(*) FROM darkpool_private.entitlements));`),
  );
const amounts = async (f) =>
  JSON.parse(
    await f.sql(
      "SELECT jsonb_agg(amount_zat::text ORDER BY ticket_id) FROM darkpool_private.entitlements;",
    ),
  );
const economicMode = (f) =>
  f.sql(
    "SELECT preparation#>>'{calculation,mode}' FROM darkpool_private.resolution_results;",
  );
async function unmodified(f) {
  assert.deepEqual(await state(f), {
    status: "LOCKED",
    revision: "2",
    resolutions: 0,
    results: 0,
    entitlements: 0,
  });
}

test("0010 YES: real PostgreSQL atomic economic authorization, canonical tied rounding and immutable seal", async () =>
  isolated(async (f) => {
    await migrateResolution(f.database);
    await f.sql(provisionResolutionScript(roles.oracle, roles.coordinator));
    await f.approve();
    const result = await f.resolve();
    assert.equal(result.recorded_state, "PAYING");
    assert.equal(result.execution_class, "SYNTHETIC_TEST");
    assert.equal(result.spending_authorized, false);
    assert.deepEqual(await amounts(f), ["2", "0", "1"]);
    assert.deepEqual(await state(f), {
      status: "PAYING",
      revision: "3",
      resolutions: 1,
      results: 1,
      entitlements: 3,
    });
    assert.equal(
      await f.sql(
        "SELECT count(*) FROM darkpool_private.audit_events WHERE id LIKE 'resolution:%';",
      ),
      "2",
    );
  }));
test("NO: exact winner allocation and zero losing entitlements", async () =>
  isolated(
    async (f) => {
      await f.approve();
      await f.resolve();
      assert.deepEqual(await amounts(f), ["0", "3", "0"]);
    },
    { outcome: "NO" },
  ));
test("VOID: audited LOCKED->VOID->REFUNDING and full accepted-stake refunds", async () =>
  isolated(
    async (f) => {
      await f.approve();
      const r = await f.resolve();
      assert.equal(r.recorded_state, "REFUNDING");
      assert.equal(await economicMode(f), "VOID_REFUND");
      assert.deepEqual(await amounts(f), ["1", "1", "1"]);
    },
    { outcome: "VOID", decision: "AMBIGUOUS" },
  ));
test("no winning tickets: NO_WINNER_REFUND with no haircut or new lifecycle edge", async () =>
  isolated(
    async (f) => {
      await f.approve();
      const r = await f.resolve();
      assert.equal(await economicMode(f), "NO_WINNER_REFUND");
      assert.equal(r.recorded_state, "PAYING");
      assert.deepEqual(await amounts(f), ["1"]);
    },
    { outcome: "NO", count: 1 },
  ));
test("pending publication and missing valid lock cannot authorize resolution", async () => {
  await isolated(
    async (f) => {
      await assert.rejects(f.approve());
      await unmodified(f);
    },
    { pending: true },
  );
  await isolated(
    async (f) => {
      await assert.rejects(f.approve());
      assert.equal((await state(f)).status, "OPEN");
    },
    { noLock: true },
  );
});
test("EXTERNAL authority rejects matching synthetic receipt: production lifecycle UNVERIFIED", async () =>
  isolated(
    async (f) => {
      await assert.rejects(f.approve(), (e) => e.sqlstate === "P1105");
      await unmodified(f);
    },
    { execution_class: "EXTERNAL" },
  ));
test("missing pre-OPEN authority cannot be backfilled on a locked market", async () =>
  isolated(
    async (f) => {
      await assert.rejects(f.approve());
      await assert.rejects(f.sql(registerOracleScript(f.registration)));
      await unmodified(f);
    },
    { noAuthority: true },
  ));
test("oracle and coordinator capabilities cannot impersonate each other or read private tables", async () =>
  isolated(async (f) => {
    await assert.rejects(f.approve(f.request, "coordinator"));
    await f.approve();
    await assert.rejects(f.resolve(f.request.request_key, "oracle"));
    await assert.rejects(
      f.query(
        "SELECT row_to_json(r) FROM darkpool_private.ledger_records r;",
        "oracle",
      ),
    );
    await assert.rejects(
      f.query(
        "SELECT row_to_json(r) FROM darkpool_private.oracle_approvals r;",
      ),
    );
    await assert.rejects(f.approve(f.request, "publication"));
    await unmodified(f);
  }));
test("source, observation, ambiguous YES, missing evidence and caller identity cannot forge manual review", async () =>
  isolated(async (f) => {
    for (const changes of [
      { evidence: [] },
      { review: { ...f.request.review, source_ref: "not-declared" } },
      {
        review: {
          ...f.request.review,
          observation_at: "2000-01-01T00:00:00.000000Z",
        },
      },
      { review: { ...f.request.review, decision: "AMBIGUOUS" } },
      { actor: "forged" },
      { authorize_entitlements: false },
    ])
      await assert.rejects(f.approve({ ...f.request, ...changes }));
    await unmodified(f);
  }));
test("stale revision and wrong root rejected before storing approvals", async () =>
  isolated(async (f) => {
    await assert.rejects(f.approve({ ...f.request, expected_revision: "1" }));
    await assert.rejects(
      f.approve({ ...f.request, expected_root: "ff".repeat(32) }),
    );
    await unmodified(f);
  }));
test("conflicting outcome, evidence, root and retry identities cannot replace approval or resolution", async () =>
  isolated(async (f) => {
    const first = await f.approve();
    for (const change of [
      { outcome: "NO" },
      { evidence: ["synthetic-source:changed"] },
      { expected_root: "ee".repeat(32) },
      { request_key: "different_key" },
      { resolution_id: "different_resolution" },
    ])
      await assert.rejects(f.approve({ ...f.request, ...change }));
    const result = await f.resolve();
    assert.deepEqual(await f.approve(), first);
    assert.deepEqual(await f.resolve(), result);
    assert.equal((await state(f)).entitlements, 3);
  }));
test("concurrent identical approval and finalization converge without duplicate entitlements", async () =>
  isolated(async (f) => {
    const approved = await Promise.allSettled([f.approve(), f.approve()]);
    assert.ok(approved.some((r) => r.status === "fulfilled"));
    await f.approve();
    const resolved = await Promise.allSettled([f.resolve(), f.resolve()]);
    assert.ok(resolved.some((r) => r.status === "fulfilled"));
    const first = resolved.find((r) => r.status === "fulfilled").value;
    assert.deepEqual(await f.resolve(), first);
    assert.equal((await state(f)).entitlements, 3);
  }));
test("safety hold prevents approval and authorization without rewriting the seal", async () =>
  isolated(
    async (f) => {
      await f.approve();
      await f.sql(
        `BEGIN; INSERT INTO darkpool_private.watcher_evidence VALUES('synthetic-review-required','${f.mid}','HOLD',NULL,NULL,NULL,NULL,'{}',now());
         UPDATE darkpool_private.watcher_state SET revision=revision+1,hold_ref='synthetic-review-required' WHERE market_id='${f.mid}'; COMMIT;`,
      );
      await assert.rejects(f.resolve());
      await assert.rejects(f.approve());
      await unmodified(f);
    },
    { corrupt: true },
  ));
test("failure after resolution INSERT rolls back results, entitlements, state, revision and audit", async () =>
  isolated(async (f) => {
    await f.approve();
    await f.sql(`CREATE FUNCTION darkpool_private.synthetic_resolution_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1299',MESSAGE='synthetic failure'; END $$;
   CREATE TRIGGER synthetic_fail BEFORE INSERT ON darkpool_private.entitlements FOR EACH ROW EXECUTE FUNCTION darkpool_private.synthetic_resolution_fail();`);
    await assert.rejects(f.resolve());
    await unmodified(f);
    await f.sql(
      "DROP TRIGGER synthetic_fail ON darkpool_private.entitlements;",
    );
    await f.resolve();
  }));
test("lost pre-COMMIT execution / explicit transaction rollback creates no partial authorization", async () =>
  isolated(async (f) => {
    await f.approve();
    const session = await openLockSession(f.env("coordinator"));
    try {
      await session.query(begin);
      const d = await session.query(
        `SELECT darkpool_resolution.begin_resolution('${f.request.request_key}');`,
      );
      await session.query(
        `SELECT darkpool_resolution.finish_resolution('${f.request.request_key}',${json(computeResolution(d))});`,
      );
      await assert.rejects(session.query("SELECT 1/0;"));
    } finally {
      await session.close();
    }
    await unmodified(f);
    await f.resolve();
  }));
test("bound results and entitlements cannot be changed, released, duplicated or followed by unauthorized state rewrites", async () =>
  isolated(async (f) => {
    await f.approve();
    await f.resolve();
    for (const statement of [
      "UPDATE darkpool_private.entitlements SET amount_zat=1;",
      "DELETE FROM darkpool_private.resolutions;",
      "UPDATE darkpool_private.resolution_results SET preparation='{}'::jsonb;",
      "TRUNCATE darkpool_private.resolution_results CASCADE;",
      "INSERT INTO darkpool_private.entitlements SELECT 'duplicate',market_id,ticket_id,kind,liability_id,policy_ref,amount_zat FROM darkpool_private.entitlements LIMIT 1;",
      "UPDATE darkpool_private.markets SET status='LOCKED';",
      "UPDATE darkpool_private.markets SET status='VOID';",
      "UPDATE darkpool_private.markets SET status='CLOSED';",
    ])
      await assert.rejects(f.sql(statement));
    assert.equal((await state(f)).entitlements, 3);
  }));
test("PAYING/REFUNDING and direct resolutions require an authorized bound transaction", async () =>
  isolated(async (f) => {
    for (const status of ["RESOLVED", "PAYING", "REFUNDING", "VOID"])
      await assert.rejects(
        f.sql(`UPDATE darkpool_private.markets SET status='${status}';`),
      );
    await assert.rejects(
      f.sql(
        `INSERT INTO darkpool_private.resolutions VALUES('forged','${f.mid}',1,'YES',ARRAY['fake'],'fake','fake',now());`,
      ),
    );
    await unmodified(f);
  }));
test("root verification rejects lost/changed blindings even for authenticated approval", async () =>
  isolated(
    async (f) => {
      await f.approve();
      await f.sql(
        "ALTER TABLE darkpool_private.ledger_records DISABLE TRIGGER ledger_membership; UPDATE darkpool_private.ledger_records SET record_blinding=NULL WHERE ticket_id=(SELECT min(ticket_id) FROM darkpool_private.ledger_records); ALTER TABLE darkpool_private.ledger_records ENABLE TRIGGER ledger_membership;",
      );
      await assert.rejects(f.resolve(), /RESOLUTION_REJECTED/);
      await f.sql(
        "ALTER TABLE darkpool_private.ledger_records DISABLE TRIGGER ledger_membership; UPDATE darkpool_private.ledger_records SET record_blinding=decode(repeat('ff',32),'hex') WHERE ticket_id=(SELECT min(ticket_id) FROM darkpool_private.ledger_records); ALTER TABLE darkpool_private.ledger_records ENABLE TRIGGER ledger_membership;",
      );
      await assert.rejects(f.resolve(), /RESOLUTION_REJECTED/);
      await unmodified(f);
    },
    { corrupt: true },
  ));
test("mismatched retained publication root cannot authorize oracle approval", async () =>
  isolated(
    async (f) => {
      await f.sql(
        "ALTER TABLE darkpool_private.ledger_publication_receipts DISABLE TRIGGER lock_receipts_immutable; UPDATE darkpool_private.ledger_publication_receipts SET merkle_root=decode(repeat('cc',32),'hex'); ALTER TABLE darkpool_private.ledger_publication_receipts ENABLE TRIGGER lock_receipts_immutable;",
      );
      await assert.rejects(f.approve(), (e) => e.sqlstate === "P1105");
      await unmodified(f);
    },
    { corrupt: true },
  ));
test("TEST scope is not a switch: immutable physical binding and role/GUC restrictions", async () =>
  isolated(async (f) => {
    await assert.rejects(
      f.sql(
        "UPDATE darkpool_private.oracle_authorities SET execution_class='EXTERNAL';",
      ),
    );
    await assert.rejects(
      f.query(
        `SET ROLE "${roles.oracle}"; SELECT darkpool_resolution.approve(${json(f.request)});`,
        "oracle",
      ),
    );
    await assert.rejects(
      f.query(
        "SET darkpool_resolution.context='{}'; SELECT darkpool_resolution.finish_resolution('synthetic_oracle_request','{}');",
      ),
    );
    await unmodified(f);
  }));
test("public result and errors redact private preparation, credentials and participant data", async () =>
  isolated(async (f) => {
    await f.approve();
    const r = await f.resolve();
    assert.deepEqual(
      Object.keys(r).sort(),
      [
        "result",
        "market_id",
        "resolution_id",
        "merkle_root",
        "outcome",
        "recorded_state",
        "revision",
        "execution_class",
        "spending_authorized",
      ].sort(),
    );
    const output = JSON.stringify(r);
    for (const key of [
      "record_blinding",
      "accepted_amount_zat",
      "entitlements",
      "claim_secret",
      "receiver_ref",
      "rationale",
      "oracle_login",
    ])
      assert.equal(output.includes('"' + key + '"'), false);
  }));
test("empty accepted ledger authorizes no invented outputs or automatic closure", async () =>
  isolated(
    async (f) => {
      await f.approve();
      const r = await f.resolve();
      assert.equal(await economicMode(f), "EMPTY");
      assert.equal((await state(f)).entitlements, 0);
      assert.equal(r.recorded_state, "PAYING");
    },
    { count: 0 },
  ));
test("concurrent contradictory reviews cannot create two durable decisions", async () =>
  isolated(async (f) => {
    const other = {
      ...f.request,
      request_key: "contradictory_review",
      resolution_id: "contradictory_resolution",
      outcome: "NO",
    };
    const replies = await Promise.allSettled([f.approve(), f.approve(other)]);
    assert.equal(replies.filter((r) => r.status === "fulfilled").length, 1);
    const key =
      replies[0].status === "fulfilled"
        ? f.request.request_key
        : other.request_key;
    await f.resolve(key);
    assert.equal((await state(f)).resolutions, 1);
    assert.equal((await state(f)).entitlements, 3);
  }));
test("a copied TEST authority with another database identity fails closed", async () =>
  isolated(
    async (f) => {
      await f.sql(
        "ALTER TABLE darkpool_private.oracle_authorities DISABLE TRIGGER resolution_immutable; UPDATE darkpool_private.oracle_authorities SET database_oid=0; ALTER TABLE darkpool_private.oracle_authorities ENABLE TRIGGER resolution_immutable;",
      );
      await assert.rejects(f.approve());
      await unmodified(f);
    },
    { corrupt: true },
  ));

import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { psql } from "../test-fixtures.mjs";
import { migratePhase11 } from "../phase11-migrations.mjs";
import { provisionLockScript } from "../lock-provision.mjs";
import {
  finalizeLock,
  finalizeInSession,
} from "../../services/lock/finalize.mts";
import { openLockSession } from "../../services/lock/db-session.mjs";
import { fixture, json, resources, id } from "./lock-fixtures.mjs";

const suffix = randomBytes(8).toString("hex"),
  role = "darkpool_lock_" + suffix,
  password = randomBytes(32).toString("hex");
let roleCreated = false;
before(async () => {
  assert.equal(process.env.PGDATABASE, "postgres");
  await psql(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    { database: "postgres" },
  );
  roleCreated = true;
});
after(async () => {
  if (roleCreated) await psql(`DROP ROLE "${role}";`, { database: "postgres" });
});
async function isolated(work, options = {}) {
  // Existing TEST allowlist accepts this namespace. This is a NEW random fixture,
  // never a retained Phase 9 database, LIVE instance or V2 environment.
  const database = "darkpool_phase9_" + randomBytes(8).toString("hex");
  let created = false;
  try {
    await psql(
      `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
      { database: "postgres" },
    );
    created = true;
    await migratePhase11(database);
    await psql(provisionLockScript(role), { database });
    const f = fixture(options.close, options.count, options.tip);
    if (options.modifyRequest) {
      options.modifyRequest(f.request);
      f.setup =
        f.setup.slice(0, f.setup.indexOf("SELECT darkpool_watcher.reconcile")) +
        `SELECT darkpool_watcher.reconcile(0,${json(f.request)}); COMMIT;`;
    }
    await psql(f.setup, { database });
    if (options.close === undefined)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, f.close * 1000 - Date.now() + 10)),
      );
    const env = {
      ...process.env,
      PGDATABASE: database,
      PGUSER: role,
      PGPASSWORD: password,
      APP_ENV: "development",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
    };
    await work({
      ...f,
      database,
      env,
      sql: (q) => psql(q, { database }),
      lock: (q) => finalizeLock(q ?? f.lockRequest, resources, env),
    });
  } finally {
    if (created) {
      assert.match(database, /^darkpool_phase9_[a-f0-9]{16}$/);
      await psql(`DROP DATABASE "${database}";`, { database: "postgres" });
    }
  }
}
const noSeal = `SELECT jsonb_build_object('sets',(SELECT count(*) FROM darkpool_private.ledger_sets),'records',(SELECT count(*) FROM darkpool_private.ledger_records),'commitments',(SELECT count(*) FROM darkpool_private.ledger_commitments),'audits',(SELECT count(*) FROM darkpool_private.audit_events WHERE id LIKE 'phase11:%'),'outbox',(SELECT count(*) FROM darkpool_private.ledger_publication_outbox),'requests',(SELECT count(*) FROM darkpool_private.lock_requests),'status',(SELECT status FROM darkpool_private.markets),'revision',(SELECT revision::text FROM darkpool_private.admin_revisions));`;
async function untouched(f) {
  assert.deepEqual(JSON.parse(await f.sql(noSeal)), {
    sets: 0,
    records: 0,
    commitments: 0,
    audits: 0,
    outbox: 0,
    requests: 0,
    status: "OPEN",
    revision: "1",
  });
}
async function corrupt(f, table, trigger, statement) {
  // Deliberately corrupt ONLY this disposable TEST database to check detection.
  await f.sql(
    `BEGIN; ALTER TABLE darkpool_private.${table} DISABLE TRIGGER ${trigger}; ${statement} ALTER TABLE darkpool_private.${table} ENABLE TRIGGER ${trigger}; COMMIT;`,
  );
}

test("Phase 11 valid atomic lock, persisted root/blindings and pending outbox", async () =>
  isolated(async (f) => {
    await migratePhase11(f.database); // checksum/idempotent apply
    const result = await f.lock();
    assert.equal(result.result, "LOCKED");
    assert.equal(result.publication, "PENDING");
    assert.equal(result.revision, "2");
    assert.equal(result.commitment.accepted_ticket_count, "2");
    const saved = JSON.parse(
      await f.sql(
        `SELECT jsonb_build_object('status',(SELECT status FROM darkpool_private.markets),'count',(SELECT count(*) FROM darkpool_private.ledger_records),'blinds',(SELECT count(DISTINCT record_blinding) FROM darkpool_private.ledger_records WHERE octet_length(record_blinding)=32),'root',(SELECT encode(merkle_root,'hex') FROM darkpool_private.ledger_commitments),'payload',(SELECT payload FROM darkpool_private.ledger_publication_outbox),'receipts',(SELECT count(*) FROM darkpool_private.ledger_publication_receipts),'audits',(SELECT count(*) FROM darkpool_private.audit_events WHERE id LIKE 'phase11:%'));`,
      ),
    );
    assert.equal(saved.status, "LOCKED");
    assert.equal(saved.count, 2);
    assert.equal(saved.blinds, 2);
    assert.equal(saved.root, result.commitment.merkle_root);
    assert.deepEqual(saved.payload, result.commitment);
    assert.equal(saved.receipts, 0);
    assert.equal(saved.audits, 3);
  }));
test("Phase 11 empty ledger uses the frozen contextual empty root", async () =>
  isolated(
    async (f) => {
      assert.equal((await f.lock()).commitment.accepted_ticket_count, "0");
    },
    { count: 0 },
  ));
test("Phase 11 exact containing-time equality is late and not accepted", async () =>
  isolated(
    async (f) => {
      const result = await f.lock();
      assert.equal(result.commitment.accepted_ticket_count, "1");
      assert.equal(
        await f.sql(
          `SELECT status_policy_ref FROM darkpool_private.payment_receipts WHERE ticket_id='${id(2)}';`,
        ),
        "phase9-late",
      );
    },
    {
      modifyRequest: (r) => {
        const o = r.outputs[1],
          h = 106;
        o.block_height = h;
        o.block_hash = id(h);
        o.block_time = r.chain.close_proof.anchor_window.at(-1).time + 6;
        r.chain.inclusion_blocks[1] = {
          height: h,
          hash: id(h),
          prev_hash: id(h - 1),
          time: o.block_time,
        };
      },
    },
  ));
test("Phase 11 before wall close rejects without writes", async () =>
  isolated(
    async (f) => {
      await assert.rejects(f.lock());
      await untouched(f);
    },
    { close: Math.floor(Date.now() / 1000) + 90 },
  ));
test("Phase 11 incomplete mature confirmation horizon rejects", async () =>
  isolated(
    async (f) => {
      await assert.rejects(f.lock());
      await untouched(f);
    },
    { tip: 112 },
  ));
test("Phase 11 pending unmined output stays outside the frozen ledger", async () =>
  isolated(
    async (f) => {
      assert.equal((await f.lock()).commitment.accepted_ticket_count, "1");
    },
    {
      modifyRequest: (r) => {
        Object.assign(r.outputs[1], {
          canonical: false,
          present: true,
          block_height: null,
          block_hash: null,
          block_time: null,
          tx_index: null,
        });
        r.chain.inclusion_blocks = r.chain.inclusion_blocks.slice(0, 1);
      },
    },
  ));
test("Phase 11 active safety hold rejects and cannot clear accepted history", async () =>
  isolated(async (f) => {
    const hold = {
      ...f.request,
      request_id: randomBytes(32).toString("hex"),
      mode: "safety_stop",
      reason: "RESTORE_REVIEW",
    };
    delete hold.outputs;
    delete hold.chain;
    await f.sql(`SELECT darkpool_watcher.reconcile(1,${json(hold)});`);
    await assert.rejects(
      f.lock({ ...f.lockRequest, expected_watcher_revision: "2" }),
    );
    await untouched(f);
  }));
test("Phase 11 incomplete scan or stale checkpoint rejects", async () =>
  isolated(async (f) => {
    await corrupt(
      f,
      "watcher_evidence",
      "watcher_evidence_immutable",
      `UPDATE darkpool_private.watcher_evidence SET details=jsonb_set(details,'{chain,complete}','false'::jsonb) WHERE id='${f.lockRequest.checkpoint_ref}';`,
    );
    await assert.rejects(f.lock());
    await untouched(f);
  }));
test("Phase 11 expired verification time rejects", async () =>
  isolated(async (f) => {
    await corrupt(
      f,
      "watcher_evidence",
      "watcher_evidence_immutable",
      `UPDATE darkpool_private.watcher_evidence SET details=jsonb_set(details,'{chain,verified_at}',to_jsonb((clock_timestamp()-interval '31 seconds')::text)) WHERE id='${f.lockRequest.checkpoint_ref}';`,
    );
    await assert.rejects(f.lock());
    await untouched(f);
  }));
test("Phase 11 immutable acceptance evidence mismatch is detected", async () =>
  isolated(async (f) => {
    await corrupt(
      f,
      "watcher_evidence",
      "watcher_evidence_immutable",
      `UPDATE darkpool_private.watcher_evidence SET details=jsonb_set(details,'{containing,time}','1'::jsonb) WHERE kind='ACCEPTANCE';`,
    );
    await assert.rejects(f.lock());
    await untouched(f);
  }));
test("Phase 11 stale admin/watcher revisions and wrong market fail closed", async () =>
  isolated(async (f) => {
    for (const patch of [
      { expected_revision: "2" },
      { expected_watcher_revision: "0" },
      { market_id: "wrong" },
      { checkpoint_ref: "wrong" },
    ])
      await assert.rejects(f.lock({ ...f.lockRequest, ...patch }));
    await untouched(f);
  }));
test("Phase 11 maintenance credentials cannot masquerade as finalizer", async () =>
  isolated(async (f) => {
    await assert.rejects(
      finalizeLock(f.lockRequest, resources, {
        ...f.env,
        PGUSER: process.env.PGUSER,
        PGPASSWORD: process.env.PGPASSWORD,
      }),
    );
    await untouched(f);
  }));
test("Phase 11 same-key retry preserves root, timestamp, blindings, revision and audits", async () =>
  isolated(async (f) => {
    const first = await f.lock();
    const capture = `SELECT jsonb_build_object('records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY ticket_id) FROM darkpool_private.ledger_records r),'requests',(SELECT jsonb_agg(to_jsonb(q)) FROM darkpool_private.lock_requests q),'audits',(SELECT count(*) FROM darkpool_private.audit_events));`;
    const before = await f.sql(capture);
    assert.deepEqual(await f.lock(), first);
    assert.equal(await f.sql(capture), before);
    await assert.rejects(
      f.lock({ ...f.lockRequest, request_key: "conflicting_key" }),
    );
    await assert.rejects(f.lock({ ...f.lockRequest, expected_revision: "2" }));
    assert.equal(await f.sql(capture), before);
  }));
test("Phase 11 concurrent finalizers cannot create two seals", async () =>
  isolated(async (f) => {
    const outcomes = await Promise.allSettled([f.lock(), f.lock()]);
    assert.ok(outcomes.some((x) => x.status === "fulfilled"));
    const result = await f.lock();
    assert.equal(result.revision, "2");
    assert.equal(
      await f.sql(`SELECT count(*) FROM darkpool_private.lock_requests;`),
      "1",
    );
  }));
test("Phase 11 failure after finish rolls back every seal write", async () =>
  isolated(async (f) => {
    const session = await openLockSession(f.env);
    const wrapped = {
      query: async (sql) => {
        if (sql.startsWith("COMMIT;"))
          throw new Error("synthetic commit interruption");
        return session.query(sql);
      },
      close: () => session.close(),
    };
    try {
      await assert.rejects(
        finalizeInSession(wrapped, f.lockRequest, resources),
      );
    } finally {
      await session.close();
    }
    await untouched(f);
  }));
test("Phase 11 deferred commit failure rolls back every seal write", async () =>
  isolated(async (f) => {
    await f.sql(`CREATE FUNCTION darkpool_private.phase11_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='synthetic deferred failure'; END $$;
  CREATE CONSTRAINT TRIGGER phase11_test_failure AFTER INSERT ON darkpool_private.ledger_publication_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_private.phase11_test_failure();`);
    await assert.rejects(f.lock());
    await untouched(f);
  }));
test("Phase 11 each individual write failure rolls back the whole transaction", async () =>
  isolated(async (f) => {
    await f.sql(
      `CREATE FUNCTION darkpool_private.phase11_step_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1199',MESSAGE='synthetic step failure'; END $$;`,
    );
    for (const [table, event] of [
      ["ledger_sets", "INSERT"],
      ["ledger_records", "INSERT"],
      ["ledger_sets", "UPDATE"],
      ["ledger_commitments", "INSERT"],
      ["admin_revisions", "UPDATE"],
      ["lock_requests", "INSERT"],
      ["ledger_publication_outbox", "INSERT"],
      ["audit_events", "INSERT"],
      ["markets", "UPDATE"],
    ]) {
      await f.sql(
        `CREATE TRIGGER phase11_step_failure BEFORE ${event} ON darkpool_private.${table} FOR EACH ROW EXECUTE FUNCTION darkpool_private.phase11_step_failure();`,
      );
      await assert.rejects(f.lock());
      await untouched(f);
      await f.sql(
        `DROP TRIGGER phase11_step_failure ON darkpool_private.${table};`,
      );
    }
  }));
test("Phase 11 frozen snapshots reject mutation; new acceptance cannot enter", async () =>
  isolated(async (f) => {
    await f.lock();
    for (const statement of [
      `UPDATE darkpool_private.ledger_records SET record_blinding=decode(repeat('ff',32),'hex');`,
      `DELETE FROM darkpool_private.ledger_records;`,
      `TRUNCATE darkpool_private.ledger_records;`,
      `UPDATE darkpool_private.ledger_commitments SET merkle_root=decode(repeat('ff',32),'hex');`,
      `UPDATE darkpool_private.tickets SET accepted_amount_zat=0;`,
      `DELETE FROM darkpool_private.accepted_payment_receipts;`,
      `UPDATE darkpool_private.ledger_publication_outbox SET payload='{}';`,
    ])
      await assert.rejects(f.sql(statement));
    assert.equal((await f.lock()).revision, "2");
  }));
test("Phase 11 missing persisted blinding blocks replay verification", async () =>
  isolated(async (f) => {
    await f.lock();
    await corrupt(
      f,
      "ledger_records",
      "ledger_membership",
      `UPDATE darkpool_private.ledger_records SET record_blinding=NULL;`,
    );
    await assert.rejects(f.lock());
  }));
test("Phase 11 subsequent watcher scan cannot accept a new output after locking", async () =>
  isolated(
    async (f) => {
      const first = await f.lock();
      assert.equal(first.commitment.accepted_ticket_count, "2");
      const next = structuredClone(f.request);
      next.request_id = randomBytes(32).toString("hex");
      next.chain.verified_at = new Date().toISOString();
      Object.assign(next.outputs[2], {
        canonical: true,
        present: true,
        block_height: 103,
        block_hash: id(103),
        block_time: f.close - 3,
        tx_index: 3,
      });
      next.chain.inclusion_blocks.push(
        next.chain.close_proof.window.find((x) => x.height === 103),
      );
      await f.sql(`SELECT darkpool_watcher.reconcile(1,${json(next)});`);
      assert.equal(
        await f.sql(
          `SELECT accepted_amount_zat::text FROM darkpool_private.tickets WHERE id='${id(3)}';`,
        ),
        "0",
      );
      assert.deepEqual(await f.lock(), first);
    },
    {
      count: 3,
      modifyRequest: (r) => {
        Object.assign(r.outputs[2], {
          canonical: false,
          present: true,
          block_height: null,
          block_hash: null,
          block_time: null,
          tx_index: null,
        });
        r.chain.inclusion_blocks = r.chain.inclusion_blocks.slice(0, 2);
      },
    },
  ));
test("Phase 11 private access, public projection and publication receipt gates", async () =>
  isolated(async (f) => {
    const result = await f.lock();
    const session = await openLockSession(f.env);
    try {
      const allowed = await session.query(
        `SELECT jsonb_build_object('private',has_table_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='darkpool_private' AND c.relname='ledger_records'),'SELECT'),'write',has_table_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='darkpool_private' AND c.relname='ledger_publication_receipts'),'INSERT'));`,
      );
      assert.deepEqual(allowed, { private: false, write: false });
    } finally {
      await session.close();
    }
    assert.deepEqual(
      Object.keys(result.commitment).sort(),
      [
        "market_id",
        "ledger_version",
        "accepted_ticket_count",
        "merkle_root",
        "locked_at",
      ].sort(),
    );
    assert.equal(
      await f.sql(
        `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='darkpool_public' AND column_name IN ('side','record_blinding','accepted_amount_zat','receiver_ref'));`,
      ),
      "f",
    );
    await assert.rejects(
      f.sql(
        `INSERT INTO darkpool_private.ledger_publication_receipts VALUES('${f.mid}',decode('${result.commitment.merkle_root}','hex'),'fake','{"url":"https://synthetic.invalid"}',now());`,
      ),
    );
    await assert.rejects(
      f.sql(
        `INSERT INTO darkpool_private.resolutions VALUES('synthetic-resolution','${f.mid}',1,'YES',ARRAY['synthetic'],'synthetic','synthetic',now());`,
      ),
    );
    assert.equal(
      await f.sql(
        `SELECT count(*) FROM darkpool_private.ledger_publication_receipts;`,
      ),
      "0",
    );
  }));

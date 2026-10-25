import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { psql } from "../test-fixtures.mjs";
import { migratePublication } from "../phase11-publication-migrations.mjs";
import { provisionLockScript } from "../lock-provision.mjs";
import { provisionPublicationScript } from "../publication-provision.mjs";
import { fixture, json, resources } from "./lock-fixtures.mjs";
import { finalizeLock } from "../../services/lock/finalize.mts";
import { openLockSession } from "../../services/lock/db-session.mjs";
import { persistPublication } from "../../services/publication/persist.mjs";
import { verifyPublication } from "../../services/publication/verify.mjs";
import { PROFILE } from "../../services/publication/profile.mjs";
import {
  authority,
  executable,
  copy,
  syntheticRetrieval,
} from "../../services/publication/test/fixtures.mjs";

const suffix = randomBytes(8).toString("hex"),
  verifierRole = "darkpool_publication_" + suffix,
  lockRole = "darkpool_lock_" + suffix,
  password = randomBytes(32).toString("hex");
let issuer,
  rolesCreated = false;
before(async () => {
  assert.equal(process.env.PGDATABASE, "postgres");
  issuer = await authority();
  await psql(
    [verifierRole, lockRole]
      .map(
        (role) =>
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
      )
      .join("\n"),
    { database: "postgres" },
  );
  rolesCreated = true;
});
after(async () => {
  try {
    if (rolesCreated)
      await psql(`DROP ROLE "${verifierRole}"; DROP ROLE "${lockRole}";`, {
        database: "postgres",
      });
  } finally {
    await issuer?.close();
  }
});

const original = `SELECT jsonb_build_object('records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY ticket_id) FROM darkpool_private.ledger_records r),
 'sets',(SELECT jsonb_agg(to_jsonb(l)) FROM darkpool_private.ledger_sets l),
 'commitments',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.ledger_commitments c),
 'requests',(SELECT jsonb_agg(to_jsonb(q)) FROM darkpool_private.lock_requests q),
 'outbox',(SELECT jsonb_agg(to_jsonb(o)) FROM darkpool_private.ledger_publication_outbox o),
 'accepted',(SELECT jsonb_agg(to_jsonb(a)) FROM darkpool_private.accepted_payments a),
 'watcher',(SELECT jsonb_agg(to_jsonb(w)) FROM darkpool_private.watcher_state w),
 'status',(SELECT status FROM darkpool_private.markets));`;

async function isolated(work) {
  const database = "darkpool_phase9_" + randomBytes(8).toString("hex");
  let created = false;
  const sql = (q) => psql(q, { database });
  try {
    await psql(
      `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
      { database: "postgres" },
    );
    created = true;
    await migratePublication(database);
    await sql(provisionLockScript(lockRole));
    await sql(provisionPublicationScript(verifierRole, database, issuer.trust));
    // Issue synthetic tickets before the real issuance guard's close deadline.
    // A one-second margin races Windows process startup; keep the guard intact.
    const f = fixture(Math.floor(Date.now() / 1000) + 4);
    await sql(f.setup);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, f.close * 1000 - Date.now() + 10)),
    );
    const env = {
      ...process.env,
      PGDATABASE: database,
      PGUSER: lockRole,
      PGPASSWORD: password,
      APP_ENV: "development",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
    };
    const locked = await finalizeLock(f.lockRequest, resources, env);
    env.PGUSER = verifierRole;
    // RFC3161 fixture has whole-second precision; avoid claiming a timestamp
    // earlier than the exact microsecond seal time.
    await new Promise((resolve) => setTimeout(resolve, 1010));
    const proof = await issuer.evidence(locked.commitment);
    const baseline = JSON.parse(await sql(original));
    await work({
      ...f,
      database,
      sql,
      env,
      locked,
      proof,
      publish: (evidence = proof, trust = issuer.trust) =>
        persistPublication(
          f.mid,
          evidence,
          trust,
          executable,
          env,
          syntheticRetrieval(proof),
        ),
      query: async (statement, connection = env) => {
        const session = await openLockSession(connection);
        try {
          return await session.query(statement);
        } finally {
          await session.close();
        }
      },
    });
    assert.deepEqual(
      JSON.parse(await sql(original)),
      baseline,
      "publication must not mutate lock/payment evidence",
    );
  } finally {
    if (created) {
      assert.match(database, /^darkpool_phase9_[a-f0-9]{16}$/);
      await psql(`DROP DATABASE "${database}";`, { database: "postgres" });
    }
  }
}
const count = async (f) =>
  Number(
    await f.sql(
      "SELECT count(*) FROM darkpool_private.ledger_publication_receipts;",
    ),
  );

test("0009 valid synthetic evidence persists exact digest/references; immutable seal; checksum retry", async () =>
  isolated(async (f) => {
    await migratePublication(f.database);
    await f.sql(
      provisionPublicationScript(verifierRole, f.database, issuer.trust),
    );
    const result = await f.publish();
    assert.equal(result.publication, "SYNTHETIC_TEST_ONLY");
    assert.equal(result.evidence_class, "SYNTHETIC_TEST");
    assert.equal(result.merkle_root, f.locked.commitment.merkle_root);
    const retained = JSON.parse(
      await f.sql(
        "SELECT receipt FROM darkpool_private.ledger_publication_receipts;",
      ),
    );
    assert.deepEqual(retained.evidence, f.proof);
    assert.equal(await count(f), 1);
    assert.equal(
      await f.sql("SELECT count(*) FROM darkpool_private.resolutions;"),
      "0",
    );
  }));
test("identical valid replay returns original receipt and recorded_at", async () =>
  isolated(async (f) => {
    const first = await f.publish();
    assert.deepEqual(await f.publish(), first);
    assert.equal(await count(f), 1);
  }));
test("two simultaneous deliveries converge after serialization retry without a second receipt", async () =>
  isolated(async (f) => {
    const results = await Promise.allSettled([f.publish(), f.publish()]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    const expected = results.find((r) => r.status === "fulfilled").value;
    assert.deepEqual(await f.publish(), expected);
    assert.equal(await count(f), 1);
  }));
test("missing and forged evidence leave no persisted receipt", async () =>
  isolated(async (f) => {
    const missing = copy(f.proof);
    delete missing.tsq;
    await assert.rejects(f.publish(missing));
    const forged = copy(f.proof);
    forged.signature = Buffer.alloc(64).toString("base64");
    await assert.rejects(f.publish(forged));
    assert.equal(await count(f), 0);
  }));
test("another root's valid signed proof cannot bind this outbox", async () =>
  isolated(async (f) => {
    const wrong = { ...f.locked.commitment, merkle_root: "fe".repeat(32) };
    await assert.rejects(f.publish(await issuer.evidence(wrong)));
    assert.equal(await count(f), 0);
  }));
test("contradictory but valid witness record cannot replace first receipt", async () =>
  isolated(async (f) => {
    const first = await f.publish();
    const conflicting = await issuer.evidence(f.locked.commitment, (s) => {
      s.commit = "34".repeat(20);
    });
    await assert.rejects(f.publish(conflicting));
    assert.deepEqual(await f.publish(), first);
    assert.equal(await count(f), 1);
  }));
test("unavailable trust cannot persist, even with syntactically complete evidence", async () =>
  isolated(async (f) => {
    await assert.rejects(f.publish(f.proof, null), /PUBLICATION_UNAVAILABLE/);
    assert.equal(await count(f), 0);
  }));
test("verifier cannot read private book, change seal, insert directly or SET ROLE around guard", async () =>
  isolated(async (f) => {
    for (const statement of [
      "SELECT row_to_json(r) FROM darkpool_private.ledger_records r;",
      "SELECT darkpool_lock.snapshot('phase11-synthetic');",
      "UPDATE darkpool_private.ledger_commitments SET merkle_root=decode(repeat('ff',32),'hex'); SELECT '{}'::jsonb;",
      "INSERT INTO darkpool_private.ledger_publication_receipts SELECT * FROM darkpool_private.ledger_publication_receipts; SELECT '{}'::jsonb;",
      `SET ROLE "${verifierRole}"; SELECT darkpool_publication.outbox('phase11-synthetic');`,
    ])
      await assert.rejects(f.query(statement));
    const publicOutbox = await f.query(
      "SELECT darkpool_publication.outbox('phase11-synthetic');",
    );
    assert.deepEqual(publicOutbox, f.locked.commitment);
    assert.equal(await count(f), 0);
  }));
test("finalizer role cannot invoke verifier entrypoints", async () =>
  isolated(async (f) => {
    await assert.rejects(
      f.query("SELECT darkpool_publication.outbox('phase11-synthetic');", {
        ...f.env,
        PGUSER: lockRole,
      }),
    );
    assert.equal(await count(f), 0);
  }));
test("rollback after receipt insertion leaves no row; later normal submission succeeds", async () =>
  isolated(async (f) => {
    const verified = await verifyPublication(
      f.locked.commitment,
      f.proof,
      issuer.trust,
      executable,
      syntheticRetrieval(f.proof),
    );
    const session = await openLockSession(f.env);
    try {
      await session.query(
        "BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL synchronous_commit=on; SELECT '{}'::jsonb;",
      );
      await session.query(
        `SELECT darkpool_publication.persist(${json({ ...verified, profile: PROFILE })});`,
      );
      await assert.rejects(session.query("SELECT 1/0;"));
    } finally {
      await session.close();
    }
    assert.equal(await count(f), 0);
    assert.equal((await f.publish()).publication, "SYNTHETIC_TEST_ONLY");
  }));
test("SQL independently rejects changed root/digest, policy and absent verification payload", async () =>
  isolated(async (f) => {
    const verified = await verifyPublication(
      f.locked.commitment,
      f.proof,
      issuer.trust,
      executable,
      syntheticRetrieval(f.proof),
    );
    for (const override of [
      { merkle_root: "ee".repeat(32) },
      { content_sha256: "00".repeat(32) },
      { trust_sha256: "00".repeat(32) },
      { policy_ref: "unknown" },
      { receipt_id: "00".repeat(32) },
      { receipt: {} },
      { evidence_class: "EXTERNAL" },
    ]) {
      await assert.rejects(
        f.query(`BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL synchronous_commit=on;
      SELECT darkpool_publication.persist(${json({ ...verified, ...override, profile: PROFILE })});`),
      );
    }
    assert.equal(await count(f), 0);
  }));
test("receipt and trust policy are append-only, including privileged ordinary UPDATE/DELETE/TRUNCATE", async () =>
  isolated(async (f) => {
    await f.publish();
    for (const statement of [
      "UPDATE darkpool_private.ledger_publication_receipts SET recorded_at=now();",
      "DELETE FROM darkpool_private.ledger_publication_receipts;",
      "TRUNCATE darkpool_private.ledger_publication_receipts;",
      "UPDATE darkpool_private.publication_policies SET evidence_class='EXTERNAL';",
      "TRUNCATE darkpool_private.publication_policies CASCADE;",
    ])
      await assert.rejects(f.sql(statement));
    assert.equal(await count(f), 1);
  }));
test("synthetic receipt cannot authorize resolution; public response excludes private fields", async () =>
  isolated(async (f) => {
    const result = await f.publish();
    await assert.rejects(
      f.sql(`INSERT INTO darkpool_private.resolutions VALUES('synthetic-forbidden',
    '${f.mid}',1,'YES',ARRAY['synthetic-evidence'],'synthetic-rule','synthetic-actor',now());`),
      (e) => e.sqlstate === "P1105",
    );
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "content_sha256",
        "evidence_class",
        "market_id",
        "merkle_root",
        "policy_ref",
        "publication",
        "receipt_id",
        "recorded_at",
        "timestamp_at",
      ].sort(),
    );
    const serialized = JSON.stringify(result);
    for (const field of [
      "signature",
      "side",
      "record_blinding",
      "accepted_amount_zat",
      "receiver_ref",
      "claim_secret",
      "tsq",
      "tsr",
    ])
      assert.equal(serialized.includes('"' + field + '"'), false);
  }));

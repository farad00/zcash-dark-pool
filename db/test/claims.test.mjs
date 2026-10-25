import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { psql } from "../test-fixtures.mjs";
import { migrateClaims } from "../claims-migrations.mjs";
import { provisionClaimsScript } from "../claims-provision.mjs";
import { authority } from "../../services/publication/test/fixtures.mjs";
import { claimFixture, secret } from "./claim-fixtures.mjs";
import { id } from "./lock-fixtures.mjs";
import { claimInSession } from "../../services/claims/reserve.mjs";
import { openLockSession } from "../../services/lock/db-session.mjs";
const suffix = randomBytes(8).toString("hex"),
  password = randomBytes(32).toString("hex");
const roles = Object.fromEntries(
  ["lock", "publication", "oracle", "coordinator", "claim", "other"].map(
    (k) => [k, "darkpool_" + k + "_" + suffix],
  ),
);
let issuer,
  addresses,
  createdRoles = false;
before(async () => {
  assert.equal(process.env.PGDATABASE, "postgres");
  issuer = await authority();
  const env = {
    DARKPOOL_SYNTHETIC_TEST: "1",
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  addresses = JSON.parse(
    execFileSync(
      fileURLToPath(
        new URL(
          "../../target/debug/examples/phase14-claim-fixture.exe",
          import.meta.url,
        ),
      ),
      [],
      { env, windowsHide: true, encoding: "utf8" },
    ),
  );
  assert.equal(new Set(addresses).size, 6);
  await psql(
    "BEGIN;\n" +
      Object.values(roles)
        .map(
          (r) =>
            `CREATE ROLE "${r}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
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
const isolated = (work, options) =>
  claimFixture({ roles, password, issuer, addresses }, work, options);
const counts = async (f) =>
  JSON.parse(
    await f.sql(
      "SELECT jsonb_build_object('core',(SELECT count(*) FROM darkpool_private.claims),'reservations',(SELECT count(*) FROM darkpool_private.claim_reservations),'instructions',(SELECT count(*) FROM darkpool_private.claim_instruction_outbox));",
    ),
  );
const rejected = (promise) =>
  assert.rejects(promise, (e) => e.message === "CLAIM_REJECTED");

test("0011 winning claim: exact durable binding, original credentials, immutable source and checksum replay", async () =>
  isolated(async (f) => {
    await migrateClaims(f.database);
    await f.sql(provisionClaimsScript(roles.claim, f.mid, "SYNTHETIC_TEST"));
    const original = new Uint8Array(f.request.claim_secret);
    const prerequisites = JSON.parse(
      await f.sql(`SELECT jsonb_build_object(
      'ticket',EXISTS(SELECT 1 FROM darkpool_private.tickets WHERE id='${id(1)}'),
      'profile',EXISTS(SELECT 1 FROM darkpool_private.tickets WHERE id='${id(1)}' AND claim_commitment_profile='DARKPOOL_CLAIM_V1_ID_FRAME_1'),
      'payable',EXISTS(SELECT 1 FROM darkpool_private.entitlements e JOIN darkpool_private.resolution_entitlements b ON b.entitlement_id=e.id WHERE e.ticket_id='${id(1)}' AND e.amount_zat>0 AND e.amount_zat=b.winning_payout_zat+b.refund_zat),
      'member',EXISTS(SELECT 1 FROM darkpool_private.ledger_records WHERE ticket_id='${id(1)}'),
      'unbound',EXISTS(SELECT 1 FROM darkpool_private.claims));`),
    );
    assert.deepEqual(prerequisites, {
      ticket: true,
      profile: true,
      payable: true,
      member: true,
      unbound: false,
    });
    const r = await f.reserve();
    assert.equal(r.state, "RESERVED");
    assert.equal(r.execution_class, "SYNTHETIC_TEST");
    assert.equal(r.spending_authorized, false);
    assert.deepEqual(f.request.claim_secret, original);
    assert.deepEqual(await counts(f), {
      core: 1,
      reservations: 1,
      instructions: 0,
    });
    assert.equal(
      await f.sql("SELECT entitlement_zat::text FROM darkpool_private.claims;"),
      "2",
    );
    assert.equal(
      await f.sql(
        "SELECT count(*) FROM darkpool_private.audit_events WHERE event='CLAIM_RESERVED';",
      ),
      "1",
    );
  }));
test("identical reservation and preparation retries keep one identity and one instruction", async () =>
  isolated(async (f) => {
    const a = await f.reserve();
    assert.deepEqual(await f.reserve(), a);
    const p = await f.prepare();
    assert.equal(p.state, "PREPARED");
    assert.equal(p.reservation_id, a.reservation_id);
    assert.equal(p.revision, "2");
    assert.deepEqual(await f.prepare(), p);
    assert.deepEqual(await counts(f), {
      core: 1,
      reservations: 1,
      instructions: 1,
    });
    assert.equal(
      await f.sql("SELECT state FROM darkpool_private.claims;"),
      "TX_PREPARING",
    );
  }));
test("NO winners can claim through the same credential format", async () =>
  isolated(
    async (f) => {
      const q = { ...f.request, ticket_id: id(2) };
      await f.reserve(q);
      assert.equal(
        await f.sql(
          "SELECT entitlement_zat::text FROM darkpool_private.claims;",
        ),
        "3",
      );
    },
    { outcome: "NO" },
  ));
test("VOID refunds full stake and preserves refund kind", async () =>
  isolated(
    async (f) => {
      await f.reserve();
      await f.prepare();
      assert.equal(
        await f.sql("SELECT refund_reason FROM darkpool_private.claims;"),
        "VOID",
      );
      assert.equal(
        await f.sql(
          "SELECT entitlement_zat::text FROM darkpool_private.claims;",
        ),
        "1",
      );
    },
    { outcome: "VOID" },
  ));
test("no-winner refund uses same credential and full accepted amount", async () =>
  isolated(
    async (f) => {
      await f.reserve();
      assert.equal(
        await f.sql("SELECT refund_reason FROM darkpool_private.claims;"),
        "NO_WINNER_REFUND",
      );
      assert.equal(
        await f.sql(
          "SELECT entitlement_zat::text FROM darkpool_private.claims;",
        ),
        "1",
      );
    },
    { outcome: "NO", count: 1 },
  ));
test("losing, unknown and invalid-secret tickets cannot reserve or inspect an existing obligation", async () =>
  isolated(async (f) => {
    await rejected(f.reserve({ ...f.request, ticket_id: id(2) }));
    await rejected(f.reserve({ ...f.request, ticket_id: id(99) }));
    await rejected(
      f.reserve({ ...f.request, claim_secret: new Uint8Array(32).fill(8) }),
    );
    await f.reserve();
    await rejected(
      f.reserve({ ...f.request, claim_secret: new Uint8Array(32).fill(8) }),
    );
    assert.equal((await counts(f)).core, 1);
  }));
test("malformed, transparent-only and known receiving destinations fail closed", async () =>
  isolated(async (f) => {
    for (const ua of [
      "utest1invalid",
      "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
      addresses[0],
    ])
      await rejected(f.reserve({ ...f.request, payout_ua: ua }));
    assert.equal((await counts(f)).core, 0);
  }));
test("concurrent identical claims converge without duplicate obligations", async () =>
  isolated(async (f) => {
    const results = await Promise.allSettled([f.reserve(), f.reserve()]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    const r = results.find((r) => r.status === "fulfilled").value;
    assert.deepEqual(await f.reserve(), r);
    assert.equal((await counts(f)).core, 1);
  }));
test("conflicting concurrent destinations cannot replace the first reservation", async () =>
  isolated(async (f) => {
    const other = { ...f.request, payout_ua: addresses[5] };
    const results = await Promise.allSettled([f.reserve(), f.reserve(other)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const winner = results[0].status === "fulfilled" ? f.request : other;
    assert.equal((await f.reserve(winner)).state, "RESERVED");
    await rejected(
      f.reserve(results[0].status === "fulfilled" ? other : f.request),
    );
    assert.equal((await counts(f)).core, 1);
  }));
test("one market-wide idempotency identity cannot bind two entitlements", async () =>
  isolated(async (f) => {
    await f.reserve();
    await rejected(
      f.reserve({ ...f.request, ticket_id: id(3), payout_ua: addresses[5] }),
    );
    assert.equal((await counts(f)).core, 1);
  }));
test("a payout receiver cannot be reused for another winning entitlement", async () =>
  isolated(async (f) => {
    await f.reserve();
    await rejected(
      f.reserve({
        ...f.request,
        ticket_id: id(3),
        idempotency_key: "different_claim",
      }),
    );
    assert.equal((await counts(f)).core, 1);
  }));
test("pending publication and missing durable resolution never qualify", async () => {
  await isolated(
    async (f) => {
      await rejected(f.reserve());
      assert.equal((await counts(f)).core, 0);
    },
    { pending: true },
  );
  await isolated(
    async (f) => {
      await rejected(f.reserve());
      assert.equal((await counts(f)).core, 0);
    },
    { missingResolution: true },
  );
});
test("EXTERNAL claim policy cannot consume synthetic publication/resolution", async () =>
  isolated(
    async (f) => {
      await rejected(f.reserve());
      assert.equal((await counts(f)).core, 0);
    },
    { claimClass: "EXTERNAL" },
  ));
test("a safety hold and unauthorized lifecycle stop claims", async () =>
  isolated(
    async (f) => {
      await f.sql(`BEGIN;INSERT INTO darkpool_private.watcher_evidence VALUES('claim-hold','${f.mid}','HOLD',NULL,NULL,NULL,NULL,'{}',now());
 UPDATE darkpool_private.watcher_state SET revision=revision+1,hold_ref='claim-hold' WHERE market_id='${f.mid}';
 UPDATE darkpool_private.markets SET status='PAUSED' WHERE id='${f.mid}';COMMIT;`);
      await rejected(f.reserve());
      assert.equal((await counts(f)).core, 0);
    },
    { corrupt: true },
  ));
test("root and outcome mismatches reject before consuming a claim", async () =>
  isolated(
    async (f) => {
      const original = await f.sql(
        "SELECT encode(convert_to(preparation::text,'UTF8'),'hex') FROM darkpool_private.resolution_results;",
      );
      for (const [path, value] of [
        ["{binding,commitment,merkle_root}", "ff".repeat(32)],
        ["{binding,resolution,outcome}", "NO"],
      ]) {
        await f.sql(`ALTER TABLE darkpool_private.resolution_results DISABLE TRIGGER resolution_immutable;
   UPDATE darkpool_private.resolution_results SET preparation=jsonb_set(convert_from(decode('${original}','hex'),'UTF8')::jsonb,'${path}','"${value}"');
   ALTER TABLE darkpool_private.resolution_results ENABLE TRIGGER resolution_immutable;`);
        await rejected(f.reserve());
      }
      assert.equal((await counts(f)).core, 0);
    },
    { corrupt: true },
  ));

test("lost commit acknowledgement recovers the original reservation on retry", async () =>
  isolated(async (f) => {
    const session = await openLockSession(f.env("claim"));
    try {
      await rejected(
        claimInSession(
          {
            query: async (statement) => {
              const result = await session.query(statement);
              if (statement.startsWith("COMMIT;"))
                throw new Error("synthetic lost acknowledgement");
              return result;
            },
          },
          f.request,
        ),
      );
    } finally {
      await session.close();
    }
    const original = await f.sql(
      "SELECT claim_id FROM darkpool_private.claim_reservations;",
    );
    assert.equal((await f.reserve()).reservation_id, original);
    assert.deepEqual(await counts(f), {
      core: 1,
      reservations: 1,
      instructions: 0,
    });
  }));

test("concurrent preparation creates one immutable instruction and retries recover it", async () =>
  isolated(async (f) => {
    await f.reserve();
    const results = await Promise.allSettled([f.prepare(), f.prepare()]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    const original = results.find((r) => r.status === "fulfilled").value;
    assert.equal(original.state, "PREPARED");
    assert.deepEqual(await f.prepare(), original);
    assert.deepEqual(await counts(f), {
      core: 1,
      reservations: 1,
      instructions: 1,
    });
    await assert.rejects(
      f.sql("DELETE FROM darkpool_private.claim_instruction_outbox;"),
    );
    await assert.rejects(
      f.sql(
        "UPDATE darkpool_private.claim_instruction_outbox SET instruction='{}';",
      ),
    );
  }));
test("failure after core claim insertion rolls back the entire obligation", async () =>
  isolated(async (f) => {
    await f.sql(
      "CREATE FUNCTION darkpool_private.claim_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON darkpool_private.claim_reservations FOR EACH ROW EXECUTE FUNCTION darkpool_private.claim_fail();",
    );
    await rejected(f.reserve());
    assert.deepEqual(await counts(f), {
      core: 0,
      reservations: 0,
      instructions: 0,
    });
    await f.sql(
      "DROP TRIGGER synthetic_fail ON darkpool_private.claim_reservations;",
    );
    await f.reserve();
  }));
test("preparation failure preserves committed reservation and supports exact retry", async () =>
  isolated(async (f) => {
    const r = await f.reserve();
    await f.sql(
      "CREATE FUNCTION darkpool_private.instruction_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON darkpool_private.claim_instruction_outbox FOR EACH ROW EXECUTE FUNCTION darkpool_private.instruction_fail();",
    );
    await rejected(f.prepare());
    assert.deepEqual(await f.reserve(), r);
    assert.deepEqual(await counts(f), {
      core: 1,
      reservations: 1,
      instructions: 0,
    });
    await f.sql(
      "DROP TRIGGER synthetic_fail ON darkpool_private.claim_instruction_outbox;",
    );
    assert.equal((await f.prepare()).state, "PREPARED");
  }));
test("preparation requires a committed reservation and cannot claim submission or finality", async () =>
  isolated(async (f) => {
    await rejected(f.prepare());
    await f.reserve();
    await f.prepare();
    for (const state of [
      "SUBMISSION_UNCERTAIN",
      "SUBMITTED",
      "CONFIRMED",
      "RECONCILIATION_REQUIRED",
    ])
      await assert.rejects(
        f.sql(
          `UPDATE darkpool_private.claim_reservations SET state='${state}';`,
        ),
      );
    await assert.rejects(
      f.sql("UPDATE darkpool_private.claims SET state='CONFIRMED';"),
    );
    assert.equal(
      await f.sql(
        "SELECT count(*) FROM darkpool_private.claims WHERE tx_ref IS NOT NULL OR settlement_id IS NOT NULL;",
      ),
      "0",
    );
  }));
test("private reads, direct mutation, role impersonation and unprivileged calls are denied", async () =>
  isolated(async (f) => {
    for (const sql of [
      "SELECT row_to_json(c) FROM darkpool_private.claims c;",
      "SELECT row_to_json(c) FROM darkpool_private.claim_reservations c;",
      "SELECT darkpool_lock.snapshot('phase11-synthetic');",
      `SET ROLE "${roles.claim}"; SELECT darkpool_claims.begin_claim('${f.mid}','${id(1)}','synthetic_claim_1');`,
    ])
      await assert.rejects(f.query(sql));
    await rejected(f.reserve(f.request, "other"));
    await rejected(f.reserve(f.request, "coordinator"));
    await f.reserve();
    await assert.rejects(
      f.sql("DELETE FROM darkpool_private.claim_reservations;"),
    );
    await assert.rejects(
      f.sql("TRUNCATE darkpool_private.claim_reservations CASCADE;"),
    );
  }));
test("public receipt and stored records redact secrets; wrong retries cannot change destination", async () =>
  isolated(async (f) => {
    const r = await f.reserve();
    assert.deepEqual(
      Object.keys(r).sort(),
      [
        "result",
        "reservation_id",
        "state",
        "revision",
        "execution_class",
        "spending_authorized",
      ].sort(),
    );
    await rejected(f.reserve({ ...f.request, idempotency_key: "changed_key" }));
    await rejected(f.reserve({ ...f.request, payout_ua: addresses[5] }));
    const stored = await f.sql(
      "SELECT jsonb_build_object('core',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.claims c),'private',(SELECT jsonb_agg(to_jsonb(p)) FROM darkpool_private.claim_reservations p))::text;",
    );
    assert.equal(stored.includes('"claim_secret"'), false);
    assert.equal(stored.includes(Buffer.from(secret()).toString("hex")), false);
  }));
test("bigint entitlements beyond Number precision are reserved and prepared without clipping", async () =>
  isolated(
    async (f) => {
      await f.reserve();
      await f.prepare();
      assert.equal(
        await f.sql(
          "SELECT entitlement_zat::text FROM darkpool_private.claims;",
        ),
        "9007199254740993",
      );
      assert.equal(
        await f.sql(
          "SELECT instruction#>>'{binding,amount_zat}' FROM darkpool_private.claim_instruction_outbox;",
        ),
        "9007199254740993",
      );
    },
    { stake: "6004799503160662" },
  ));

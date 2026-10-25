// New OID-bound TEST databases only. No native allocator/scanner or wallet calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { psql } from "../../../db/test-fixtures.mjs";
import { assertSyntheticLifecycle } from "../../../db/test/lifecycle-fixtures.mjs";
import { openLockSession } from "../../lock/db-session.mjs";
import {
  installSql,
  marketSql,
  roles as fixedRoles,
  intakeFiles,
  migrationDigest,
} from "../intake.mjs";
import { sha256, scope } from "../unfunded.mjs";
import { proposedTarget } from "../target.mjs";
import { createIssuer } from "../../../apps/web/src/issuance.mjs";
import { deriveClaimCommitment } from "../../../packages/protocol/src/claim-commitment.ts";
import { composeUnfundedIssuer } from "../unfunded-runtime.mjs";
import { issuancePrivilegeCheck } from "../../../db/issuance-runtime.mjs";
import {
  publicMarketQuery,
  publicPrivilegeCheck,
} from "../../../db/public-read.mjs";
import { statusPrivileges } from "../status.mjs";
import { runBounded, boundedExit } from "../../../scripts/dev/run-bounded.mjs";
import { resolve } from "node:path";
import { launchBrowser } from "../../../apps/web/test/vault-browser.mjs";

async function withIntake(work) {
  assertSyntheticLifecycle();
  const suffix = randomBytes(8).toString("hex"),
    database = "darkpool_phase9_" + suffix;
  const roles = Object.fromEntries(
    ["owner", "admin", "issue", "watch", "status", "read"].map((k) => [
      k,
      "darkpool_e2e_" + k + "_" + suffix,
    ]),
  );
  const passwords = Object.fromEntries(
    Object.keys(roles).map((k) => [k, randomBytes(32).toString("hex")]),
  );
  const bind = (sql) => {
    let s = sql
      .replaceAll(proposedTarget().database, database)
      .replaceAll("TESTNET_OBSERVATION", "DISPOSABLE_TEST");
    for (const [k, v] of Object.entries(roles))
      s = s.replaceAll(fixedRoles[k], v);
    return s;
  };
  let dbOid, roleOids;
  const catalog = (s) => psql(s, { database: "postgres" });
  const sql = (s) => psql(bind(s), { database });
  const names = Object.values(roles)
    .map((r) => `'${r}'`)
    .join(",");
  const roleQuery = async (kind, statement) => {
    const s = await openLockSession({
      ...process.env,
      APP_ENV: "development",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
      PGDATABASE: database,
      PGUSER: roles[kind],
      PGPASSWORD: passwords[kind],
    });
    try {
      return await s.query(bind(statement));
    } finally {
      await s.close();
    }
  };
  try {
    assert.equal(
      await catalog(
        `SELECT count(*) FROM pg_database WHERE datname='${database}';`,
      ),
      "0",
    );
    assert.equal(
      await catalog(
        `SELECT count(*) FROM pg_roles WHERE rolname IN (${names});`,
      ),
      "0",
    );
    await catalog(
      "BEGIN;" +
        Object.entries(roles)
          .map(
            ([k, r]) =>
              `CREATE ROLE "${r}" ${["owner", "watch"].includes(k) ? "NOLOGIN" : `LOGIN PASSWORD '${passwords[k]}'`} NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
          )
          .join("\n") +
        "COMMIT;",
    );
    roleOids = await catalog(
      `SELECT rolname,oid FROM pg_roles WHERE rolname IN (${names}) ORDER BY rolname;`,
    );
    await catalog(
      `CREATE DATABASE "${database}" OWNER "${roles.owner}" TEMPLATE template0;`,
    );
    dbOid = await catalog(
      `SELECT oid::text FROM pg_database WHERE datname='${database}';`,
    );
    await sql(
      `REVOKE ALL ON DATABASE "${database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${database}" TO ${["admin", "issue", "status", "read"].map((k) => `"${roles[k]}"`).join(",")}; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
    );
    const files = await intakeFiles();
    await sql(
      await installSql(
        {
          database: proposedTarget().database,
          kind: "DISPOSABLE_TEST",
          port: 55433,
        },
        { migrations_sha256: migrationDigest(files), scope },
      ),
    );
    await work({ database, roles, sql, bind, roleQuery });
  } finally {
    if (dbOid) {
      assert.equal(
        await catalog(
          `SELECT oid::text FROM pg_database WHERE datname='${database}';`,
        ),
        dbOid,
      );
      await catalog(`DROP DATABASE "${database}";`);
    }
    if (roleOids) {
      assert.equal(
        await catalog(
          `SELECT rolname,oid FROM pg_roles WHERE rolname IN (${names}) ORDER BY rolname;`,
        ),
        roleOids,
      );
      await catalog(
        "BEGIN;" +
          Object.values(roles)
            .map((r) => `DROP ROLE "${r}";`)
            .join("\n") +
          "COMMIT;",
      );
    }
  }
}
const configuration = () => ({
  id: "synthetic-unfunded-" + randomBytes(8).toString("hex"),
  network: "testnet",
  vault_context_ref: "synthetic-unfunded-vault",
  question: "UNFUNDED TEST fixture only; do not pay",
  yes_definition: "Gauge at least ten",
  no_definition: "Gauge below ten",
  resolution_rule: "Read synthetic gauge; VOID if unavailable",
  resolution_sources: ["synthetic-source"],
  void_conditions: ["Missing gauge"],
  opens_at: new Date(Date.now() - 60000).toISOString(),
  closes_at: new Date(Date.now() + 600000).toISOString(),
  min_stake_zat: "1",
  max_stake_zat: "100000000",
  close_policy_ref: "phase9-exact-chainclock-3-v1",
  payment_policy_ref: "phase9-exact-chainclock-3-v1",
  fee_policy_ref: "phase9-zero-platform-fee-v1",
  zero_winner_policy: "NO_WINNER_REFUND",
  deposit_confirmations: 3,
  payout_confirmations: null,
  receiving_policy_ref: "phase9-orchard-receiving-v1",
  close_proof_policy_ref: "phase9-bounded-close-proof-v2",
  payout_policy_ref: "phase9-payout-deferred-v1",
});
const watcher = {
  account_ref: "11111111-1111-4111-8111-111111111111",
  anchor_height: 100,
  anchor_hash: "ab".repeat(32),
};

test(
  "seven-migration unfunded intake: guarded OPEN, browser issuance, lost replies, one obligation, no acceptance",
  { timeout: 240000 },
  async (t) => {
    await withIntake(async (f) => {
      const c = configuration();
      await t.test(
        "only migrations 0001–0007 and NOLOGIN owner/watcher",
        async () => {
          assert.equal(
            await f.sql("SELECT count(*) FROM darkpool_migrations.applied;"),
            "7",
          );
          assert.equal(
            await f.sql(
              "SELECT count(*) FROM pg_namespace WHERE nspname IN ('darkpool_lock','darkpool_publication','darkpool_resolution','darkpool_claims','darkpool_payout');",
            ),
            "0",
          );
          assert.equal(
            await f.sql(
              `SELECT bool_and(NOT rolcanlogin) FROM pg_roles WHERE rolname IN ('${f.roles.owner}','${f.roles.watch}');`,
            ),
            "t",
          );
          for (const [k, check] of [
            ["issue", issuancePrivilegeCheck],
            ["read", publicPrivilegeCheck],
            ["status", statusPrivileges],
          ])
            assert.equal(
              await f.roleQuery(
                k,
                "SELECT to_jsonb((" + check.replace(/^SELECT\s+/, "") + "));",
              ),
              true,
            );
        },
      );
      await t.test(
        "OPEN requires watcher binding; missing profile rolls back",
        async () => {
          const broken = marketSql(c, watcher).replace(
            /INSERT INTO darkpool_private\.watcher_state[\s\S]*?SET LOCAL ROLE/,
            "SET LOCAL ROLE",
          );
          await assert.rejects(f.sql(broken));
          assert.equal(
            await f.sql("SELECT count(*) FROM darkpool_private.markets;"),
            "0",
          );
        },
      );
      await t.test(
        "fresh private OPEN uses existing admin state/revision guards",
        async () => {
          await f.sql(marketSql(c, watcher));
          assert.equal(
            await f.sql("SELECT status FROM darkpool_private.markets;"),
            "OPEN",
          );
          assert.equal(
            await f.sql(
              "SELECT revision FROM darkpool_private.admin_revisions;",
            ),
            "2",
          );
          await assert.rejects(f.sql(marketSql(c, watcher)));
          await assert.rejects(
            f.sql(
              `SELECT darkpool_admin.command('open','{"request_key":"stale","expected_revision":"1"}'::jsonb);`,
            ),
          );
          await assert.rejects(
            f.roleQuery(
              "issue",
              "SELECT darkpool_admin.command('inspect','{}'::jsonb);",
            ),
          );
        },
      );
      const result = await runBounded(
        resolve("target/debug/examples/phase14-claim-fixture.exe"),
        [],
        {
          env: { DARKPOOL_SYNTHETIC_TEST: "1" },
          timeoutMs: 10000,
          maxBytes: 16384,
        },
      );
      assert.equal(boundedExit(result), 0);
      const ua = JSON.parse(result.stdout)[0]; // Stateless synthetic address only.
      const allocations = new Map();
      let calls = 0,
        interrupt = true,
        loseFinish = true;
      const issueQuery = async (s) => {
        const value = await f.roleQuery("issue", s);
        if (s.includes(".finish(") && loseFinish) {
          loseFinish = false;
          throw Error("SYNTHETIC_REPLY_LOST_AFTER_COMMIT");
        }
        return value;
      };
      const allocate = async (r) => {
        calls++;
        if (!allocations.has(r.ticket_id))
          allocations.set(r.ticket_id, {
            ua,
            diversifier: "01".padStart(22, "0"),
          });
        if (interrupt) {
          interrupt = false;
          throw Error("SYNTHETIC_ALLOCATOR_ACK_LOST");
        }
        return allocations.get(r.ticket_id);
      };
      let active = true;
      const runtime = composeUnfundedIssuer({
        issueQuery,
        allocate,
        statusQuery: (s) => f.roleQuery("status", s),
        readMarket: () => f.roleQuery("read", publicMarketQuery),
        verify: async () => {
          if (!active) throw Error("EXPIRED");
        },
        environment: "DISPOSABLE_TEST",
      });
      let browser;
      await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${runtime.server.address().port}`;
      const post = (data) =>
        fetch(base + "/api/issuance", {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
      const token = randomBytes(32).toString("hex");
      const reserve = {
        operation: "reserve",
        issuance_token: token,
        market_id: c.id,
        side: "YES",
        requested_amount_zat: "1000",
      };
      let complete, ticket;
      try {
        await t.test(
          "browser UI warns unfunded; no demo or claim route",
          async () => {
            browser = await launchBrowser();
            await browser.navigate(base + "/");
            assert.match(
              await browser.evaluate(
                "document.querySelector('p[role=\"alert\"]').textContent",
              ),
              /DO NOT PAY/,
            );
            for (const path of ["/api/demo-action", "/api/claim"])
              assert.equal(
                (await fetch(base + path, { method: "POST" })).status,
                404,
              );
          },
        );
        await t.test(
          "concurrent identical reservations and preserved original credential",
          async () => {
            const values = await Promise.all([post(reserve), post(reserve)]);
            assert(values.every((r) => r.status === 200));
            const answers = await Promise.all(values.map((r) => r.json()));
            assert.deepEqual(answers[0], answers[1]);
            ticket = answers[0].ticket_id;
            const secret = randomBytes(32);
            complete = {
              operation: "complete",
              issuance_token: token,
              ticket_id: ticket,
              claim_commitment: deriveClaimCommitment({
                version: 1,
                market_id: c.id,
                ticket_id: ticket,
                claim_secret: secret,
              }),
              claim_commitment_profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1",
            };
            secret.fill(0);
          },
        );
        await t.test(
          "interrupted allocation and finish recover same receiver without duplicates",
          async () => {
            assert.equal((await post(complete)).status, 503);
            assert.equal((await post(complete)).status, 503);
            const r = await post(complete);
            assert.equal(r.status, 200);
            assert.equal((await r.json()).receiving_ua, ua);
            assert.equal((await post(complete)).status, 200);
            assert.equal(allocations.size, 1);
            assert.equal(calls, 2);
            assert.equal(
              await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
              "1",
            );
          },
        );
        await t.test(
          "new/conflicting reservations fail; same request still retries",
          async () => {
            assert.equal(
              (
                await post({
                  ...reserve,
                  issuance_token: randomBytes(32).toString("hex"),
                })
              ).status,
              503,
            );
            assert.equal((await post({ ...reserve, side: "NO" })).status, 503);
            assert.equal((await post(reserve)).status, 200);
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.issuance_attempts;",
              ),
              "1",
            );
          },
        );
        await t.test(
          "private status authenticated and no acceptance/financial authority",
          async () => {
            const r = await fetch(base + "/api/payment-status", {
              method: "POST",
              headers: { Origin: base, "Content-Type": "application/json" },
              body: JSON.stringify({
                market_id: c.id,
                ticket_id: ticket,
                issuance_token: token,
              }),
            });
            assert.equal(r.status, 200);
            assert.deepEqual(await r.json(), {
              status: "AWAITING_PAYMENT",
              environment: "DISPOSABLE_TEST",
              financial_authorization: "NOT_GRANTED",
            });
            await assert.rejects(
              f.roleQuery("issue", "SELECT * FROM darkpool_private.tickets;"),
            );
            await assert.rejects(
              f.roleQuery("status", "SELECT * FROM darkpool_private.tickets;"),
            );
            await assert.rejects(
              f.roleQuery(
                "issue",
                "SELECT darkpool_watcher.reconcile(0,'{}'::jsonb);",
              ),
            );
            await assert.rejects(
              f.sql(
                "UPDATE darkpool_private.tickets SET accepted_amount_zat=1000;",
              ),
            );
            await assert.rejects(
              f.sql("UPDATE darkpool_private.markets SET status='VOID';"),
            );
            assert.equal(
              await f.sql(
                "SELECT count(*) FROM darkpool_private.payment_receipts;",
              ),
              "0",
            );
          },
        );
        await t.test(
          "immutable close survives restart; expiry fails closed without replacing ticket",
          async () => {
            await assert.rejects(
              f.sql(
                "UPDATE darkpool_private.markets SET closes_at=closes_at+interval '1 hour';",
              ),
            );
            active = false;
            assert.equal((await post(complete)).status, 503);
            assert.equal(
              await f.sql("SELECT count(*) FROM darkpool_private.tickets;"),
              "1",
            );
          },
        );
      } finally {
        await browser?.stop();
        await runtime.close();
      }
    });
    console.log(
      "UNFUNDED_INTAKE_DISPOSABLE_CLEANUP_CONFIRMED; NO_WALLET_ACCESS; FINANCIAL_AUTHORIZATION_NOT_GRANTED",
    );
  },
);

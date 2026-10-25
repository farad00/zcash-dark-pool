// Disposable synthetic integration only. No server, wallet or operational adapter.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql } from "../test-fixtures.mjs";
import { migratePayoutAuthorization } from "../payout-authorization-migrations.mjs";
import { provisionScript } from "../admin-provision.mjs";
import { provisionIssuanceScript } from "../issuance-provision.mjs";
import { provisionWatcherScript } from "../watcher-provision.mjs";
import { provisionPublicScript } from "../public-provision.mjs";
import { provisionLockScript } from "../lock-provision.mjs";
import { provisionPublicationScript } from "../publication-provision.mjs";
import {
  provisionResolutionScript,
  registerOracleScript,
} from "../resolution-provision.mjs";
import { provisionClaimsScript } from "../claims-provision.mjs";
import { provisionPayoutPlanningScript } from "../payout-provision.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { createIssuer } from "../../apps/web/src/issuance.mjs";
import { issuanceQuery } from "../issuance-runtime.mjs";
import { createWatcherDb } from "../../services/watcher/db.mjs";
import { openLockSession } from "../../services/lock/db-session.mjs";
import { deriveClaimCommitment } from "../../packages/protocol/src/claim-commitment.ts";
import { fixture, resources } from "./lock-fixtures.mjs";

export { resources };
export function assertSyntheticLifecycle(env = process.env) {
  if (
    !process.env.NODE_TEST_CONTEXT ||
    env.DARKPOOL_LIFECYCLE_TEST_ONLY !== "1" ||
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "55433" ||
    env.PGDATABASE !== "postgres" ||
    env.PGUSER !== "darkpool_test_maintenance" ||
    !env.DARKPOOL_PG_PROFILE ||
    env.DARKPOOL_LIVE_INSTANCE !== undefined ||
    env.WALLET_DB_PATH !== undefined
  )
    throw new Error("SYNTHETIC_LIFECYCLE_ONLY");
}

/** Real SQL only through the existing physical TEST fence, including cleanup.
 * New DB/role identities are checked absent first and retained by OID for cleanup.
 * Owner setup registers pre-OPEN fixture authority/binding, never tickets or state.
 */
export async function withSyntheticLifecycle(
  authority,
  addresses,
  work,
  { oracleClass = "SYNTHETIC_TEST", closeDelaySeconds = 20 } = {},
) {
  assertSyntheticLifecycle();
  assert.ok(
    Number.isInteger(closeDelaySeconds) &&
      closeDelaySeconds >= 20 &&
      closeDelaySeconds <= 600,
  );
  const suffix = randomBytes(8).toString("hex"),
    database = "darkpool_phase9_" + suffix;
  const kinds = [
    "admin",
    "issue",
    "watch",
    "read",
    "lock",
    "publication",
    "oracle",
    "coordinator",
    "claim",
    "planner",
    "reconciler",
    "other",
  ];
  const roles = Object.fromEntries(
    kinds.map((k) => [k, "darkpool_e2e_" + k + "_" + suffix]),
  );
  const passwords = Object.fromEntries(
    kinds.map((k) => [k, randomBytes(32).toString("hex")]),
  );
  const sql = (statement) => psql(statement, { database });
  let created = false,
    rolesCreated = false,
    databaseOid,
    roleOids;
  const env = (kind) => ({
    ...process.env,
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    PGDATABASE: database,
    PGUSER: roles[kind],
    PGPASSWORD: passwords[kind],
    ...(kind === "admin"
      ? { DARKPOOL_ADMIN_INTERNAL: "1" }
      : kind === "issue"
        ? { DARKPOOL_ISSUANCE_INTERNAL: "1" }
        : kind === "watch"
          ? { DARKPOOL_WATCHER_INTERNAL: "1" }
          : kind === "read"
            ? {}
            : { DARKPOOL_LOCK_INTERNAL: "1" }),
  });
  const roleQuery = async (kind, statement) => {
    const session = await openLockSession({
      ...env(kind),
      DARKPOOL_LOCK_INTERNAL: "1",
    });
    try {
      return await session.query(statement);
    } finally {
      await session.close();
    }
  };
  const admin = async (operation, request = {}, kind = "admin") => {
    const result = await runBounded(
      process.execPath,
      ["apps/web/src/admin-cli.mjs"],
      {
        timeoutMs: 15000,
        env: env(kind),
        input: JSON.stringify({ operation, request }),
        maxBytes: 65536,
      },
    );
    assert.equal(result.stderr, "");
    assert.ok(
      [0, 1].includes(boundedExit(result)) &&
        !result.timedOut &&
        !result.spawnFailed,
    );
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(
      await psql(
        `SELECT count(*) FROM pg_database WHERE datname='${database}';`,
        { database: "postgres" },
      ),
      "0",
    );
    assert.equal(
      await psql(
        `SELECT count(*) FROM pg_roles WHERE rolname IN (${Object.values(roles)
          .map((r) => `'${r}'`)
          .join(",")});`,
        { database: "postgres" },
      ),
      "0",
    );
    await psql(
      `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
      { database: "postgres" },
    );
    created = true;
    databaseOid = await psql(
      `SELECT oid::text FROM pg_database WHERE datname='${database}';`,
      { database: "postgres" },
    );
    await psql(
      "BEGIN;" +
        kinds
          .map(
            (k) =>
              `CREATE ROLE "${roles[k]}" LOGIN NOINHERIT PASSWORD '${passwords[k]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
          )
          .join("\n") +
        "COMMIT;",
      { database: "postgres" },
    );
    rolesCreated = true;
    roleOids = await psql(
      `SELECT rolname,oid FROM pg_roles WHERE rolname IN (${Object.values(roles)
        .map((r) => `'${r}'`)
        .join(",")}) ORDER BY rolname;`,
      { database: "postgres" },
    );
    await migratePayoutAuthorization(database); // Existing ordered 0001–0013 loader.
    await sql(provisionScript(roles.admin));
    await sql(provisionIssuanceScript(roles.issue));
    await sql(provisionWatcherScript(roles.watch));
    await sql(provisionPublicScript(roles.read));
    await sql(provisionLockScript(roles.lock));
    await sql(
      provisionPublicationScript(roles.publication, database, authority.trust),
    );
    await sql(provisionResolutionScript(roles.oracle, roles.coordinator));
    const f = fixture(Math.floor(Date.now() / 1000) + closeDelaySeconds, 3);
    const mid = "synthetic-lifecycle-" + suffix;
    f.request.market_id = mid;
    const observation = new Date(f.close * 1000)
      .toISOString()
      .replace(".000Z", ".000000Z");
    const rule = {
      question: "Synthetic objective lifecycle",
      yes_definition: "Gauge at least ten",
      no_definition: "Gauge below ten",
      resolution_rule: `Observe synthetic-source at ${observation}; YES if gauge >= 10; NO otherwise; VOID when ambiguous.`,
      resolution_sources: ["synthetic-source"],
      void_conditions: ["Ambiguous synthetic observation"],
      rule_version: "synthetic-lifecycle-rule-v1",
    };
    const configuration = {
      id: mid,
      network: "testnet",
      vault_context_ref: "synthetic-vault",
      ...rule,
      opens_at: new Date((f.close - 7200) * 1000).toISOString(),
      closes_at: new Date(f.close * 1000).toISOString(),
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
    };
    delete configuration.rule_version;
    // Planner scope is provisioned after creation, since it binds the market FK.
    const tickets = [],
      allocations = new Map(),
      issuanceStatements = [];
    const issue = createIssuer({
      query: (statement) => {
        issuanceStatements.push(statement);
        return issuanceQuery(statement, env("issue"));
      },
      allocate: async (context) => {
        if (allocations.has(context.ticket_id))
          return allocations.get(context.ticket_id);
        assert.equal(context.market_id, mid);
        assert.equal(context.vault_context_ref, "synthetic-vault");
        assert.ok(allocations.size < 3);
        const value = {
          ua: addresses[allocations.size],
          diversifier: (allocations.size + 1).toString(16).padStart(22, "0"),
        };
        allocations.set(context.ticket_id, value);
        return value;
      },
    });
    const createTicket = async (side, amount) => {
      const token = randomBytes(32).toString("hex"),
        secret = new Uint8Array(randomBytes(32));
      const reserve = {
        operation: "reserve",
        issuance_token: token,
        market_id: mid,
        side,
        requested_amount_zat: amount,
      };
      const pending = await issue(reserve);
      assert.deepEqual(await issue(reserve), pending);
      const complete = {
        operation: "complete",
        issuance_token: token,
        ticket_id: pending.ticket_id,
        claim_commitment: deriveClaimCommitment({
          version: 1,
          market_id: mid,
          ticket_id: pending.ticket_id,
          claim_secret: secret,
        }),
        claim_commitment_profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1",
      };
      const issued = await issue(complete);
      assert.equal(issued.status, "ISSUED");
      assert.deepEqual(await issue(complete), issued);
      const ticket = {
        id: pending.ticket_id,
        side,
        amount,
        secret,
        complete,
        issued,
        index: tickets.length,
      };
      tickets.push(ticket);
      return ticket;
    };
    await work({
      ...f,
      mid,
      database,
      roles,
      env,
      sql,
      roleQuery,
      admin,
      rule,
      configuration,
      observation,
      oracleClass,
      tickets,
      issue,
      createTicket,
      issuanceStatements,
      watcher: createWatcherDb(env("watch")),
      register: async () => {
        await sql(provisionClaimsScript(roles.claim, mid, "SYNTHETIC_TEST"));
        await sql(
          `INSERT INTO darkpool_private.watcher_state VALUES('${mid}','phase9-exact-chainclock-3-v1','${f.request.account_ref}','https://testnet.zec.rocks:443',100,decode('${f.request.chain.anchor_hash}','hex'),to_timestamp(${f.close}),0,NULL,NULL,now());`,
        );
        await sql(
          registerOracleScript({
            market_id: mid,
            oracle_login: roles.oracle,
            coordinator_login: roles.coordinator,
            actor_ref: "synthetic_operator",
            execution_class: oracleClass,
            rule,
            observation_at: observation,
            resources: {
              ...resources,
              max_tickets: resources.max_tickets.toString(),
              max_total_zat: ((1n << 128n) - 1n).toString(),
              max_numerator_zat_squared: ((1n << 256n) - 1n).toString(),
            },
          }),
        );
        await sql(
          provisionPayoutPlanningScript(roles.planner, roles.reconciler, {
            market_id: mid,
            execution_class: "SYNTHETIC_TEST",
            external_funding_ref: "synthetic_external_reserve",
            planning_fee_budget_zat: "1500",
            per_intent_fee_ceiling_zat: "500",
          }),
        );
      },
      payment: () => ({
        ...structuredClone(f.request),
        outputs: f.request.outputs.slice(0, tickets.length).map((output, i) => {
          // Both the in-process and TCP fixture allocate these same synthetic
          // address/diversifier pairs. Completion order need not equal allocation order.
          const index = addresses.indexOf(tickets[i].issued.receiving_ua);
          assert(index >= 0 && index < 3);
          return {
            ...output,
            ticket_id: tickets[i].id,
            amount_zat: tickets[i].amount,
            receiver_ref: addresses[index],
            diversifier_ref: `external:${(index + 1).toString(16).padStart(22, "0")}`,
            journal_commitment: tickets[i].complete.claim_commitment,
          };
        }),
      }),
      lockRequest: { ...f.lockRequest, market_id: mid, expected_revision: "2" },
    });
    for (const ticket of tickets) ticket.secret.fill(0);
  } finally {
    if (created) {
      assert.match(database, /^darkpool_phase9_[a-f0-9]{16}$/);
      assert.equal(
        await psql(
          `SELECT oid::text FROM pg_database WHERE datname='${database}';`,
          { database: "postgres" },
        ),
        databaseOid,
        "cleanup DB identity",
      );
      await psql(`DROP DATABASE "${database}";`, { database: "postgres" });
    }
    if (rolesCreated) {
      assert.equal(
        await psql(
          `SELECT rolname,oid FROM pg_roles WHERE rolname IN (${Object.values(
            roles,
          )
            .map((r) => `'${r}'`)
            .join(",")}) ORDER BY rolname;`,
          { database: "postgres" },
        ),
        roleOids,
        "cleanup role identities",
      );
      await psql(
        "BEGIN;" +
          Object.values(roles)
            .map((r) => `DROP ROLE "${r}";`)
            .join("\n") +
          "COMMIT;",
        { database: "postgres" },
      );
    }
  }
}

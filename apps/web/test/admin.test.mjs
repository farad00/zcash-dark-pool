import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrate, psql } from "../../../db/test-fixtures.mjs";
import { provisionScript } from "../../../db/admin-provision.mjs";
import {
  requireInternalEnvironment,
  parseCommand,
  runtimePrivilegeCheck,
} from "../src/admin.mjs";

const suffix = randomBytes(8).toString("hex");
const database = `darkpool_phase4_${suffix}`;
const operator = `darkpool_admin_${suffix}`;
const password = randomBytes(32).toString("hex");
const options = { database };
const maintenance = process.env.PGDATABASE;
let created = false;
let roleCreated = false;
const sql = (query) => psql(query, options);
const lit = (value) => `'${value.replaceAll("'", "''")}'`;
const wire = (value) =>
  `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("hex")}','hex'),'UTF8')::jsonb`;
const commandSql = (op, request = {}) => `SET ROLE "${operator}";
 SELECT darkpool_admin.command(${lit(op)},${wire(request)});`;
const run = async (op, request = {}) =>
  JSON.parse(await sql(commandSql(op, request)));
const expectFailure = (query, state) =>
  assert.rejects(sql(query), (error) => error.sqlstate === state);
// SET ROLE from maintenance exercises grants; real login tests prove escalation denial.
async function authenticatedSql(query) {
  const savedUser = process.env.PGUSER;
  const savedPassword = process.env.PGPASSWORD;
  try {
    process.env.PGUSER = operator;
    process.env.PGPASSWORD = password;
    return await sql(query);
  } finally {
    process.env.PGUSER = savedUser;
    process.env.PGPASSWORD = savedPassword;
  }
}

// Synthetic draft fields and explicit UNPINNED references, never a demo policy.
const configuration = {
  id: "phase4-synthetic-market",
  network: "testnet",
  vault_context_ref: "synthetic-private-vault",
  question: "Synthetic objective proposition",
  yes_definition: "Condition is met",
  no_definition: "Condition is not met",
  opens_at: "2026-10-04T00:00:00.000Z",
  closes_at: "2026-10-05T00:00:00.000Z",
  close_policy_ref: "unreviewed",
  resolution_rule: "Synthetic rule requiring human source review",
  resolution_sources: ["Synthetic primary source"],
  void_conditions: ["Synthetic ambiguity"],
  min_stake_zat: "1",
  max_stake_zat: "9007199254740993",
  payment_policy_ref: "unreviewed",
  fee_policy_ref: "unreviewed",
  zero_winner_policy: "NO_WINNER_REFUND",
  deposit_confirmations: null,
  payout_confirmations: null,
};
const request = (key, config = configuration, revision = null) => ({
  request_key: key,
  expected_revision: revision,
  configuration: config,
});
const marketKeys = [
  "id",
  "version",
  "network",
  "question",
  "yes_definition",
  "no_definition",
  "opens_at",
  "closes_at",
  "resolution_rule",
  "resolution_sources",
  "void_conditions",
  "min_stake_zat",
  "max_stake_zat",
  "zero_winner_policy",
  "deposit_confirmations",
  "payout_confirmations",
  "status",
  "revision",
  "policy_status",
  "receiving_policy_ref",
  "close_proof_policy_ref",
  "payout_policy_ref",
  "payout_policy_state",
  "payout_ready",
].sort();

// Normal admin OPEN, isolated from the retained evidence database and wallet.
const intakeConfiguration = (changes = {}) => {
  const now = Date.now();
  return {
    ...configuration,
    id: "phase9-open-synthetic-market",
    opens_at: new Date(now).toISOString(),
    closes_at: new Date(now + 3600000).toISOString(),
    close_policy_ref: "phase9-exact-chainclock-3-v1",
    payment_policy_ref: "phase9-exact-chainclock-3-v1",
    fee_policy_ref: "phase9-zero-platform-fee-v1",
    deposit_confirmations: 3,
    payout_confirmations: null,
    receiving_policy_ref: "phase9-orchard-receiving-v1",
    close_proof_policy_ref: "phase9-bounded-close-proof-v2",
    payout_policy_ref: "phase9-payout-deferred-v1",
    ...changes,
  };
};
const openRequest = (key = "open-one", revision = "1") => ({
  request_key: key,
  expected_revision: revision,
});
async function withOpenDraft(
  check,
  {
    changes = {},
    binding = true,
    create = true,
    endpoint = "https://testnet.zec.rocks:443",
  } = {},
) {
  const fresh = `darkpool_phase4_open_${randomBytes(8).toString("hex")}`;
  assert.match(fresh, /^darkpool_phase4_open_[a-f0-9]{16}$/);
  await psql(`CREATE DATABASE "${fresh}" TEMPLATE template0 ENCODING 'UTF8';`, {
    database: maintenance,
  });
  try {
    await migrate({ database: fresh });
    const q = (query) => psql(query, { database: fresh });
    await q(provisionScript(operator));
    await q(
      "INSERT INTO darkpool_private.policy_refs VALUES ('open-test-unsupported','PINNED',NULL,'SYNTHETIC unsupported intake policy'),('phase9-platform-fee-1-v1','PINNED',NULL,'SYNTHETIC unsupported nonzero fee');",
    );
    const config = intakeConfiguration(changes);
    const call = (operation, body = {}) =>
      cli({ operation, request: body }, { PGDATABASE: fresh });
    const runFresh = async (operation, body = {}) =>
      JSON.parse(await q(commandSql(operation, body)));
    const state = async () =>
      JSON.parse(
        await q(`SELECT jsonb_build_object(
      'market',(SELECT to_jsonb(m) FROM darkpool_private.markets m),
      'revisions',(SELECT jsonb_agg(to_jsonb(r)) FROM darkpool_private.admin_revisions r),
      'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM darkpool_private.audit_events a),
      'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_key) FROM darkpool_private.admin_requests r));`),
      );
    if (create) {
      const made = await call("create", request("fresh-create", config));
      assert.equal(made.code, 0, made.output);
      assert.equal(JSON.parse(made.output).control.market.status, "DRAFT");
      if (binding) {
        // Deterministic SQL-only pre-OPEN provisioning fixture; no wallet/chain work.
        await q(`INSERT INTO darkpool_private.watcher_state VALUES (
          ${lit(config.id)},'phase9-exact-chainclock-3-v1','00000000-0000-0000-0000-000000000001',
          ${lit(endpoint)},100,decode(repeat('01',32),'hex'),${lit(config.closes_at)}::timestamptz,0,NULL,NULL,clock_timestamp());`);
      }
    }
    await check({ q, call, run: runFresh, state, config, fresh });
  } finally {
    assert.match(fresh, /^darkpool_phase4_open_[a-f0-9]{16}$/);
    await psql(`DROP DATABASE "${fresh}";`, { database: maintenance });
  }
}

function cli(input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    for (const key of ["PGOPTIONS", "PGSERVICE", "PGSERVICEFILE"])
      delete cleanEnv[key];
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/admin-cli.mjs", import.meta.url))],
      {
        env: {
          ...cleanEnv,
          APP_ENV: "development",
          DARKPOOL_ADMIN_INTERNAL: "1",
          ZCASH_NETWORK: "testnet",
          PGDATABASE: database,
          PGUSER: operator,
          PGPASSWORD: password,
          ...extraEnv,
        },
        windowsHide: true,
      },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("test CLI could not start")));
    child.on("close", (code) => resolve({ code, output, error }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

before(async () => {
  assert.ok(maintenance);
  assert.match(database, /^darkpool_phase4_[a-f0-9]{16}$/);
  await psql(
    `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
    { database: maintenance },
  );
  created = true;
  await migrate(options);
  await psql(
    `CREATE ROLE "${operator}" LOGIN PASSWORD '${password}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    { database: maintenance },
  );
  roleCreated = true;
  await sql(provisionScript(operator));
  await sql(
    "INSERT INTO darkpool_private.policy_refs VALUES ('unreviewed','UNPINNED','TEST ONLY unresolved',NULL),('synthetic-pinned','PINNED',NULL,'TEST ONLY not an approved policy');",
  );
});
after(async () => {
  if (created) {
    assert.match(database, /^darkpool_phase4_[a-f0-9]{16}$/);
    await psql(`DROP DATABASE "${database}";`, { database: maintenance });
  }
  if (roleCreated) {
    assert.match(operator, /^darkpool_admin_[a-f0-9]{16}$/);
    await psql(`DROP ROLE "${operator}";`, { database: maintenance });
  }
});

test("Phase 9 OPEN: fresh 0001-0007 database -> normal create/validate/OPEN CLI; no tickets or payouts", async () => {
  await withOpenDraft(async (f) => {
    assert.equal(
      await f.q("SELECT count(*) FROM darkpool_migrations.applied;"),
      "7",
    );
    const beforeAvailability = await f.state();
    assert.equal((await f.run("open")).result, "BLOCKED");
    assert.deepEqual(await f.state(), beforeAvailability);
    const validation = await f.call("validate", { configuration: f.config });
    assert.equal(validation.code, 0);
    assert.equal(JSON.parse(validation.output).opening, "READY");
    const opened = await f.call("open", openRequest());
    assert.equal(opened.code, 0, opened.output);
    assert.equal(opened.error, "");
    const view = JSON.parse(opened.output).control;
    assert.equal(view.market.status, "OPEN");
    assert.equal(view.market.revision, "2");
    assert.equal(view.market.deposit_confirmations, 3);
    assert.equal(view.market.payout_confirmations, null);
    assert.equal(
      view.market.payout_policy_state,
      "DEFERRED_NOT_REQUIRED_FOR_OPEN",
    );
    assert.equal(view.market.payout_ready, false);
    assert.equal(view.availability.payout.result, "BLOCKED");
    assert.equal(view.availability.reopen.result, "BLOCKED");
    assert.equal(
      await f.q(
        "SELECT (SELECT count(*) FROM darkpool_private.tickets)+(SELECT count(*) FROM darkpool_private.issuance_attempts)+(SELECT count(*) FROM darkpool_private.payment_receipts)+(SELECT count(*) FROM darkpool_private.accepted_payments);",
      ),
      "0",
    );
    assert.equal(
      await f.q(
        "SELECT fee_policy_ref='phase9-zero-platform-fee-v1' AND closes_at-opens_at=interval '1 hour' FROM darkpool_private.markets;",
      ),
      "t",
    );
    const audit = JSON.parse(
      await f.q(
        "SELECT to_jsonb(a) FROM darkpool_private.audit_events a WHERE event='MARKET_OPENED';",
      ),
    );
    assert.equal(audit.source, operator);
    assert.equal(audit.prior_state, "DRAFT");
    assert.equal(audit.new_state, "OPEN");
    assert.equal(audit.trigger_ref, "open-one");
    assert.equal(audit.chain_ref, `profile:${f.config.id}`);
    assert.ok(Number.isFinite(Date.parse(audit.timestamp)));
    await expectFailureFor(
      f,
      "UPDATE darkpool_private.markets SET closes_at=closes_at+interval '1 hour'",
      "23514",
    );
    for (const operation of ["pause", "reopen", "finalize-lock", "resolve"])
      assert.equal((await f.run(operation)).result, "BLOCKED");
    for (const operation of ["pay", "payout", "settle", "claim", "refund"])
      await assert.rejects(f.run(operation), (e) => e.sqlstate === "P4001");
    await assert.rejects(
      f.run("create", request("second", { ...f.config, id: "second-market" })),
      (e) => e.sqlstate === "P4002",
    );
    await f.q("UPDATE darkpool_private.markets SET status='CLOSED';");
    await assert.rejects(
      f.run(
        "create",
        request("after-closed", { ...f.config, id: "second-market" }),
      ),
      (e) => e.sqlstate === "P4002",
    );
  });
});

async function expectFailureFor(f, query, state) {
  await assert.rejects(f.q(query), (e) => e.sqlstate === state);
}

test("Phase 9 OPEN: same-key replay, changed retry, stale revision and non-DRAFT fail closed", async () => {
  await withOpenDraft(async (f) => {
    const before = await f.state();
    await assert.rejects(
      f.run("open", openRequest("stale", "9")),
      (e) => e.sqlstate === "P4003",
    );
    assert.deepEqual(await f.state(), before);
    const opened = await f.run("open", openRequest());
    const once = await f.state();
    assert.deepEqual(await f.run("open", openRequest()), opened);
    assert.deepEqual(await f.state(), once);
    await assert.rejects(
      f.run("open", openRequest("open-one", "2")),
      (e) => e.sqlstate === "P4003",
    );
    await assert.rejects(
      f.run("open", openRequest("new-key", "2")),
      (e) => e.sqlstate === "P4005",
    );
    assert.deepEqual(await f.state(), once);
  });
});

test("Phase 9 OPEN: concurrent different keys serialize one transition; same-key replay audits once", async () => {
  await withOpenDraft(async (f) => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        f.run("open", openRequest(`race-${i}`)),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((r) => r.status === "rejected"))
      assert.equal(r.reason.sqlstate, "P4003");
    const winner = results.findIndex((r) => r.status === "fulfilled");
    for (const result of await Promise.all(
      Array.from({ length: 4 }, () =>
        f.run("open", openRequest(`race-${winner}`)),
      ),
    ))
      assert.deepEqual(result, results[winner].value);
    assert.equal(
      await f.q(
        "SELECT count(*) FROM darkpool_private.audit_events WHERE event='MARKET_OPENED';",
      ),
      "1",
    );
  });
});

test("Phase 9 OPEN: expired window, missing watcher binding, hold and unsupported labels reject without writes", async () => {
  const variants = [
    {
      changes: {
        opens_at: new Date(Date.now() - 120000).toISOString(),
        closes_at: new Date(Date.now() - 60000).toISOString(),
      },
    },
    { binding: false },
    { endpoint: "https://unsupported.invalid:443" },
    { changes: { close_policy_ref: "open-test-unsupported" } },
    { changes: { payment_policy_ref: "open-test-unsupported" } },
    { changes: { deposit_confirmations: 2 } },
    { changes: { receiving_policy_ref: "open-test-unsupported" } },
    { changes: { close_proof_policy_ref: "open-test-unsupported" } },
    {
      change:
        "DELETE FROM darkpool_private.market_policy_refs WHERE purpose='receiving';",
    },
    { change: "UPDATE darkpool_private.markets SET status='PAUSED';" },
    {
      change:
        "INSERT INTO darkpool_private.watcher_evidence VALUES('hold-fixture','phase9-open-synthetic-market','HOLD',NULL,NULL,NULL,NULL,'{}',clock_timestamp()); UPDATE darkpool_private.watcher_state SET hold_ref='hold-fixture',revision=revision+1;",
    },
  ];
  for (const variant of variants)
    await withOpenDraft(async (f) => {
      if (variant.change) await f.q(variant.change);
      const before = await f.state();
      await assert.rejects(
        f.run("open", openRequest()),
        (e) => e.sqlstate === "P4005",
      );
      assert.deepEqual(await f.state(), before);
    }, variant);
});

test("Phase 9 OPEN: only zero-fee label is accepted; nonzero, unknown, missing and malformed fee reject", async () => {
  for (const fee of ["open-test-unsupported", "phase9-platform-fee-1-v1"])
    await withOpenDraft(
      async (f) => {
        const before = await f.state();
        await assert.rejects(
          f.run("open", openRequest()),
          (e) => e.sqlstate === "P4005",
        );
        assert.deepEqual(await f.state(), before);
      },
      { changes: { fee_policy_ref: fee } },
    );
  await withOpenDraft(
    async (f) => {
      for (const modification of [
        { fee_policy_ref: "unknown-fee" },
        { fee_policy_ref: { platform_fee: 1 } },
        { platform_fee: 1 },
        { network_fee_zat: "1" },
        { fee_policy_ref: "" },
      ]) {
        const before = await f.state();
        const result = await f.call(
          "create",
          request("bad-fee", { ...f.config, ...modification }),
        );
        assert.equal(result.code, 1);
        assert.deepEqual(await f.state(), before);
      }
      const missing = { ...f.config };
      delete missing.fee_policy_ref;
      assert.equal(
        (await f.call("create", request("missing-fee", missing))).code,
        1,
      );
    },
    { create: false },
  );
});

test("Phase 9 OPEN: explicit payout deferral required; numeric or fake reviewed payout never implies readiness", async () => {
  for (const changes of [
    { payout_confirmations: 3 },
    { payout_policy_ref: "open-test-unsupported" },
  ])
    await withOpenDraft(
      async (f) => {
        const before = await f.state();
        await assert.rejects(
          f.run("open", openRequest()),
          (e) => e.sqlstate === "P4005",
        );
        assert.deepEqual(await f.state(), before);
      },
      { changes },
    );
  await withOpenDraft(async (f) => {
    for (const table of [
      "claims",
      "refunds",
      "settlements",
      "settlement_items",
    ])
      await expectFailureFor(
        f,
        `SET ROLE "${operator}"; INSERT INTO darkpool_private.${table} DEFAULT VALUES;`,
        "42501",
      );
    for (const helper of [
      "validate_open('{}'::jsonb)",
      "open_configuration(NULL::darkpool_private.markets)",
    ])
      await expectFailureFor(
        f,
        `SET ROLE "${operator}"; SELECT darkpool_admin.${helper};`,
        "42501",
      );
    await expectFailureFor(
      f,
      `SET ROLE "${operator}"; UPDATE darkpool_private.markets SET status='OPEN';`,
      "42501",
    );
    const response = await f.run("open", openRequest());
    assert.equal(response.control.market.payout_confirmations, null);
    assert.equal(response.control.market.payout_ready, false);
    assert.equal(
      await f.q(
        "SELECT count(*) FROM darkpool_private.policy_refs WHERE id='phase9-zero-platform-fee-v1' AND status='PINNED';",
      ),
      "1",
    );
  });
});

test("Phase 9 OPEN: invalid identity/binary/window and incomplete explicit profiles fail before draft writes", async () => {
  await withOpenDraft(
    async (f) => {
      for (const changes of [
        { id: " " },
        { yes_definition: f.config.no_definition },
        { opens_at: f.config.closes_at },
        { opens_at: "not-an-instant" },
      ]) {
        assert.equal(
          (
            await f.call(
              "create",
              request("bad-config", { ...f.config, ...changes }),
            )
          ).code,
          1,
        );
      }
      for (const field of [
        "receiving_policy_ref",
        "close_proof_policy_ref",
        "payout_policy_ref",
      ]) {
        const config = { ...f.config };
        delete config[field];
        assert.equal(
          (await f.call("create", request("missing-label", config))).code,
          1,
        );
      }
      assert.equal(
        await f.q("SELECT count(*) FROM darkpool_private.markets;"),
        "0",
      );
      assert.equal(
        await f.q("SELECT count(*) FROM darkpool_private.audit_events;"),
        "0",
      );
    },
    { create: false },
  );
});

test("Phase 9 OPEN: injected audit failure rolls back transition, revision and replay record", async () => {
  await withOpenDraft(async (f) => {
    await f.q(
      "CREATE FUNCTION darkpool_private.open_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='MARKET_OPENED' THEN RAISE EXCEPTION USING ERRCODE='P4001',MESSAGE='synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER open_test_failure BEFORE INSERT ON darkpool_private.audit_events FOR EACH ROW EXECUTE FUNCTION darkpool_private.open_test_failure();",
    );
    const before = await f.state();
    await assert.rejects(
      f.run("open", openRequest()),
      (e) => e.sqlstate === "P4001",
    );
    assert.deepEqual(await f.state(), before);
    await f.q(
      "DROP TRIGGER open_test_failure ON darkpool_private.audit_events;",
    );
    assert.equal(
      (await f.run("open", openRequest())).control.market.status,
      "OPEN",
    );
  });
});

test("SEC07/12 Phase 4: internal environment, bounded input and owner credentials fail closed", async () => {
  assert.equal(await sql(runtimePrivilegeCheck), "f");
  assert.equal(await authenticatedSql(runtimePrivilegeCheck), "t");
  const valid = {
    APP_ENV: "development",
    DARKPOOL_ADMIN_INTERNAL: "1",
    ZCASH_NETWORK: "testnet",
    PGHOST: "127.0.0.1",
    PGPORT: "55432",
    PGUSER: "restricted",
    PGDATABASE: "product",
  };
  assert.doesNotThrow(() => requireInternalEnvironment(valid));
  for (const [field, value] of [
    ["APP_ENV", "production"],
    ["DARKPOOL_ADMIN_INTERNAL", undefined],
    ["ZCASH_NETWORK", "mainnet"],
    ["PGHOST", "0.0.0.0"],
    ["PGPORT", "0"],
    ["PGPORT", "65536"],
    ["PGDATABASE", "postgresql://credential@host/db"],
    ["PGUSER", ""],
    ["PGOPTIONS", "-c role=owner"],
    ["PGSERVICE", "service"],
    ["PGSERVICEFILE", "private"],
  ])
    assert.throws(() =>
      requireInternalEnvironment({ ...valid, [field]: value }),
    );
  for (const value of [
    "null",
    "[]",
    "{}",
    "bad",
    " ".repeat(65537),
    JSON.stringify({
      operation: "inspect",
      request: {},
      claim_secret: "synthetic-secret",
    }),
    JSON.stringify({ operation: "lock-now", request: {} }),
  ])
    assert.throws(() => parseCommand(value));
  const production = await cli(
    { operation: "inspect", request: {} },
    { APP_ENV: "production" },
  );
  assert.equal(production.code, 1);
  assert.deepEqual(JSON.parse(production.output), {
    result: "REJECTED",
    code: "INTERNAL_DEVELOPMENT_ONLY",
  });
  const owner = await cli(
    { operation: "inspect", request: {} },
    { PGUSER: process.env.PGUSER, PGPASSWORD: process.env.PGPASSWORD },
  );
  assert.equal(owner.code, 1);
  assert.equal(
    JSON.parse(owner.output).code,
    "RESTRICTED_LOGIN_REQUIRED",
    owner.output,
  );
  assert.equal(owner.error, "");
  await expectFailure(provisionScript(process.env.PGUSER), "42501");
});

test("U07/SM02 Phase 4: invalid draft configuration fails via direct admin DB entrypoint", async () => {
  assert.equal(
    (await run("validate", { configuration })).result,
    "VALID_DRAFT",
  );
  const variants = [
    { question: "" },
    { yes_definition: configuration.no_definition },
    { network: "mainnet" },
    { resolution_sources: [] },
    { resolution_sources: [null] },
    { void_conditions: [""] },
    { closes_at: configuration.opens_at },
    { opens_at: "2026-02-30T00:00:00.000Z" },
    { opens_at: "2026-10-04T00:00:00+01:00" },
    { min_stake_zat: "1.5" },
    { max_stake_zat: 9007199254740992 },
    { min_stake_zat: "9007199254740994" },
    { min_stake_zat: "-1" },
    { min_stake_zat: "NaN" },
    { min_stake_zat: "1e2" },
    { max_stake_zat: "9".repeat(1025) },
    { deposit_confirmations: 1.5 },
    { payout_confirmations: -1 },
    { close_policy_ref: "missing" },
    { zero_winner_policy: "operator-award" },
    { claim_secret: "synthetic-secret" },
    { side: "YES" },
    { status: "OPEN" },
  ];
  for (let index = 0; index < variants.length; index++) {
    await expectFailure(
      commandSql(
        "create",
        request(`invalid-${index}`, { ...configuration, ...variants[index] }),
      ),
      "P4001",
    );
  }
  const missing = { ...configuration };
  delete missing.fee_policy_ref;
  await expectFailure(
    commandSql("validate", { configuration: missing }),
    "P4001",
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.markets;"),
    "0",
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.audit_events;"),
    "0",
  );
});

test("Phase 4: concurrent create enforces one market; identical retry audits once and changed retry rejects", async () => {
  const same = request("create-one");
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () => run("create", same)),
  );
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 8);
  for (const result of outcomes)
    assert.deepEqual(result.value, outcomes[0].value);
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.markets;"),
    "1",
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.audit_events;"),
    "1",
  );
  const conflicts = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      run(
        "create",
        request(`second-${i}`, { ...configuration, id: `other-${i}` }),
      ),
    ),
  );
  for (const result of conflicts) assert.equal(result.reason.sqlstate, "P4002");
  await expectFailure(
    commandSql(
      "create",
      request("create-one", { ...configuration, question: "changed retry" }),
    ),
    "P4003",
  );
  const state = await run("inspect");
  assert.deepEqual(Object.keys(state.market).sort(), marketKeys);
  assert.equal(state.market.max_stake_zat, "9007199254740993");
  assert.equal(state.market.deposit_confirmations, null);
  assert.deepEqual(state.market.policy_status, {
    close: "UNPINNED",
    payment: "UNPINNED",
    fee: "UNPINNED",
  });
});

test("SM02/07 Phase 4: draft revisions serialize edits; rollback, replay and append-only audit", async () => {
  const config = { ...configuration, question: "Edited synthetic proposition" };
  const updates = await Promise.allSettled([
    run("edit", request("edit-one", config, "1")),
    run(
      "edit",
      request("edit-other", { ...config, question: "Competing edit" }, "1"),
    ),
  ]);
  assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    updates.find((r) => r.status === "rejected").reason.sqlstate,
    "P4003",
  );
  const winnerIndex = updates.findIndex((r) => r.status === "fulfilled");
  const winnerRequest =
    winnerIndex === 0
      ? request("edit-one", config, "1")
      : request("edit-other", { ...config, question: "Competing edit" }, "1");
  assert.deepEqual(
    await run("edit", winnerRequest),
    updates[winnerIndex].value,
  );
  assert.equal((await run("inspect")).market.revision, "2");
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.audit_events;"),
    "2",
  );
  const audit = JSON.parse(
    await sql(
      "SELECT json_agg(json_build_object('event',event,'source',source,'trigger',trigger_ref,'time',timestamp,'prior',prior_state,'new',new_state,'chain',chain_ref) ORDER BY timestamp) FROM darkpool_private.audit_events;",
    ),
  );
  assert.deepEqual(
    audit.map((r) => r.event),
    ["MARKET_CREATED", "MARKET_DRAFT_UPDATED"],
  );
  assert.ok(
    audit.every(
      (r) =>
        r.source === process.env.PGUSER &&
        r.time &&
        r.prior === null &&
        r.new === null &&
        r.chain === null,
    ),
  );
  // SET ROLE fixtures authenticate as maintenance; actual CLI actor is the runtime login.
  await expectFailure(
    "UPDATE darkpool_private.audit_events SET source='replacement';",
    "23514",
  );
  await expectFailure("DELETE FROM darkpool_private.admin_requests;", "23514");
  await expectFailure("TRUNCATE darkpool_private.admin_requests;", "23514");
  await sql(
    `BEGIN; ${commandSql("edit", request("rolled-back", { ...configuration, question: "Rollback test" }, "2"))} ROLLBACK;`,
  );
  assert.equal((await run("inspect")).market.revision, "2");
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.admin_requests WHERE request_key='rolled-back';",
    ),
    "0",
  );
  const authenticated = await cli({
    operation: "edit",
    request: request("authenticated-edit", configuration, "2"),
  });
  assert.equal(authenticated.code, 0);
  assert.equal(authenticated.error, "");
  assert.equal(JSON.parse(authenticated.output).control.market.revision, "3");
  assert.equal(
    await sql(
      "SELECT source FROM darkpool_private.audit_events WHERE trigger_ref='authenticated-edit';",
    ),
    operator,
  );
});

test("SM01/04/05/06: unsupported lifecycle operations stay blocked; labels alone cannot OPEN", async () => {
  await sql(
    "UPDATE darkpool_private.markets SET close_policy_ref='synthetic-pinned',payment_policy_ref='synthetic-pinned',fee_policy_ref='synthetic-pinned',deposit_confirmations=0,payout_confirmations=0;",
  );
  const initial = await sql(
    "SELECT row_to_json(m) FROM darkpool_private.markets m;",
  );
  const audits = await sql(
    "SELECT count(*) FROM darkpool_private.audit_events;",
  );
  await expectFailure(
    commandSql("open", {
      request_key: "unreviewed-open",
      expected_revision: "3",
    }),
    "P4005",
  );
  for (const op of ["pause", "reopen", "finalize-lock", "resolve"]) {
    const result = await run(op);
    assert.equal(result.result, "BLOCKED");
    assert.equal(result.operation, op);
    assert.ok(result.requires.length > 0);
    const attempt = await cli({ operation: op, request: {} });
    assert.equal(attempt.code, 1);
    assert.equal(JSON.parse(attempt.output).result, "BLOCKED");
    assert.equal(attempt.error, "");
    await expectFailure(
      commandSql(op, { status: "LOCKED", force: true }),
      "P4001",
    );
  }
  for (const op of [
    "lock",
    "lock-now",
    "set-status",
    "pay",
    "refund",
    "policy-pin",
  ])
    await expectFailure(commandSql(op, {}), "P4001");
  assert.equal(
    await sql("SELECT row_to_json(m) FROM darkpool_private.markets m;"),
    initial,
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.audit_events;"),
    audits,
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.ledger_sets;"),
    "0",
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.resolutions;"),
    "0",
  );
});

test("SM02 Phase 4: every economic field is frozen after OPEN through admin and existing DB guards", async () => {
  // Trusted owner fixture simulates later lifecycle state; never an admin OPEN.
  await sql("UPDATE darkpool_private.markets SET status='OPEN';");
  for (const [field, value] of Object.entries(configuration)) {
    const changed =
      typeof value === "string"
        ? value + "-changed"
        : Array.isArray(value)
          ? [...value, "changed"]
          : 1;
    if (field !== "id")
      await expectFailure(
        commandSql(
          "edit",
          request(
            `frozen-${field}`,
            { ...configuration, [field]: changed },
            "2",
          ),
        ),
        [
          "network",
          "zero_winner_policy",
          "opens_at",
          "closes_at",
          "min_stake_zat",
          "max_stake_zat",
          "close_policy_ref",
          "fee_policy_ref",
          "payment_policy_ref",
        ].includes(field)
          ? "P4001"
          : "P4004",
      );
  }
  for (const assignment of [
    "question='changed'",
    "yes_definition='changed'",
    "no_definition='changed'",
    "opens_at=opens_at-interval '1 hour'",
    "closes_at=closes_at+interval '1 hour'",
    "closes_at=closes_at-interval '1 hour'",
    "resolution_rule='changed'",
    "resolution_sources=ARRAY['changed']",
    "void_conditions=ARRAY['changed']",
    "min_stake_zat=0",
    "max_stake_zat=2",
    "close_policy_ref='unreviewed'",
    "payment_policy_ref='unreviewed'",
    "fee_policy_ref='unreviewed'",
    "deposit_confirmations=1",
    "payout_confirmations=1",
    "vault_context_ref='changed'",
    "status='DRAFT'",
  ])
    await expectFailure(
      `UPDATE darkpool_private.markets SET ${assignment};`,
      "23514",
    );
  for (const status of [
    "PAUSED",
    "LOCKED",
    "RESOLVED",
    "PAYING",
    "VOID",
    "REFUNDING",
    "CLOSED",
  ]) {
    await sql(`UPDATE darkpool_private.markets SET status='${status}';`);
    await expectFailure(
      commandSql("edit", request(`state-${status}`, configuration, "2")),
      "P4004",
    );
    await expectFailure(
      commandSql("open", {
        request_key: `non-draft-${status}`,
        expected_revision: "3",
      }),
      "P4005",
    );
    for (const op of ["pause", "reopen", "finalize-lock", "resolve"])
      assert.equal((await run(op)).result, "BLOCKED");
    await expectFailure(
      "UPDATE darkpool_private.markets SET question='changed';",
      "23514",
    );
  }
});

test("SEC01/03/04/07/12 Phase 4: actual restricted CLI, private records, direct bypass and sanitized failure", async () => {
  await sql(`INSERT INTO darkpool_private.tickets VALUES ('private-ticket',1,'phase4-synthetic-market',
    'synthetic-private-vault','YES',1,0,'private-receiver','private-diversifier',decode(repeat('ab',32),'hex'),
    'DARKPOOL_CLAIM_V1_ID_FRAME_1','private-deadline','AWAITING_PAYMENT','unreviewed',NULL,now(),NULL);`);
  const inspected = await cli({ operation: "inspect", request: {} });
  assert.equal(inspected.code, 0);
  assert.equal(inspected.error, "");
  const state = JSON.parse(inspected.output);
  assert.deepEqual(Object.keys(state).sort(), ["availability", "market"]);
  assert.deepEqual(Object.keys(state.market).sort(), marketKeys);
  for (const sensitive of [
    "private-ticket",
    "private-receiver",
    "synthetic-private-vault",
    "claim_commitment",
    "pool_total",
    "yes_count",
    "no_count",
    "claims",
    "wallet_receipt_ref",
    "payout_address",
    password,
  ])
    assert.ok(!inspected.output.includes(sensitive));
  const rejected = await cli({
    operation: "create",
    request: request("private-error", {
      ...configuration,
      claim_secret: "synthetic-secret-bearer",
    }),
  });
  assert.equal(rejected.code, 1);
  assert.equal(rejected.error, "");
  assert.deepEqual(JSON.parse(rejected.output), {
    result: "REJECTED",
    code: "INVALID_CONFIGURATION_OR_REQUEST",
  });
  assert.ok(!rejected.output.includes("synthetic-secret-bearer"));
  const direct = (q) => `SET ROLE "${operator}"; ${q}`;
  for (const q of [
    "SELECT * FROM darkpool_private.tickets;",
    "SELECT * FROM darkpool_private.markets;",
    "SELECT * FROM darkpool_private.claims;",
    "SELECT * FROM darkpool_private.admin_requests;",
    "SELECT * FROM darkpool_private.audit_events;",
    "SELECT * FROM darkpool_private.policy_refs;",
    "UPDATE darkpool_private.markets SET status='LOCKED';",
    "TRUNCATE darkpool_private.markets CASCADE;",
    "INSERT INTO darkpool_private.policy_refs VALUES ('fake','PINNED',NULL,'fake');",
    "ALTER TABLE darkpool_private.markets DISABLE TRIGGER ALL;",
    "SELECT darkpool_admin.snapshot();",
    "SELECT darkpool_admin.availability();",
    `SELECT darkpool_admin.validate_config(${wire(configuration)});`,
    "CREATE FUNCTION darkpool_admin.bypass() RETURNS int LANGUAGE sql AS 'SELECT 1';",
    "SELECT * FROM darkpool_migrations.applied;",
    "SELECT darkpool_private.reject_mutation();",
  ])
    await expectFailure(direct(q), "42501");
  await assert.rejects(
    authenticatedSql(`SET ROLE "${process.env.PGUSER}";`),
    (error) => error.sqlstate === "42501",
  );
});

test("Phase 4: inherited multi-market storage fails closed without silently selecting a market", async () => {
  await sql(`INSERT INTO darkpool_private.markets SELECT 'owner-only-second',version,network,'other-vault',
    question,yes_definition,no_definition,opens_at,closes_at,close_policy_ref,resolution_rule,
    resolution_sources,void_conditions,min_stake_zat,max_stake_zat,payment_policy_ref,fee_policy_ref,
    zero_winner_policy,deposit_confirmations,payout_confirmations,'DRAFT',created_at,updated_at
    FROM darkpool_private.markets;`);
  for (const op of [
    "inspect",
    "open",
    "pause",
    "reopen",
    "finalize-lock",
    "resolve",
    "validate",
  ])
    await expectFailure(
      commandSql(op, op === "validate" ? { configuration } : {}),
      "P4002",
    );
  await expectFailure(commandSql("create", request("third")), "P4002");
});

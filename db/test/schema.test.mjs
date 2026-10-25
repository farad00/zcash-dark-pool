import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  migrate,
  migrationFiles,
  migrationScript,
  psql,
} from "../test-fixtures.mjs";

// Actual PostgreSQL, synthetic product data only; never opens wallet SQLite.
const suffix = randomBytes(8).toString("hex");
const database = `darkpool_phase3_${suffix}`;
const reader = `darkpool_reader_${suffix}`;
const options = { database };
const admin = process.env.PGDATABASE;
let created = false;
const sql = (query, extra = {}) => psql(query, { ...options, ...extra });
const expectFailure = async (query, state) => {
  await assert.rejects(sql(query), (error) => error.sqlstate === state);
};

// Fixtures label unresolved policies explicitly. 'reviewed-test' is ONLY a DB
// structural fixture, never approval of a production policy, UA or hash profile.
const fixture = `
SET LOCAL search_path = darkpool_private, pg_catalog;
INSERT INTO policy_refs VALUES ('open-policy','UNPINNED','TEST ONLY: unresolved',NULL),
 ('test-reviewed','PINNED',NULL,'reviewed-test-structural-fixture');
INSERT INTO markets VALUES ('m1',1,'testnet','vault1','Question','YES definition','NO definition',
 '2026-10-04 00:00:00Z','2026-10-05 00:00:00Z','open-policy','Rule',ARRAY['source'],ARRAY['void'],
 1,1000000000000000000000000000000,'open-policy','open-policy','NO_WINNER_REFUND',
 NULL,NULL,'DRAFT',now(),now());
INSERT INTO markets SELECT 'm2',version,network,'vault2',question,yes_definition,no_definition,
 opens_at,closes_at,close_policy_ref,resolution_rule,resolution_sources,void_conditions,
 min_stake_zat,max_stake_zat,payment_policy_ref,fee_policy_ref,zero_winner_policy,
 deposit_confirmations,payout_confirmations,status,created_at,updated_at FROM markets WHERE id='m1';
INSERT INTO tickets VALUES ('t1',1,'m1','vault1','YES',1000000,0,'receiver1','scope0-div1',
 decode('39fe1b1e0383976626942f13f1defe23504fb5c73cc2cc1c23894d70bfef1fa7','hex'),
 'DARKPOOL_CLAIM_V1_ID_FRAME_1','deadline-ref','AWAITING_PAYMENT','open-policy',NULL,now(),NULL);
INSERT INTO tickets SELECT 't2',version,market_id,vault_context_ref,'NO',requested_amount_zat,
 accepted_amount_zat,'receiver2','scope0-div2',claim_commitment,claim_commitment_profile,
 payment_deadline_ref,payment_state,ticket_state_policy_ref,accepted_payment_ref,created_at,accepted_at FROM tickets WHERE id='t1';
INSERT INTO payment_receipts VALUES ('r1','m1','vault1','testnet','wallet-note-1',decode(repeat('ab',32),'hex'),
 'IRONWOOD',0,'t1','receiver1',1000000,4454000,decode(repeat('cd',32),'hex'),'chain-ref','open-policy',now());
INSERT INTO accepted_payments VALUES ('ap1','m1','t1','open-policy');
INSERT INTO accepted_payment_receipts VALUES ('ap1','m1','t1','r1');
UPDATE tickets SET accepted_amount_zat=1000000,accepted_payment_ref='ap1',accepted_at=now(),payment_state='CONFIRMED' WHERE id='t1';
INSERT INTO entitlements VALUES ('e1','m1','t1','ACCEPTED_STAKE',NULL,'open-policy',1000000);
INSERT INTO resolutions VALUES ('resolution1','m1',1,'YES',ARRAY['synthetic evidence'],'rule1','test-system',now());
INSERT INTO settlements VALUES ('s1',1,'m1','resolution1',NULL,NULL,NULL,'open-policy',1000000,10000,1010000,
 'open-policy',NULL,NULL,now(),now());
CREATE FUNCTION pg_temp.expect_failure(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $test$
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected THEN RETURN; END IF;
    RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = 'unexpected SQLSTATE in negative test';
  END;
  RAISE EXCEPTION 'negative case unexpectedly accepted';
END $test$;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $test$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed'; END IF; END $test$;
`;
const negative = (query, state = "23514") =>
  `SELECT pg_temp.expect_failure($case$${query}$case$,'${state}');`;
const check = (query) => `SELECT pg_temp.assert_true((${query}));`;
const isolated = async (query) => {
  await sql(`BEGIN; ${fixture} ${query} ROLLBACK;`);
};
const claim = (
  id,
  key,
  kind = "PAYOUT",
  reason = "NULL",
  entitlement = "e1",
  state = "RESERVED",
) => `
INSERT INTO darkpool_private.claims VALUES ('${id}',1,'m1','t1','${entitlement}','${kind}',${reason},
 'explicit-test-scope','${key}','open-policy','synthetic-wallet-validated-destination',
 'test-validation-ref',1000000,'${state}',NULL,NULL,now(),now());`;

before(async () => {
  assert.ok(
    admin,
    "PGDATABASE must explicitly name a maintenance/development database",
  );
  assert.match(database, /^darkpool_phase3_[a-f0-9]{16}$/);
  await psql(
    `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
    { database: admin },
  );
  created = true;
});
after(async () => {
  // Delete only the random test DB created by this run. Product dev is untouched.
  if (created) {
    assert.match(database, /^darkpool_phase3_[a-f0-9]{16}$/);
    await psql(
      `DROP DATABASE "${database}"; DROP ROLE IF EXISTS "${reader}";`,
      { database: admin },
    );
  }
});

test("INT01: failed DDL rolls back schema and journal; clean apply, concurrent reapply, checksums", async () => {
  const files = await migrationFiles();
  await expectFailure(
    migrationScript([
      ...files,
      {
        name: "9999_test_failure.sql",
        sql: "CREATE TABLE public.partial_test(id int); SELECT 1/0;",
      },
    ]),
    "22012",
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'darkpool%';",
    ),
    "0",
  );
  assert.equal(
    await sql("SELECT to_regclass('public.partial_test') IS NULL;"),
    "t",
  );
  await Promise.all([migrate(options), migrate(options)]);
  const beforeJournal = await sql(
    "SELECT name,sha256,applied_at FROM darkpool_migrations.applied ORDER BY name;",
  );
  await migrate(options);
  assert.equal(
    await sql(
      "SELECT name,sha256,applied_at FROM darkpool_migrations.applied ORDER BY name;",
    ),
    beforeJournal,
  );
  await expectFailure(
    migrationScript(
      files.map((file, index) =>
        index === 0
          ? { ...file, sql: file.sql + "\n-- changed history" }
          : file,
      ),
    ),
    "23514",
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_migrations.applied;"),
    String(files.length),
  );
  await expectFailure(migrationScript(files.slice(1)), "23514");
  await expectFailure(
    migrationScript([
      ...files,
      {
        name: "9999_test_failure.sql",
        sql: "CREATE TABLE public.partial_test(id int); SELECT 1/0;",
      },
    ]),
    "22012",
  );
  assert.equal(
    await sql("SELECT to_regclass('public.partial_test') IS NULL;"),
    "t",
  );
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_migrations.applied;"),
    String(files.length),
  );
});

test("integer-zatoshi constraints: exact wide integers, no fractional coercion/nonfinite/negative money", async () => {
  await isolated(`
${check("SELECT (9007199254740993::zatoshi + 18446744073709551616::zatoshi)::text = '18455751272964292609'")}
${check("SELECT (100000000000000000000::zatoshi * 100000000000000000000::zatoshi)::text = '10000000000000000000000000000000000000000'")}
${negative("SELECT '-1'::zatoshi")}
${negative("SELECT '1.5'::zatoshi")}
${negative("SELECT 'NaN'::zatoshi")}
${negative("SELECT 'Infinity'::zatoshi")}
${negative("SELECT '-Infinity'::zatoshi")}
${negative("UPDATE tickets SET accepted_amount_zat=999999 WHERE id='t1'")}
${negative("UPDATE tickets SET accepted_amount_zat=1000001 WHERE id='t1'")}
${negative("UPDATE tickets SET accepted_amount_zat=0,accepted_payment_ref=NULL,accepted_at=NULL WHERE id='t1'")}
${negative("UPDATE tickets SET requested_amount_zat=0 WHERE id='t2'")}
${negative("UPDATE markets SET max_stake_zat=0 WHERE id='m1'")}
${negative("UPDATE settlements SET allocated_funds_zat=1009999 WHERE id='s1'")}
`);
});

test("independent bearer records: approved commitment bytes, exact IDs, fresh scoped receivers and market binding", async () => {
  await isolated(`
${check("SELECT encode(claim_commitment,'hex')='39fe1b1e0383976626942f13f1defe23504fb5c73cc2cc1c23894d70bfef1fa7' FROM tickets WHERE id='t1'")}
${negative("UPDATE tickets SET claim_commitment=decode(repeat('aa',31),'hex') WHERE id='t2'")}
${negative("UPDATE tickets SET claim_commitment_profile='unknown' WHERE id='t2'")}
${negative("INSERT INTO tickets SELECT 't3',version,market_id,vault_context_ref,side,requested_amount_zat,0,receiver_ref,'div3',claim_commitment,claim_commitment_profile,payment_deadline_ref,'AWAITING_PAYMENT',ticket_state_policy_ref,NULL,created_at,NULL FROM tickets WHERE id='t1'", "23505")}
${negative("INSERT INTO tickets SELECT 't3',version,market_id,vault_context_ref,side,requested_amount_zat,0,'receiver3',diversifier_ref,claim_commitment,claim_commitment_profile,payment_deadline_ref,'AWAITING_PAYMENT',ticket_state_policy_ref,NULL,created_at,NULL FROM tickets WHERE id='t1'", "23505")}
${negative("INSERT INTO tickets SELECT 't3',version,'m2',vault_context_ref,side,requested_amount_zat,0,'receiver3','div3',claim_commitment,claim_commitment_profile,payment_deadline_ref,'AWAITING_PAYMENT',ticket_state_policy_ref,NULL,created_at,NULL FROM tickets WHERE id='t1'", "23503")}
${negative("UPDATE tickets SET side='MAYBE' WHERE id='t2'")}
${negative("UPDATE tickets SET side='YES' WHERE id='t2'")}
${negative("DELETE FROM tickets WHERE id='t2'")}
${check("SELECT 'é'::opaque_ref <> 'é'::opaque_ref AND 'A'::opaque_ref <> 'a'::opaque_ref")}
${negative("SELECT ''::opaque_ref")}
`);
});

test("PAY02/V11 database portion: note identity, aliases, receiver matching, unknown receipts, group isolation", async () => {
  await isolated(`
${negative("INSERT INTO payment_receipts SELECT 'r2',market_id,vault_context_ref,network,'wallet-alias',txid,value_pool,output_index,ticket_id,receiver_ref,amount_zat,block_height,block_hash,chain_evidence_ref,status_policy_ref,created_at FROM payment_receipts WHERE id='r1'", "23505")}
INSERT INTO payment_receipts SELECT 'r2',market_id,vault_context_ref,network,'wallet-note-2',txid,value_pool,1,'t2','receiver2',amount_zat,block_height,block_hash,chain_evidence_ref,status_policy_ref,created_at FROM payment_receipts WHERE id='r1';
${check("SELECT count(*)=2 FROM payment_receipts WHERE txid=decode(repeat('ab',32),'hex')")}
${negative("INSERT INTO payment_receipts SELECT 'r3',market_id,vault_context_ref,network,wallet_receipt_ref,txid,value_pool,3,ticket_id,receiver_ref,amount_zat,block_height,block_hash,chain_evidence_ref,status_policy_ref,created_at FROM payment_receipts WHERE id='r1'", "23505")}
${negative("INSERT INTO payment_receipts SELECT 'r3',market_id,vault_context_ref,network,'wallet-note-3',txid,value_pool,3,'t2','receiver1',amount_zat,block_height,block_hash,chain_evidence_ref,status_policy_ref,created_at FROM payment_receipts WHERE id='r1'", "23503")}
INSERT INTO payment_receipts SELECT 'unknown',market_id,vault_context_ref,network,'wallet-unknown',txid,value_pool,4,NULL,'unknown-receiver',999999,NULL,NULL,NULL,status_policy_ref,created_at FROM payment_receipts WHERE id='r1';
INSERT INTO payment_liabilities VALUES ('unknown-liability','m1','unknown',NULL,NULL,'open-policy','open-policy',now());
${check("SELECT principal_zat IS NULL FROM payment_liabilities WHERE id='unknown-liability'")}
${negative("INSERT INTO accepted_payment_receipts VALUES ('ap1','m1','t1','r2')", "23503")}
${negative("INSERT INTO accepted_payment_receipts VALUES ('ap1','m1','t1','r1')", "23505")}
${negative("INSERT INTO payment_liabilities VALUES ('wrong-liability','m2','r2',NULL,NULL,'open-policy','open-policy',now())", "23503")}
UPDATE payment_receipts SET block_height=NULL,block_hash=NULL,chain_evidence_ref=NULL WHERE id='r1';
${check("SELECT block_height IS NULL FROM payment_receipts WHERE id='r1'")}
${negative("UPDATE payment_receipts SET amount_zat=2 WHERE id='r1'")}
${negative("UPDATE payment_receipts SET ticket_id=NULL WHERE id='r1'")}
${negative("DELETE FROM payment_liabilities WHERE id='unknown-liability'")}
${negative("DELETE FROM payment_receipts WHERE id='unknown'")}
${negative("UPDATE payment_receipts SET value_pool='TRANSPARENT' WHERE id='r1'")}
${negative("UPDATE payment_receipts SET network='mainnet' WHERE id='r1'")}
`);
});

test("policy choices stay UNPINNED/null; opened configurations and profile references cannot mutate", async () => {
  await isolated(`
${check("SELECT deposit_confirmations IS NULL AND payout_confirmations IS NULL FROM markets WHERE id='m1'")}
${check("SELECT count(*)=0 FROM information_schema.columns WHERE table_schema='darkpool_private' AND column_default IS NOT NULL")}
UPDATE markets SET deposit_confirmations=0 WHERE id='m2';
${check("SELECT deposit_confirmations=0 FROM markets WHERE id='m2'")}
${check("SELECT status='UNPINNED' AND reviewed_profile_ref IS NULL FROM policy_refs WHERE id='open-policy'")}
${negative("INSERT INTO policy_refs VALUES ('invalid','PINNED',NULL,NULL)")}
${negative("UPDATE policy_refs SET status='PINNED',issue=NULL,reviewed_profile_ref='invented' WHERE id='open-policy'")}
INSERT INTO market_policy_refs VALUES ('m1','claimable-states','open-policy');
UPDATE markets SET status='OPEN' WHERE id='m1';
${negative("UPDATE markets SET closes_at=closes_at+interval '1 hour' WHERE id='m1'")}
${negative("UPDATE markets SET fee_policy_ref='test-reviewed' WHERE id='m1'")}
${negative("UPDATE markets SET status='DRAFT' WHERE id='m1'")}
${negative("UPDATE market_policy_refs SET policy_ref='test-reviewed' WHERE market_id='m1'")}
${negative("INSERT INTO market_policy_refs VALUES ('m1','expiry','test-reviewed')")}
${negative("UPDATE markets SET status='LOCK_FINALIZING' WHERE id='m1'")}
`);
});

test("ledger database portion: confirmed snapshot, freeze, persisted blindings and immutable root", async () => {
  await isolated(`
INSERT INTO ledger_sets VALUES ('m1','open-policy',NULL);
INSERT INTO ledger_records VALUES ('m1','t1',1,'YES',1000000,'ap1','receiver1',decode('010203','hex'),'open-policy');
${negative("UPDATE ledger_records SET accepted_amount_zat=999999 WHERE ticket_id='t1'")}
${negative("INSERT INTO ledger_records VALUES ('m1','t1',1,'NO',1000000,'ap1','receiver1',NULL,'open-policy')")}
${negative("INSERT INTO ledger_commitments VALUES ('m1',1,1,decode('ab','hex'),'open-policy',now())")}
${negative("UPDATE ledger_sets SET frozen_at=now() WHERE market_id='m1'")}
UPDATE ledger_sets SET encoding_policy_ref='test-reviewed' WHERE market_id='m1';
UPDATE ledger_records SET blinding_policy_ref='test-reviewed' WHERE ticket_id='t1';
UPDATE ledger_sets SET frozen_at=now() WHERE market_id='m1';
${negative("UPDATE ledger_records SET record_blinding=decode('ff','hex') WHERE ticket_id='t1'")}
${negative("DELETE FROM ledger_records WHERE ticket_id='t1'")}
${negative("UPDATE ledger_sets SET frozen_at=NULL WHERE market_id='m1'")}
${negative("DELETE FROM accepted_payment_receipts WHERE receipt_id='r1'")}
${negative("UPDATE tickets SET accepted_amount_zat=0,accepted_at=NULL,accepted_payment_ref=NULL,payment_state='DETECTED' WHERE id='t1'")}
${negative("INSERT INTO ledger_commitments VALUES ('m1',1,2,decode('ab','hex'),'open-policy',now())")}
INSERT INTO ledger_commitments VALUES ('m1',1,1,decode('ab','hex'),'test-reviewed',now());
${negative("UPDATE ledger_commitments SET merkle_root=decode('ff','hex') WHERE market_id='m1'")}
${check("SELECT encode(record_blinding,'hex')='010203' FROM ledger_records WHERE ticket_id='t1'")}
`);
});

test("CLAIM03/04/06/08 DB portion: reservation, retry retention, idempotency, refund crossover, bound destinations", async () => {
  await isolated(`
${claim("c1", "key1")}
${negative(claim("c2", "key2"), "23505")}
${negative(claim("c2", "key1"), "23505")}
${negative(claim("refund", "refund-key", "REFUND", "'VOID'"), "23505")}
${negative("UPDATE claims SET payout_address='substituted-destination' WHERE id='c1'")}
${negative("UPDATE claims SET entitlement_zat=1 WHERE id='c1'")}
UPDATE claims SET state='RETRYABLE_FAILURE' WHERE id='c1';
${negative(claim("c2", "key2"), "23505")}
UPDATE claims SET state='TERMINAL_FAILURE' WHERE id='c1';
${negative("UPDATE claims SET state='UNCLAIMED' WHERE id='c1'")}
${negative("DELETE FROM claims WHERE id='c1'")}
SET CONSTRAINTS ALL IMMEDIATE;
${negative("TRUNCATE claims", "0A000")}
${negative("TRUNCATE claims, settlement_items")}
${negative("UPDATE entitlements SET amount_zat=1 WHERE id='e1'")}
${negative("DELETE FROM entitlements WHERE id='e1'")}
${negative("UPDATE claims SET state='BROADCAST' WHERE id='c1'")}
INSERT INTO settlement_items VALUES ('s1','m1','c1','synthetic-wallet-validated-destination',1000000);
UPDATE claims SET settlement_id='s1',tx_ref='synthetic-tx',state='BROADCAST' WHERE id='c1';
SET CONSTRAINTS ALL IMMEDIATE;
${negative("UPDATE claims SET tx_ref='replacement-tx' WHERE id='c1'")}
${negative("UPDATE claims SET tx_ref=NULL WHERE id='c1'")}
UPDATE claims SET state='CONFIRMED' WHERE id='c1';
${negative("UPDATE claims SET state='RETRYABLE_FAILURE' WHERE id='c1'")}
${negative(claim("refund", "refund-key", "REFUND", "'VOID'"), "23505")}
`);
  await isolated(`
${claim("refund", "refund-key", "REFUND", "'NO_WINNER_REFUND'")}
${negative(claim("winner", "winner-key"), "23505")}
`);
});

test("exception principal stays separate; unresolved amount/eligibility blocks reservation", async () => {
  await isolated(`
INSERT INTO payment_receipts SELECT 'excess',market_id,vault_context_ref,network,'wallet-excess',txid,value_pool,5,ticket_id,receiver_ref,50,block_height,block_hash,chain_evidence_ref,status_policy_ref,created_at FROM payment_receipts WHERE id='r1';
INSERT INTO payment_liabilities VALUES ('liability1','m1','excess','t1',NULL,'open-policy','open-policy',now());
INSERT INTO entitlements VALUES ('exception1','m1','t1','PAYMENT_EXCEPTION','liability1','open-policy',NULL);
${negative(claim("exception", "ex-key", "REFUND", "'PAYMENT_EXCEPTION'", "exception1"))}
UPDATE entitlements SET amount_zat=1000000 WHERE id='exception1';
${negative(claim("exception", "ex-key", "REFUND", "'PAYMENT_EXCEPTION'", "exception1"))}
${negative(claim("wrong-kind", "ex-key", "PAYOUT", "NULL", "exception1"))}
${negative(claim("wrong-reason", "ex-key", "REFUND", "'PAYMENT_EXCEPTION'"))}
${claim("winner", "winner-key")}
${check("SELECT principal_zat IS NULL FROM payment_liabilities WHERE id='liability1'")}
${check("SELECT accepted_amount_zat=1000000 FROM tickets WHERE id='t1'")}
`);
});

test("settlement DB portion: market/root/resolution/output binding and authorization immutability", async () => {
  await isolated(`
${claim("c1", "key1")}
${negative("INSERT INTO settlement_items VALUES ('s1','m1','c1','wrong-destination',1000000)")}
${negative("INSERT INTO settlement_items VALUES ('s1','m1','c1','synthetic-wallet-validated-destination',1)")}
INSERT INTO settlement_items VALUES ('s1','m1','c1','synthetic-wallet-validated-destination',1000000);
${negative("UPDATE resolutions SET outcome='NO' WHERE id='resolution1'")}
${negative("UPDATE settlements SET ledger_market_id='m1',ledger_root=decode('ab','hex') WHERE id='s1'")}
${negative("UPDATE settlements SET market_id='m2' WHERE id='s1'", "23503")}
${negative("UPDATE settlements SET plan_hash=decode('ab','hex'),authorization_started_at=now() WHERE id='s1'")}
UPDATE claims SET settlement_id='s1' WHERE id='c1';
UPDATE settlements SET hashing_policy_ref='test-reviewed',plan_hash=decode('ab','hex'),authorization_started_at=now() WHERE id='s1';
${negative("UPDATE settlements SET plan_hash=decode('ff','hex') WHERE id='s1'")}
${negative("UPDATE settlements SET expected_fee_zat=1 WHERE id='s1'")}
${negative("DELETE FROM settlement_items WHERE settlement_id='s1'")}
${negative("UPDATE settlement_items SET destination='wrong-destination' WHERE claim_id='c1'")}
`);
});

test("SEC01/03/04 schema portion: public allowlist, denied private reads, no identity/secrets/payload, append-only audit", async () => {
  await isolated(`
${check("SELECT count(*)=0 FROM information_schema.columns WHERE table_schema IN ('darkpool_private','darkpool_public') AND column_name IN ('claim_secret','user_id','username','email','seed','spending_key','ufvk','frost_share','payload','ip_address')")}
${check("SELECT count(*)=0 FROM information_schema.tables WHERE table_schema LIKE 'darkpool%' AND table_name IN ('users','accounts','profiles','portfolios')")}
${check("SELECT string_agg(column_name,',' ORDER BY ordinal_position)='id,version,network,question,yes_definition,no_definition,opens_at,closes_at,resolution_rule,resolution_sources,void_conditions,status' FROM information_schema.columns WHERE table_schema='darkpool_public' AND table_name='markets'")}
${check("SELECT count(*)=0 FROM information_schema.columns WHERE table_schema='darkpool_private' AND column_name LIKE '%_zat' AND domain_name IS DISTINCT FROM 'zatoshi'")}
INSERT INTO audit_events VALUES ('audit1',1,'m1','MARKET_OPENED',now(),'test-system','opaque-trigger','DRAFT','OPEN',NULL);
${negative("UPDATE audit_events SET source='changed' WHERE id='audit1'")}
${negative("DELETE FROM audit_events WHERE id='audit1'")}
${negative("TRUNCATE audit_events")}
${negative("INSERT INTO audit_events VALUES ('audit2',1,'m1','MARKET_OPENED',now(),'test-system','opaque-trigger','DRAFT',NULL,NULL)")}
`);
  await psql(`CREATE ROLE "${reader}" NOLOGIN;`, { database: admin });
  await sql(
    `GRANT USAGE ON SCHEMA darkpool_public TO "${reader}"; GRANT SELECT ON darkpool_public.markets TO "${reader}";`,
  );
  await sql(
    `SET ROLE "${reader}"; SELECT id,question FROM darkpool_public.markets;`,
  );
  const publicRows = (
    await sql(`BEGIN; ${fixture} SET LOCAL ROLE "${reader}";
SELECT row_to_json(v) FROM darkpool_public.markets v ORDER BY id; ROLLBACK;`)
  )
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(publicRows.length, 2);
  for (const row of publicRows) {
    assert.deepEqual(Object.keys(row), [
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
      "status",
    ]);
    assert.equal(row.question, "Question");
  }
  await expectFailure(
    `SET ROLE "${reader}"; SELECT * FROM darkpool_private.tickets;`,
    "42501",
  );
  await expectFailure(
    `SET ROLE "${reader}"; SELECT * FROM darkpool_private.claims;`,
    "42501",
  );
  await expectFailure(
    `SET ROLE "${reader}"; SELECT * FROM darkpool_private.policy_refs;`,
    "42501",
  );
  await expectFailure(
    `SET ROLE "${reader}"; ALTER TABLE darkpool_private.audit_events ADD COLUMN claim_secret text;`,
    "42501",
  );
  await expectFailure(
    `SET ROLE "${reader}"; SELECT * FROM darkpool_migrations.applied;`,
    "42501",
  );
  await expectFailure(
    `SET ROLE "${reader}"; SELECT darkpool_private.reject_mutation();`,
    "42501",
  );
});

test("V18/CLAIM03 DB concurrency: separate processes race payout/refund and same/different keys; one durable reservation", async () => {
  await sql(`BEGIN; ${fixture} COMMIT;`);
  const attempts = Array.from({ length: 8 }, (_, index) =>
    sql(
      `BEGIN;
${claim(`race${index}`, index < 4 ? "same-key" : `different-key${index}`, index % 2 ? "REFUND" : "PAYOUT", index % 2 ? "'VOID'" : "NULL")}
SELECT pg_sleep(0.25); COMMIT;`,
      { applicationName: `darkpool-race-${index}` },
    ),
  );
  const results = await Promise.allSettled(attempts);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of results.filter(
    (result) => result.status === "rejected",
  )) {
    assert.equal(result.reason.sqlstate, "23505");
  }
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.claims WHERE entitlement_id='e1' AND state='RESERVED';",
    ),
    "1",
  );
  await migrate(options);
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.claims WHERE entitlement_id='e1';",
    ),
    "1",
  );
});

test("CLAIM03 DB concurrency: competing UNCLAIMED-to-RESERVED updates commit once", async () => {
  await sql(`BEGIN; SET LOCAL search_path=darkpool_private,pg_catalog;
INSERT INTO entitlements VALUES ('e2','m1','t2','ACCEPTED_STAKE',NULL,'open-policy',1000000);
${claim("candidate1", "candidate-key1", "PAYOUT", "NULL", "e2", "UNCLAIMED").replace("'t1'", "'t2'")}
${claim("candidate2", "candidate-key2", "REFUND", "'VOID'", "e2", "UNCLAIMED").replace("'t1'", "'t2'")}
COMMIT;`);
  const results = await Promise.allSettled(
    ["candidate1", "candidate2"].map((id) =>
      sql(`BEGIN;
UPDATE darkpool_private.claims SET state='RESERVED' WHERE id='${id}';
SELECT pg_sleep(0.25); COMMIT;`),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.sqlstate,
    "23505",
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.claims WHERE entitlement_id='e2' AND state='RESERVED';",
    ),
    "1",
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.claims WHERE entitlement_id='e2' AND state='UNCLAIMED';",
    ),
    "1",
  );
});

test("V11 DB concurrency: eight aliased replays retain one distinct note", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      sql(`BEGIN;
INSERT INTO darkpool_private.payment_receipts SELECT 'receipt-race-${index}',market_id,vault_context_ref,network,
 'wallet-race-${index}',txid,value_pool,6,ticket_id,receiver_ref,amount_zat,block_height,block_hash,
 chain_evidence_ref,status_policy_ref,created_at FROM darkpool_private.payment_receipts WHERE id='r1';
SELECT pg_sleep(0.25); COMMIT;`),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of results.filter((result) => result.status === "rejected"))
    assert.equal(result.reason.sqlstate, "23505");
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.payment_receipts WHERE output_index=6;",
    ),
    "1",
  );
});

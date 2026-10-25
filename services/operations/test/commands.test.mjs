import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  commands,
  parseOperationsCommand,
  assertOperationsEnvironment,
  lockResourcesFromEnvironment,
  MAX_COMMAND_BYTES,
} from "../commands.mjs";
const valid = {
  APP_ENV: "development",
  ZCASH_NETWORK: "testnet",
  DARKPOOL_OPERATIONS_INTERNAL: "1",
  DARKPOOL_PG_ENV: "TEST",
  DARKPOOL_TEST_ONLY: "TEST_ONLY",
  PGHOST: "127.0.0.1",
  PGPORT: "55433",
  PGDATABASE: "darkpool_phase9_1234567890abcdef",
  PGUSER: "darkpool_lock_1234567890abcdef",
  PGPASSWORD: "synthetic",
  DARKPOOL_PG_PROFILE: "explicit-profile",
};
test("closed purposes expose no spending, publication delivery, wallet or state-assignment operation", () => {
  assert.deepEqual(Object.keys(commands), [
    "admin",
    "lock",
    "publication",
    "oracle",
    "settlement",
    "claim",
    "planner",
  ]);
  for (const operation of [
    "sign",
    "broadcast",
    "publish",
    "create-wallet",
    "set-state",
    "set-role",
    "pay",
    "confirm",
    "set-publication",
  ])
    for (const purpose of Object.keys(commands))
      assert.throws(() =>
        parseOperationsCommand(
          JSON.stringify({ operation, request: {} }),
          purpose,
        ),
      );
});
test("every purpose parses only its own commands, not a request-selected capability", () => {
  for (const [purpose, operations] of Object.entries(commands))
    for (const operation of operations) {
      const text = JSON.stringify({ operation, request: {} });
      assert.equal(parseOperationsCommand(text, purpose).operation, operation);
      for (const other of Object.keys(commands).filter((p) => p !== purpose))
        assert.throws(() => parseOperationsCommand(text, other));
    }
});
test("strict bounded input rejects malformed packets and never echoes bearer data", () => {
  for (const value of [
    "not json",
    "[]",
    "null",
    "{}",
    JSON.stringify({ operation: "reserve-claim", request: [], env: valid }),
    JSON.stringify({ operation: "reserve-claim", request: {}, trust: {} }),
    "x".repeat(MAX_COMMAND_BYTES + 1),
    "\ud800",
  ]) {
    assert.throws(() => parseOperationsCommand(value, "claim"), {
      message: "OPERATIONS_REJECTED",
    });
  }
});
test("environment fence rejects protected/development/default targets before any connection", () => {
  assert.doesNotThrow(() => assertOperationsEnvironment(valid, "lock"));
  for (const change of [
    { PGPORT: "55432" },
    { PGPORT: "55434" },
    { PGPORT: "55435" },
    { PGPORT: undefined },
    { PGDATABASE: "postgres" },
    { PGDATABASE: "darkpool_phase9_development_payment_v2" },
    { PGDATABASE: "darkpool_phase9_evidence_payment_v1" },
    { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
    { DARKPOOL_PG_ENV: "DEVELOPMENT_ONLY" },
    { PGUSER: "darkpool_test_maintenance" },
    { PGPASSWORD: undefined },
    { DARKPOOL_OPERATIONS_INTERNAL: undefined },
    { DARKPOOL_TEST_ONLY: undefined },
    { DARKPOOL_LIVE_INSTANCE: "phase9_payment_v2" },
    { PGOPTIONS: "override" },
    { PGSERVICE: "service" },
    { PGHOSTADDR: "127.0.0.1" },
    { WALLET_DB_PATH: "forbidden" },
    { DATABASE_URL: "forbidden" },
    { APP_ENV: "production" },
    { ZCASH_NETWORK: "mainnet" },
  ])
    assert.throws(
      () => assertOperationsEnvironment({ ...valid, ...change }, "lock"),
      { message: "OPERATIONS_REJECTED" },
    );
});
test("lock resource configuration is explicit, complete and nonfinancial", () => {
  assert.equal(lockResourcesFromEnvironment({}), undefined);
  const env = {
    DARKPOOL_LOCK_MAX_TICKETS: "4096",
    DARKPOOL_LOCK_MAX_TEXT_BYTES: "8192",
    DARKPOOL_LOCK_MAX_AMOUNT_BYTES: "128",
    DARKPOOL_LOCK_MAX_LEDGER_BYTES: "4194304",
  };
  assert.deepEqual(lockResourcesFromEnvironment(env), {
    max_tickets: 4096n,
    max_text_bytes: 8192,
    max_amount_bytes: 128,
    max_ledger_bytes: 4194304,
  });
  for (const change of [
    { DARKPOOL_LOCK_MAX_TICKETS: "0" },
    { DARKPOOL_LOCK_MAX_TEXT_BYTES: undefined },
    { DARKPOOL_LOCK_MAX_LEDGER_BYTES: "1e6" },
    { DARKPOOL_LOCK_MAX_AMOUNT_BYTES: "9007199254740993" },
  ])
    assert.throws(() => lockResourcesFromEnvironment({ ...env, ...change }));
});
test("CLI retains no publication plugin or wallet initializer dependency", async () => {
  const [cli, adapter] = await Promise.all([
    readFile(new URL("../cli.mjs", import.meta.url), "utf8"),
    readFile(new URL("../commands.mjs", import.meta.url), "utf8"),
  ]);
  for (const text of [cli, adapter])
    assert.equal(
      /issuance-fixture|serve-allocation|serve-watcher|new DatabaseSync|wallet init/.test(
        text,
      ),
      false,
    );
  assert.equal(
    cli.includes("publication:"),
    false,
    "CLI must not install an unverified retrieval adapter",
  );
});

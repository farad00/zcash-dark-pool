import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { finalizeInSession } from "../finalize.mts";
import { openLockSession } from "../db-session.mjs";
import { resources } from "../../../db/test/lock-fixtures.mjs";
const vector = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/protocol/phase10/ledger-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
).cases.find((x) => x.case === "leaves-1");
const response = {
  result: "LOCKED",
  publication: "PENDING",
  revision: "2",
  commitment: {
    market_id: vector.context.market_id,
    ledger_version: 1,
    accepted_ticket_count: "1",
    merkle_root: vector.root,
    locked_at: vector.context.locked_at,
  },
};
const sealed = () => ({
  result: "SEALED",
  context: structuredClone(vector.context),
  records: structuredClone(vector.records),
  response: structuredClone(response),
  min_stake_zat: "1",
  max_stake_zat: "340282366920938463463374607431768211455",
});
function session(data, commit = { committed: true }) {
  let n = 0;
  const queries = [];
  return {
    queries,
    query: async (sql) => {
      queries.push(sql);
      n++;
      return n === 1 ? { authorized: true } : n === 2 ? data : commit;
    },
    close: async () => {},
  };
}
test("finalizer replay verifies independent vector before reporting success", async () => {
  const s = session(sealed());
  assert.deepEqual(await finalizeInSession(s, {}, resources), response);
  assert.equal(s.queries.length, 3);
  assert.ok(s.queries[0].startsWith("BEGIN ISOLATION LEVEL SERIALIZABLE"));
  assert.ok(s.queries[2].startsWith("COMMIT;"));
});
test("finalizer replay uses no RNG and refuses missing private material", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues() {
        calls++;
        throw new Error("not permitted");
      },
    },
  });
  try {
    await finalizeInSession(session(sealed()), {}, resources);
    for (const patch of [
      { record_blinding: undefined },
      { record_blinding: "ff".repeat(32) },
      { accepted_amount_zat: "2" },
    ]) {
      const value = sealed();
      Object.assign(value.records[0], patch);
      const s = session(value);
      await assert.rejects(finalizeInSession(s, {}, resources));
      assert.equal(s.queries.length, 2);
    }
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});
test("finalizer refuses an unacknowledged commit or lost commit response", async () => {
  for (const ack of [null, {}, false, { committed: false }])
    await assert.rejects(
      finalizeInSession(session(sealed(), ack), {}, resources),
      /LOCK_COMMIT_UNCONFIRMED/,
    );
  const s = session(sealed());
  const query = s.query;
  s.query = (sql) =>
    sql.startsWith("COMMIT;")
      ? Promise.reject(new Error("synthetic disconnect"))
      : query(sql);
  await assert.rejects(
    finalizeInSession(s, {}, resources),
    /synthetic disconnect/,
  );
});
test("finalizer will not begin private work on failed authorization", async () => {
  let calls = 0;
  await assert.rejects(
    finalizeInSession(
      {
        query: async () => {
          calls++;
          return { authorized: false };
        },
        close: async () => {},
      },
      {},
      resources,
    ),
    /LOCK_AUTHORIZATION_FAILED/,
  );
  assert.equal(calls, 1);
});
test("session transport rejects non-TEST/missing authority before any spawn", async () => {
  await assert.rejects(openLockSession({}), /LOCK_TEST_ONLY/);
  await assert.rejects(
    openLockSession({
      APP_ENV: "development",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
      DARKPOOL_PG_ENV: "LIVE",
    }),
  );
});

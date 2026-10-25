import assert from "node:assert/strict";
import { test } from "node:test";
import {
  proposedTarget,
  validateTarget,
  validateConnection,
  nativeEnvironment,
  reviewTarget,
} from "../target.mjs";
import { openGenuineDeposit } from "../runtime.mjs";
import { createParticipantStatus } from "../status.mjs";
import { participantStatusScript } from "../../../db/participant-status-provision.mjs";
import {
  paymentStatusResult,
  paymentStatusText,
} from "../../../apps/web/src/payment-status-wire.mjs";
import { walletEnvironment } from "../../watcher/main.mjs";
const env = () => ({
  APP_ENV: "development",
  ZCASH_NETWORK: "testnet",
  DARKPOOL_PG_ENV: "TESTNET_OBSERVATION",
  DARKPOOL_OBSERVATION_INSTANCE: "testnet_observation_v1",
  PGHOST: "127.0.0.1",
  PGPORT: "55436",
  PGDATABASE: "darkpool_testnet_observation_v1",
  PGUSER: "darkpool_obs_v1_status",
  PGPASSWORD: "synthetic-not-a-credential",
  FINANCIAL_AUTHORIZATION: "NOT_GRANTED",
});
test("fixed target rejects protected ports, roots, databases, network and extra configuration", () => {
  const t = proposedTarget();
  assert.equal(validateTarget(t).port, 55436);
  for (const port of [5432, 55432, 55433, 55434, 55435])
    assert.throws(() => validateTarget({ ...t, port }));
  for (const edit of [
    { database: "postgres" },
    { root: "C:\\Users\\Admin\\OneDrive\\wallet" },
    { wallet_path: t.signer_root + "\\data.sqlite" },
    { network: "mainnet" },
    { approval: true },
  ])
    assert.throws(() => validateTarget({ ...t, ...edit }));
  assert.equal(
    reviewTarget().native_launch,
    "BLOCKED_BY_EXISTING_APPROVAL_GATE",
  );
});
test("purpose connections reject owner, role switching, protected/default targets and secret-bearing overrides", () => {
  assert.equal(validateConnection(env(), "status").port, 55436);
  for (const port of [undefined, "5432", "55432", "55433", "55434", "55435"])
    assert.throws(() =>
      validateConnection({ ...env(), PGPORT: port }, "status"),
    );
  for (const edit of [
    { PGUSER: "darkpool_obs_v1_owner" },
    { PGOPTIONS: "-c role=owner" },
    { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
    { DARKPOOL_TEST_ONLY: "TEST_ONLY" },
    { WALLET_DB_PATH: "private" },
    { DATABASE_URL: "private" },
    { FINANCIAL_AUTHORIZATION: "GRANTED" },
  ])
    assert.throws(() => validateConnection({ ...env(), ...edit }, "status"));
});
test("native child environment is viewer-only and strips all caller-selected capabilities", () => {
  const native = nativeEnvironment(proposedTarget(), "scan");
  assert.deepEqual(walletEnvironment(native), native);
  for (const k of [
    "PGPASSWORD",
    "PGUSER",
    "claim_secret",
    "seed",
    "spending_key",
  ])
    assert.equal(native[k], undefined);
  assert.throws(() => nativeEnvironment(proposedTarget(), "signer"));
  assert.throws(() =>
    nativeEnvironment(proposedTarget(), "scan", { seed: "synthetic" }),
  );
  assert.throws(() =>
    walletEnvironment({
      ...native,
      WALLET_DB_PATH: proposedTarget().signer_root + "\\data.sqlite",
    }),
  );
});
test("genuine activation still fails before credentials, SQL, native startup or wallet access", async () => {
  const connections = new Proxy(
    {},
    {
      get() {
        throw Error("CREDENTIAL_ACCESS_FORBIDDEN");
      },
    },
  );
  await assert.rejects(
    openGenuineDeposit({ connections }),
    /NATIVE_LAUNCH_NOT_APPROVED/,
  );
});
test("watcher status profiles distinguish genuine observation, fixture input and old synthetic demo", () => {
  for (const environment of ["DISPOSABLE_TEST", "TESTNET_OBSERVATION"])
    for (const status of [
      "AWAITING_PAYMENT",
      "DETECTED",
      "CONFIRMED",
      "UNAVAILABLE",
    ]) {
      const r = { status, environment, financial_authorization: "NOT_GRANTED" };
      assert.deepEqual(paymentStatusResult(r), r);
      assert.match(paymentStatusText(r), /NOT_GRANTED/);
    }
  assert.throws(() =>
    paymentStatusResult({
      status: "DETECTED",
      environment: "SYNTHETIC_TEST_ONLY",
      financial_authorization: "NOT_GRANTED",
    }),
  );
  for (const edit of [
    { side: "YES" },
    { stake: "1000" },
    { environment: "PRODUCTION" },
    { financial_authorization: "GRANTED" },
    { status: "PAID" },
  ])
    assert.throws(() =>
      paymentStatusResult({
        status: "CONFIRMED",
        environment: "TESTNET_OBSERVATION",
        financial_authorization: "NOT_GRANTED",
        ...edit,
      }),
    );
});
test("private capability is hashed in SQL stdin, not sent as a claim secret; results fail closed", async () => {
  const p = {
    market_id: "synthetic-market",
    ticket_id: "11".repeat(32),
    issuance_token: "22".repeat(32),
  };
  let statement;
  const status = createParticipantStatus(async (sql) => {
    statement = sql;
    return {
      status: "DETECTED",
      environment: "DISPOSABLE_TEST",
      financial_authorization: "NOT_GRANTED",
    };
  }, "DISPOSABLE_TEST");
  assert.equal((await status(p)).status, "DETECTED");
  assert(!statement.includes(p.issuance_token));
  await assert.rejects(
    status({ ...p, claim_secret: "not-allowed" }),
    /PAYMENT_STATUS_UNAVAILABLE/,
  );
  await assert.rejects(
    createParticipantStatus(
      async () => ({
        status: "CONFIRMED",
        environment: "TESTNET_OBSERVATION",
        financial_authorization: "NOT_GRANTED",
      }),
      "DISPOSABLE_TEST",
    )(p),
  );
});
test("status provisioning cannot select protected targets or relabel synthetic fixture evidence", () => {
  const database = "darkpool_phase9_0123456789abcdef",
    role = "darkpool_e2e_other_0123456789abcdef";
  assert.match(
    participantStatusScript({ database, role, environment: "DISPOSABLE_TEST" }),
    /SECURITY DEFINER SET search_path=pg_catalog/,
  );
  assert.throws(() =>
    participantStatusScript({
      database,
      role,
      environment: "TESTNET_OBSERVATION",
    }),
  );
  assert.throws(() =>
    participantStatusScript({
      database: "darkpool_phase9_development_payment_v2",
      role,
      environment: "DISPOSABLE_TEST",
    }),
  );
});

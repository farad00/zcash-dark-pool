import assert from "node:assert/strict";
import { test } from "node:test";
import {
  proposal,
  proposalDigest,
  reviewIsolation,
  planPurpose,
} from "../../plan.mjs";
import {
  provisioningPlan,
  provisionPersistent,
  launchPersistent,
  permissionPlan,
  assertDisposable,
} from "../policy.mjs";
const context = {
  localAppData: "C:\\Users\\Fixture\\AppData\\Local",
  workspace: "C:\\fixture-workspace",
};
test("fixed target and conditional approval never confer creation or financial authority", () => {
  const plan = provisioningPlan();
  assert.equal(plan.port, 55436);
  assert.equal(plan.database, "darkpool_testnet_observation_v1");
  assert.equal(plan.descriptor_sha256, proposalDigest(proposal()));
  assert.equal(plan.persistent_creation, "NOT_APPROVED");
  assert.equal(plan.product_migrations, false);
  assert.equal(plan.financial_authorization, "NOT_GRANTED");
  assert.equal(plan.production_trust, "UNAVAILABLE");
});
test("persistent provisioning and native launch remain denied under approved design", () => {
  assert.throws(
    () => provisionPersistent(),
    /PERSISTENT_CREATION_NOT_APPROVED/,
  );
  assert.throws(() => launchPersistent(), /NATIVE_LAUNCH_NOT_APPROVED/);
});
test("target mutation, protected port, credential and inherited identity substitutions reject", () => {
  for (const [k, v] of [
    ["port", 55435],
    ["port", 5432],
    ["root", "C:\\other"],
    ["database", "postgres"],
    ["financial_authorization", "GRANTED"],
    ["resource_creation", true],
  ]) {
    const p = proposal();
    p[k] = v;
    assert.throws(() => provisioningPlan(p));
  }
});
test("overlap with protected inventory fails both ancestor directions", () => {
  for (const path of [
    proposal().root,
    proposal().root + "\\child",
    "C:\\ProgramData",
  ])
    assert.throws(() =>
      reviewIsolation(proposal(), {
        ...context,
        additionalProtectedRoots: [path],
      }),
    );
});
test("purpose plans grant neither product writes nor signer access", () => {
  for (const purpose of ["allocation", "scan", "observation"]) {
    const p = planPurpose(proposal(), purpose, context);
    assert.equal(p.enabled, false);
    assert.equal(p.spending_enabled, false);
    assert.equal(
      p.child_environment_keys.some((k) => /^PG|SECRET|SEED|SIGNER/.test(k)),
      false,
    );
  }
  for (const p of [
    "issue",
    "watcher",
    "reconcile",
    "sign",
    "broadcast",
    "payout",
    "admin",
  ])
    assert.throws(() => planPurpose(proposal(), p, context));
});
test("five distinct local SID plan separates PG, viewer, web, signer and recovery", () => {
  const sids = Object.fromEntries(
    Object.keys(proposal().os_principals).map((k, i) => [
      k,
      `S-1-5-21-1-2-3-${100 + i}`,
    ]),
  );
  const plan = permissionPlan(sids);
  assert.equal(plan.protected_dacl, true);
  assert.deepEqual(plan.web_private_grants, []);
  assert.equal(plan.actual_access_tests, "NOT_EXECUTED");
  assert.equal(
    plan.grants.find((g) => g.path === proposal().paths.viewer_directory).sid,
    sids.viewer_controller,
  );
  assert.equal(
    plan.grants.find((g) => g.path === proposal().signer_root).sid,
    sids.signer,
  );
  assert.throws(() => permissionPlan({ ...sids, web: sids.viewer_controller }));
  assert.throws(() =>
    permissionPlan({ ...sids, viewer_controller: "S-1-5-32-544" }),
  );
});
test("disposable execution needs complete TEST environment, not a promotion switch", () => {
  const key = "DARKPOOL_OBSERVATION_V1_TEST_ONLY",
    prior = process.env[key];
  try {
    process.env[key] = "0";
    assert.throws(() => assertDisposable());
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});

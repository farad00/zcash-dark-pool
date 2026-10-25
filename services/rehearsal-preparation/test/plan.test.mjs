import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  proposal,
  validateProposal,
  proposalDigest,
  canonicalWindowsPath,
  pathsOverlap,
  reviewIsolation,
  reviewPrincipalBindings,
  planPurpose,
} from "../plan.mjs";
import { offlineReview } from "../review.mjs";
import { configuredTarget } from "../../../db/target-registry.mjs";
const context = () => ({
  localAppData: "C:\\Users\\Synthetic\\AppData\\Local",
  workspace: "C:\\Workspace\\zecathon\\zcash-dark-pool",
});
test("fixed proposal is nonfinancial, inactive, fresh and outside existing registry", () => {
  const p = proposal();
  assert.equal(p.port, 55436);
  assert.equal(p.database, "darkpool_testnet_observation_v1");
  assert.equal(p.kind, "UNFUNDED_REHEARSAL");
  assert.equal(p.chain_endpoint, "https://testnet.zec.rocks:443");
  assert(Object.values(p.identity).every((v) => v === null));
  assert.equal(p.financial_authorization, "NOT_GRANTED");
  assert.equal(p.production_trust, "UNAVAILABLE");
  assert.equal(validateProposal(p).real_process_launch_enabled, false);
  assert.throws(() =>
    configuredTarget({
      DARKPOOL_PG_ENV: p.kind,
      LOCALAPPDATA: context().localAppData,
      DARKPOOL_LIVE_INSTANCE: p.instance,
    }),
  );
  assert.equal(proposalDigest(p).length, 64);
});
test("no caller override can promote proposal, inherit identities or select protected/default targets", () => {
  for (const patch of [
    { port: 55432 },
    { port: 55433 },
    { port: 55434 },
    { port: 55435 },
    { port: 5432 },
    { host: "localhost" },
    { database: "postgres" },
    { kind: "LIVE_EVIDENCE" },
    { approval: "APPROVED" },
    { root: "C:\\Users\\Synthetic\\AppData\\Local\\ZcashDarkPoolDev" },
    { real_process_launch_enabled: true },
    { acceptance_enabled: true },
    { financial_authorization: "GRANTED" },
    { production_trust: "READY" },
    { spending_enabled: true },
    { key_import_enabled: true },
    { issuance_enabled: true },
    {
      identity: {
        ...proposal().identity,
        postgres_system_id: "7698884242696928048",
      },
    },
    { extra: "unknown" },
  ])
    assert.throws(
      () => validateProposal({ ...proposal(), ...patch }),
      /UNFUNDED_PLAN_REJECTED/,
    );
});
test("lexical model covers TEST/DEV/LIVE roots, source, witnesses and operator-specified backup locations", () => {
  const result = reviewIsolation(proposal(), context());
  assert.equal(result.isolation, "LEXICAL_MODEL_PASS");
  assert.equal(result.physical_preflight, "NOT_RUN");
  assert.equal(result.port_availability, "NOT_CHECKED");
  for (const reserved of [
    proposal().root,
    proposal().signer_root,
    proposal().off_device_proposal.root,
    "C:\\ProgramData\\ZcashDarkPoolRehearsal",
    "c:\\programdata\\zcashdarkpoolrehearsal\\TESTNET_OBSERVATION_V1\\viewer",
  ])
    assert.throws(() =>
      reviewIsolation(proposal(), {
        ...context(),
        additionalProtectedRoots: [reserved],
      }),
    );
  assert.throws(() =>
    reviewIsolation(proposal(), { ...context(), workspace: proposal().root }),
  );
  assert.throws(() =>
    reviewIsolation(proposal(), {
      ...context(),
      additionalProtectedRoots: [""],
    }),
  );
});
test("Windows aliases, UNC/devices, ADS, traversal, placeholders and special paths fail offline", () => {
  for (const path of [
    "relative",
    "\\\\server\\share",
    "\\\\?\\C:\\path",
    "C:relative",
    "C:\\path\\..\\protected",
    "C:\\path\\.\\file",
    "C:\\path\\file:stream",
    "C:\\path\\NUL.txt",
    "C:\\path\\COM1",
    "C:\\path\\trailing.",
    "C:\\path\\trailing ",
    "C:\\path\\\\double",
    "C:\\%LOCALAPPDATA%\\file",
    "C:\\path\\bad\0name",
  ])
    assert.throws(() => canonicalWindowsPath(path));
  assert.equal(
    canonicalWindowsPath("c:/ProgramData/Folder"),
    "c:\\programdata\\folder",
  );
  assert(pathsOverlap("C:\\Root\\Child", "c:\\root"));
  assert(!pathsOverlap("C:\\Root1", "C:\\Root10"));
});
test("planned PG grants cannot authorize intake, OPEN, reconciliation, settlement or spend", () => {
  const p = proposal();
  assert.deepEqual(p.roles.context.grants, [
    "CONNECT darkpool_testnet_observation_v1",
    "USAGE darkpool_watcher",
    "EXECUTE darkpool_watcher.context()",
  ]);
  for (const name of ["maintenance", "owner", "issue", "watch", "admin"]) {
    assert.equal(p.roles[name].login, false);
    assert.deepEqual(p.roles[name].grants, []);
  }
  assert.throws(() =>
    validateProposal({
      ...p,
      roles: {
        ...p.roles,
        context: {
          ...p.roles.context,
          grants: [
            ...p.roles.context.grants,
            "EXECUTE darkpool_watcher.reconcile(bigint,jsonb)",
          ],
        },
      },
    }),
  );
});
test("OS principal declarations require distinct non-well-known SIDs; actual memberships remain unverified", () => {
  const sids = Object.fromEntries(
    Object.keys(proposal().os_principals).map((name, i) => [
      name,
      "S-1-5-21-1-2-3-" + (1000 + i),
    ]),
  );
  assert.equal(
    reviewPrincipalBindings(sids).actual_accounts_and_memberships,
    "NOT_VERIFIED",
  );
  assert.throws(() =>
    reviewPrincipalBindings({ ...sids, web: sids.viewer_controller }),
  );
  for (const sid of ["S-1-5-18", "S-1-5-32-544", "S-1-1-0", "Admin", null])
    assert.throws(() => reviewPrincipalBindings({ ...sids, web: sid }));
});
test("launch manifests have fixed purposes/arguments, no child PG secrets and no executable activation", () => {
  for (const purpose of ["allocation", "scan", "observation"]) {
    const plan = planPurpose(proposal(), purpose, context());
    assert.equal(plan.enabled, false);
    assert.equal(plan.financial_authorization, "NOT_GRANTED");
    assert.equal(plan.spending_enabled, false);
    assert(
      !plan.child_environment_keys.some(
        (k) => /^PG/.test(k) || /SEED|SPENDING|SECRET_KEY/.test(k),
      ),
    );
    assert.equal(plan.arguments.length, 1);
    assert(plan.executable.startsWith(proposal().paths.runtime_bin + "\\"));
    assert.match(plan.wallet_access, /READ_WRITE/);
    assert(Object.isFrozen(plan));
  }
  assert.deepEqual(
    planPurpose(proposal(), "observation", context()).allowed_operations,
    ["observe"],
  );
  assert.equal(
    planPurpose(proposal(), "allocation", context()).database_role,
    null,
  );
  for (const op of [
    "sign",
    "broadcast",
    "issue",
    "open",
    "payout",
    "migrate",
    "arbitrary",
  ])
    assert.throws(() => planPurpose(proposal(), op, context()));
});
test("report is a model review, not proof of backups, physical permissions or readiness", () => {
  const result = offlineReview(context());
  assert.equal(result.scope, "OFFLINE_PROPOSAL_ONLY");
  assert.equal(result.review.approval, "PROPOSED_NOT_APPROVED");
  assert.equal(result.review.backup_custody, "NOT_CONFIGURED");
  assert(result.purposes.every((p) => !p.enabled));
});
test("runner has literal offline/storage/regression lists and no genuine launch hooks", async () => {
  const source = await readFile(
    new URL(
      "../../../scripts/dev/unfunded-preparation-tests.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /serve-allocation|serve-watcher|initdb|pg_ctl|Import-Clixml|cargo test|watcher\.test\.mjs|issuance\.test\.mjs|npm\s+(run\s+)?test/,
  );
  assert.match(
    source,
    /services\/rehearsal-preparation\/test\/storage\.test\.mjs/,
  );
});

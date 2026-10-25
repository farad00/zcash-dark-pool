import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { privateProcess } from "../../../backup/crypto.mjs";
import { accountProvisioningPlan, sha256 } from "../bootstrap-plan.mjs";
import { proposalDigest, proposal } from "../../plan.mjs";
import {
  windowsSecurityPlan,
  toolAccessPlan,
  persistentWindowsOperation,
  createWindowsFixtureAdapter,
  prepareWindowsFixtureAccounts,
  validateWindowsBindings,
  validateHostEvidence,
  reviewFixtureHost,
  verifyRuntimeInventory,
} from "../windows-security.mjs";
const sids = Object.fromEntries(
  accountProvisioningPlan().accounts.map((a, i) => [
    a.purpose,
    `S-1-5-21-111-222-333-${1000 + i}`,
  ]),
);
const records = () =>
  accountProvisioningPlan(sids).accounts.map((a) => ({
    purpose: a.purpose,
    name: a.name,
    sid: a.sid,
    enabled: false,
    local: true,
    groups: [],
    allow: a.allow,
    deny: a.deny,
  }));
const host = (purpose) => ({
  purpose,
  sid: sids[purpose],
  logon_type: ["signer", "backup_operator"].includes(purpose) ? 4 : 5,
  enabled: true,
  groups: [],
  token_privileges: [],
  profile_loaded: true,
  dpapi_roundtrip: true,
  cross_user_unprotect_denied: true,
  other_private_paths_denied: true,
  evidence: "REAL_WINDOWS_LOGON_TOKEN",
});
function provider(fault) {
  const log = [],
    accounts = [];
  return {
    log,
    accounts,
    async createAttempt() {
      log.push("attempt");
    },
    async assertNamesAbsent() {
      if (fault === "collision") throw Error("MODEL_COLLISION");
    },
    async createDisabledAccount(a) {
      if (fault === "interruption" && accounts.length === 2)
        throw Error("MODEL_INTERRUPTED");
      const r = records().find((r) => r.purpose === a.purpose);
      accounts.push(r);
      return {
        created: true,
        sid: fault === "substitution" ? sids.postgres : r.sid,
      };
    },
    async setRights() {},
    async record(value) {
      log.push(value);
    },
    async inspectAccounts() {
      return accounts;
    },
    async inspectHost(purpose) {
      return host(purpose);
    },
  };
}
test("persistent account, SCM and service launch gate is unconditional", () => {
  for (const a of [undefined, {}, { approved: true }, { test: true }])
    assert.throws(() => persistentWindowsOperation(a), /DISABLED/);
  const p = windowsSecurityPlan();
  assert.equal(p.account_creation, "DISABLED");
  assert.equal(p.service_start, "DISABLED");
  assert.equal(p.production_trust, "UNAVAILABLE");
  assert.equal(p.descriptor_sha256, proposalDigest(proposal()));
});
test("staged ACL stays unchanged and the separate runtime needs explicit approval", () => {
  const p = toolAccessPlan();
  assert.deepEqual(p.source_service_grants, []);
  assert.notEqual(p.runtime_copy, p.source);
  assert.equal(p.activation, "SEPARATE_APPROVAL_REQUIRED_NOT_COPIED");
  assert.equal(accountProvisioningPlan().tool_permissions.postgres, "NONE");
});
test("fixture account adapter orders durable SID records before rights; never enables accounts", async () => {
  const p = provider(),
    cap = createWindowsFixtureAdapter(p);
  const result = await prepareWindowsFixtureAccounts(cap);
  assert.equal(result.evidence, "MODEL_ONLY_NOT_WINDOWS_LOGON");
  assert.equal(p.log[0], "attempt");
  assert.equal(
    p.log.filter((x) => x.phase === "ACCOUNT_CREATED_DISABLED").length,
    5,
  );
  assert.ok(p.accounts.every((a) => a.enabled === false));
  assert.equal((await reviewFixtureHost(cap, "postgres")).launch, "DISABLED");
  await assert.rejects(prepareWindowsFixtureAccounts(cap));
  await assert.rejects(prepareWindowsFixtureAccounts({ ...cap }));
});
test("concurrent adapter attempts have exactly one winner", async () => {
  const p = provider(),
    cap = createWindowsFixtureAdapter(p);
  const r = await Promise.allSettled([
    prepareWindowsFixtureAccounts(cap),
    prepareWindowsFixtureAccounts(cap),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(p.log.filter((x) => x === "attempt").length, 1);
});
for (const fault of ["collision", "substitution", "interruption"])
  test(`adapter ${fault} quarantines without rollback adoption or retry`, async () => {
    const p = provider(fault),
      cap = createWindowsFixtureAdapter(p);
    await assert.rejects(prepareWindowsFixtureAccounts(cap));
    const snapshot = structuredClone(p.log);
    await assert.rejects(prepareWindowsFixtureAccounts(cap));
    assert.deepEqual(p.log, snapshot);
    await assert.rejects(reviewFixtureHost(cap, "postgres"));
  });
for (const [name, change] of Object.entries({
  "SID substitution": { sid: sids.web },
  "enabled prematurely": { enabled: true },
  "group privilege": { groups: ["S-1-5-32-544"] },
  "domain identity": { local: false },
  "missing logon denial": { deny: [] },
  "extra logon right": {
    allow: ["SeServiceLogonRight", "SeInteractiveLogonRight"],
  },
}))
  test(`five-account validation rejects ${name}`, () => {
    const r = records();
    r[0] = { ...r[0], ...change };
    assert.throws(() => validateWindowsBindings(r, sids));
  });
for (const [name, change] of Object.entries({
  "operator DPAPI only": { evidence: "CURRENT_USER_ONLY" },
  "wrong SID": { sid: sids.web },
  "interactive token": { logon_type: 2 },
  "profile missing": { profile_loaded: false },
  "DPAPI failure": { dpapi_roundtrip: false },
  "cross-user decrypt": { cross_user_unprotect_denied: false },
  "private path accessible": { other_private_paths_denied: false },
  "token privilege": { token_privileges: ["SeBackupPrivilege"] },
}))
  test(`host boundary rejects ${name}`, () => {
    assert.throws(() =>
      validateHostEvidence("postgres", sids, {
        ...host("postgres"),
        ...change,
      }),
    );
  });
test("on-demand signer/recovery require batch tokens; no service host can substitute", () => {
  for (const p of ["signer", "backup_operator"]) {
    assert.equal(validateHostEvidence(p, sids, host(p)).launch, "DISABLED");
    assert.throws(() =>
      validateHostEvidence(p, sids, { ...host(p), logon_type: 5 }),
    );
  }
});
function toolFixture() {
  const files = [
    "bin/synthetic.exe",
    "lib/synthetic.dll",
    "share/catalog.txt",
    "server_license.txt",
    "commandlinetools_3rd_party_licenses.txt",
  ].map((path) => ({ path, size: 1, sha256: sha256(Buffer.from("x")) }));
  const expected = { scope: "SYNTHETIC_RUNTIME_ONLY", files };
  return [
    expected,
    {
      scope: expected.scope,
      files: structuredClone(files),
      owner: "S-1-5-32-544",
      protected_dacl: true,
      reparse: false,
      hardlinks: false,
      complete: true,
      acl: [
        { sid: "S-1-5-18", rights: "FullControl" },
        { sid: "S-1-5-32-544", rights: "FullControl" },
        { sid: sids.postgres, rights: "ReadAndExecute" },
        { sid: sids.backup_operator, rights: "ReadAndExecute" },
      ],
    },
  ];
}
test("runtime-copy inventory rejects missing files, changed hashes, unsafe ownership, reparse and writable tools", () => {
  const [expected, actual] = toolFixture();
  assert.equal(
    verifyRuntimeInventory(expected, actual, sids).execution,
    "DISABLED",
  );
  for (const change of [
    { files: [] },
    { reparse: true },
    { hardlinks: true },
    { complete: false },
    { owner: sids.postgres },
    { protected_dacl: false },
    { acl: [...actual.acl, { sid: sids.web, rights: "ReadAndExecute" }] },
    {
      acl: actual.acl.map((a) =>
        a.sid === sids.postgres ? { ...a, rights: "Modify" } : a,
      ),
    },
  ])
    assert.throws(() =>
      verifyRuntimeInventory(expected, { ...actual, ...change }, sids),
    );
  const changed = structuredClone(actual);
  changed.files[0].sha256 = "0".repeat(64);
  assert.throws(() => verifyRuntimeInventory(expected, changed, sids));
});
const script = fileURLToPath(
  new URL(
    "../../../../scripts/dev/observation-windows-security.ps1",
    import.meta.url,
  ),
);
const ps = async (action, extra = [], env = {}) =>
  JSON.parse(
    (
      await privateProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Action",
          action,
          ...extra,
        ],
        Buffer.alloc(0),
        4096,
        env,
      )
    ).toString(),
  );
test("native Windows adapter reports capability honestly and all persistent operations reject", async () => {
  const r = await ps("Capabilities");
  assert.equal(r.actual_cross_account_test, "NOT_RUN");
  assert.equal(r.actual_service_user_dpapi, "NOT_RUN");
  for (const action of ["CreateAccounts", "InstallHost", "StartHost"])
    await assert.rejects(ps(action));
  await assert.rejects(
    ps("FixtureAccess", [
      "-Directory",
      "C:\\ProgramData\\ZcashDarkPoolRehearsal\\testnet_observation_v1",
    ]),
  );
});
test("Windows native Authz evaluates 65 SID-only access assertions on protected disposable NTFS DACLs", async () => {
  const root = join(
    tmpdir(),
    "darkpool-backup-fixture-" + randomBytes(16).toString("hex"),
  );
  const storage = fileURLToPath(
    new URL(
      "../../../../scripts/dev/backup-fixture-storage.ps1",
      import.meta.url,
    ),
  );
  await privateProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      storage,
      "-Action",
      "create",
      "-Directory",
      root,
    ],
    Buffer.alloc(0),
    4096,
    { DARKPOOL_BACKUP_TEST_ONLY: "1" },
  );
  const st = await lstat(root),
    nonce = randomBytes(16).toString("hex");
  const scope = JSON.stringify({
    scope: "WINDOWS_SECURITY_FIXTURE_ONLY",
    root,
    nonce,
  });
  const file = await open(join(root, "security-scope.json"), "wx");
  try {
    await file.writeFile(scope);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    const r = await ps("FixtureAccess", ["-Directory", root], {
      DARKPOOL_OBSERVATION_V1_TEST_ONLY: "1",
      DARKPOOL_BACKUP_TEST_ONLY: "1",
    });
    assert.equal(r.status, "WINDOWS_AUTHZ_FIXTURE_PASS");
    assert.equal(r.checks, 65);
    assert.equal(r.actual_service_user_dpapi, "NOT_RUN");
  } finally {
    const now = await lstat(root);
    assert.equal(now.dev, st.dev);
    assert.equal(now.ino, st.ino);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.equal(
      await readFile(join(root, "security-scope.json"), "utf8"),
      scope,
    );
    async function inspect(path) {
      const st = await lstat(path);
      assert.equal(st.isSymbolicLink(), false);
      if (st.isDirectory())
        for (const name of await readdir(path)) await inspect(join(path, name));
      else {
        assert.equal(st.isFile(), true);
        assert.equal(st.nlink, 1);
      }
    }
    await inspect(root);
    await rm(root, { recursive: true, force: false });
    console.log(
      "WINDOWS_SECURITY_FIXTURE_CLEANUP " +
        JSON.stringify({ root, cleaned: true }),
    );
  }
});

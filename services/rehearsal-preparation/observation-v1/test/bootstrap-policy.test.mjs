import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { privateProcess } from "../../../backup/crypto.mjs";
import { proposal } from "../../plan.mjs";
import {
  persistentBootstrapPlan,
  accountProvisioningPlan,
  assertPersistentExecution,
  roleCreationSql,
  schemaSql,
  hbaConfiguration,
  postgresConfiguration,
  validateLayout,
} from "../bootstrap-plan.mjs";
import {
  computerBRecoveryPlan,
  recoveryTransferManifest,
  verifyRecoveryTransfer,
} from "../bootstrap-recovery.mjs";
const layout = {
  scope: "DISPOSABLE_TEST_ONLY",
  nonce: "a".repeat(32),
  port: 59001,
  database: "darkpool_physical_" + "a".repeat(16),
  system_identifier: "7700000000000000001",
  roles: {
    maintenance: "darkpool_physical_admin_" + "a".repeat(16),
    owner: "darkpool_physical_owner_" + "a".repeat(16),
    context: "darkpool_physical_read_" + "a".repeat(16),
  },
};
test("persistent release is disabled even with synthetic proofs, switches or approval booleans", () => {
  const p = persistentBootstrapPlan();
  assert.equal(
    p.production_backend,
    "DISABLED_PENDING_ACCOUNT_AND_RECOVERY_REVIEW",
  );
  assert.equal(p.initialization.permission_to_execute, false);
  assert.ok(p.initialization.arguments.includes("--no-clean"));
  for (const a of [
    undefined,
    {},
    true,
    { approved: true },
    { scope: "DISPOSABLE_TEST_ONLY" },
  ])
    assert.throws(() => assertPersistentExecution(proposal(), a));
});
test("fixed descriptor rejects retargeting and financial relabeling", () => {
  for (const change of [
    { port: 55435 },
    { root: "C:\\other" },
    { financial_authorization: "GRANTED" },
  ])
    assert.throws(() => persistentBootstrapPlan({ ...proposal(), ...change }));
});
test("five account plan defaults disabled with distinct roles, no privileged groups and role-specific logon denials", () => {
  const p = accountProvisioningPlan();
  assert.equal(p.accounts.length, 5);
  for (const a of p.accounts) {
    assert.equal(a.initially_disabled, true);
    assert.deepEqual(a.explicit_group_memberships, []);
    assert.ok(a.deny.includes("SeDenyInteractiveLogonRight"));
    assert.ok(a.deny.includes("SeDenyNetworkLogonRight"));
  }
  assert.equal(p.tool_permissions.recursive_write, false);
  assert.equal(p.tool_permissions.web, "NONE");
  assert.equal(p.actual_cross_account_access, "NOT_TESTED");
  assert.equal(p.actual_service_user_dpapi, "NOT_TESTED");
});
test("SID duplicates, administrator SID and unknown role cannot become a five-account binding", () => {
  const sids = Object.fromEntries(
    Object.keys(proposal().os_principals).map((k, i) => [
      k,
      `S-1-5-21-1-2-3-${100 + i}`,
    ]),
  );
  assert.equal(accountProvisioningPlan(sids).accounts.length, 5);
  assert.throws(() => accountProvisioningPlan({ ...sids, web: sids.postgres }));
  assert.throws(() =>
    accountProvisioningPlan({ ...sids, postgres: "S-1-5-32-544" }),
  );
  assert.throws(() => accountProvisioningPlan({ ...sids, unknown: sids.web }));
});
test("disposable SQL layout rejects all protected ports and caller role injection", () => {
  for (const port of [5432, 55432, 55433, 55434, 55435, 55436])
    assert.throws(() => validateLayout({ ...layout, port }));
  assert.throws(() =>
    validateLayout({
      ...layout,
      roles: { ...layout.roles, context: "postgres" },
    }),
  );
  assert.throws(() => validateLayout({ ...layout, database: "postgres" }));
  for (const id of [
    "7697706083887339692",
    "7697541254856017064",
    "7698884242696928048",
  ])
    assert.throws(() => validateLayout({ ...layout, system_identifier: id }));
});
test("role SQL constrains context authority and never installs product migrations", () => {
  const sql = roleCreationSql(layout, "b".repeat(64));
  assert.match(sql, /NOLOGIN NOINHERIT NOSUPERUSER/);
  assert.match(sql, /default_transaction_read_only=on/);
  assert.throws(() => roleCreationSql(layout, "'bad"));
  assert.doesNotMatch(
    schemaSql(layout),
    /CREATE TABLE (?:tickets|markets|claims|payout)/i,
  );
  assert.match(
    schemaSql(layout),
    /BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE/,
  );
});
test("HBA allowlists database and identity then explicitly rejects IPv4 and IPv6", () => {
  const hba = hbaConfiguration(layout);
  assert.ok(
    hba.endsWith("host all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n"),
  );
  assert.doesNotMatch(hba, /trust|md5/);
  assert.match(hba, /127\.0\.0\.1\/32 scram-sha-256/);
});
test("PG configuration keeps loopback durability and redacted logging", () => {
  const text = postgresConfiguration(layout, "C:\\fixture\\data");
  for (const setting of [
    "listen_addresses='127.0.0.1'",
    "fsync=on",
    "synchronous_commit=on",
    "full_page_writes=on",
    "log_statement='none'",
    "log_min_error_statement='panic'",
  ])
    assert.ok(text.includes(setting));
  assert.throws(() => postgresConfiguration(layout, "bad\nport=55434"));
});
test("Computer B plan keeps offline keys and plaintext credentials out of transfer", () => {
  const p = computerBRecoveryPlan();
  assert.equal(p.actual_retention, "NOT_PROVEN");
  assert.equal(p.actual_computer_b_restore, "NOT_PROVEN");
  assert.ok(p.excluded.includes("OFFLINE_RECOVERY_PRIVATE_KEY"));
});
test("transfer integrity is explicitly weaker than decryption, retention and authorization", () => {
  const bytes = Buffer.from("SYNTHETIC_ENCRYPTED_FILE_NOT_REAL_BACKUP");
  const { descriptor_sha256 } = persistentBootstrapPlan();
  // Literal SHA-256 independently checked by the native crypto module in this test.
  return import("node:crypto").then(({ createHash }) => {
    const receipt = {
      scope: "DISPOSABLE_BOOTSTRAP_ONLY",
      nonce: "a".repeat(32),
      system_identifier: layout.system_identifier,
      descriptor_sha256,
      inventory_sha256: "b".repeat(64),
      journal_sha256: "c".repeat(64),
      ciphertext_sha256: createHash("sha256").update(bytes).digest("hex"),
      financial_authorization: "NOT_GRANTED",
    };
    const manifest = recoveryTransferManifest(receipt),
      r = verifyRecoveryTransfer(manifest, bytes);
    assert.equal(r.decryption, "NOT_PROVEN");
    assert.equal(r.off_device_retention, "NOT_PROVEN");
    assert.throws(() =>
      verifyRecoveryTransfer(manifest, Buffer.from("altered")),
    );
    assert.throws(() =>
      verifyRecoveryTransfer(
        { ...manifest, financial_authorization: "GRANTED" },
        bytes,
      ),
    );
    assert.throws(() =>
      verifyRecoveryTransfer({ ...manifest, extra: true }, bytes),
    );
  });
});
test("same-current-user DPAPI protects only synthetic bytes; wrong SID fails closed", async () => {
  const sid = (
    await privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      Buffer.alloc(0),
      512,
    )
  )
    .toString()
    .trim();
  assert.match(sid, /^S-1-5-21-/);
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    fileURLToPath(
      new URL(
        "../../../../scripts/dev/observation-bootstrap-dpapi-probe.ps1",
        import.meta.url,
      ),
    ),
    "-ExpectedSid",
  ];
  const r = JSON.parse(
    (
      await privateProcess(
        "powershell.exe",
        [...args, sid],
        Buffer.alloc(0),
        4096,
        { DARKPOOL_OBSERVATION_V1_TEST_ONLY: "1" },
      )
    ).toString(),
  );
  assert.equal(r.status, "PASS");
  assert.equal(r.service_user, "NOT_TESTED");
  assert.equal(r.cross_account, "NOT_TESTED");
  await assert.rejects(
    privateProcess(
      "powershell.exe",
      [...args, "S-1-5-21-1-2-3-999"],
      Buffer.alloc(0),
      4096,
      { DARKPOOL_OBSERVATION_V1_TEST_ONLY: "1" },
    ),
  );
});
test("inert CLI plan contains no mutable target capability or credential", async () => {
  const r = JSON.parse(
    (
      await privateProcess(
        process.execPath,
        [
          fileURLToPath(new URL("../bootstrap-cli.mjs", import.meta.url)),
          "plan",
        ],
        Buffer.alloc(0),
        16384,
      )
    ).toString(),
  );
  assert.equal(r.status, "BOOTSTRAP_PLAN_ONLY");
  assert.equal(r.plan.financial_authorization, "NOT_GRANTED");
  await assert.rejects(
    privateProcess(
      process.execPath,
      [
        fileURLToPath(new URL("../bootstrap-cli.mjs", import.meta.url)),
        "create",
      ],
      Buffer.alloc(0),
      4096,
    ),
  );
});

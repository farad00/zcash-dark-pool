// Ordinary temporary identity files only: no live cluster, wallet or chain use.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  approvedTarget,
  configuredTarget,
  initializerPlan,
  assertLiveComponent,
  assertWalletTarget,
  liveWalletPath,
  assertEvidenceTarget,
  assertLiveInvocation,
  assertChildTarget,
  assertMutableTarget,
  assertProvisionTarget,
} from "../target-registry.mjs";
import {
  validateEnvironment,
  loadEnvironmentGuard,
  assertFixtureSql,
} from "../environment.mjs";
import { markerText } from "../environment-identity.mjs";
import { bindPublicReaderTarget } from "../public-reader-runtime.mjs";
import { requireInternalEnvironment } from "../../apps/web/src/admin.mjs";
import { issuanceEnvironment } from "../issuance-runtime.mjs";
import { watcherEnvironment } from "../../services/watcher/db.mjs";
import { walletEnvironment } from "../../services/watcher/main.mjs";
import { walletPreparationPlan } from "../../scripts/dev/wallet-target.mjs";
import { planTarget } from "../../scripts/dev/target-plan.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { auditPublicClosure } from "../../apps/web/test/public-capability-graph.mjs";
import { allocateInternal } from "../../apps/web/src/issuance.mjs";
import { createPublicServer } from "../../apps/web/src/public-server.mjs";

const v1 = "phase9_payment_v1",
  v2 = "phase9_payment_v2";
const base = join(tmpdir(), "darkpool-registry-pure");
const target = (instance) => approvedTarget("LIVE_EVIDENCE", base, instance);
function sample(instance = v2, local = base) {
  const layout = approvedTarget("LIVE_EVIDENCE", local, instance);
  const profile = {
    version: 1,
    kind: "LIVE_EVIDENCE",
    ...(instance === v2 ? { instance } : {}),
    cluster_id: layout.expected_cluster_id ?? randomUUID(),
    host: "127.0.0.1",
    port: layout.port,
    data_directory: layout.data,
    system_identifier:
      layout.expected_system_identifier ?? "7654321098765432101",
    directory_identity: { dev: "1", ino: "2" },
    maintenance_user: layout.maintenance,
  };
  const env = {
    LOCALAPPDATA: local,
    DARKPOOL_PG_ENV: "LIVE_EVIDENCE",
    DARKPOOL_LIVE_INSTANCE: instance,
    DARKPOOL_PG_PROFILE: layout.profile,
    PGHOST: "127.0.0.1",
    PGPORT: String(layout.port),
    PGUSER: layout.maintenance,
    PGDATABASE: layout.database,
    ZCASH_NETWORK: "testnet",
    PGPASSWORD: "synthetic-only",
    PSQL_PATH: "must-never-spawn",
    APP_ENV: "development",
  };
  return { layout, profile, env };
}
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "darkpool-registry-"));
  try {
    return await run(directory);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("darkpool-registry-"));
    await rm(directory, { recursive: true, force: true });
  }
}
async function identityFixture(instance, run) {
  return temporary(async (directory) => {
    const value = sample(instance, directory),
      { layout, profile } = value;
    await mkdir(join(layout.data, "global"), { recursive: true });
    const info = await stat(layout.data);
    profile.directory_identity = {
      dev: String(info.dev),
      ino: String(info.ino),
    };
    const control = Buffer.alloc(8);
    control.writeBigUInt64LE(BigInt(profile.system_identifier));
    const save = async () => {
      await writeFile(layout.profile, JSON.stringify(profile));
      await writeFile(layout.marker, markerText(profile));
      await writeFile(join(layout.data, "global", "pg_control"), control);
    };
    await save();
    return run({ ...value, control, save });
  });
}

test("registry freezes the exact v1 mapping and legacy identity", () => {
  const t = target(v1);
  assert.equal(t.port, 55434);
  assert.equal(t.database, "darkpool_phase9_evidence_payment_v1");
  assert.equal(
    t.data,
    join(
      base,
      "ZcashDarkPoolDev/postgres-live-evidence/phase9_payment_v1/data",
    ),
  );
  assert.equal(
    t.signer,
    join(base, "ZcashDarkPoolDev/phase9/live_payment_v1/signer"),
  );
  assert.equal(
    t.watcher,
    join(base, "ZcashDarkPoolDev/phase9/live_payment_v1/view-only"),
  );
  assert.equal(t.roles.read, "darkpool_live_read");
  assert.equal(t.expected_system_identifier, "7697706083887339692");
  assert.ok(t.preserved && Object.isFrozen(t));
  const { profile, env } = sample(v1);
  assert.equal(validateEnvironment(profile, env).port, 55434);
  assert.ok(!markerText(profile).includes('"instance"'));
});
test("registry freezes exact v2 identities with disjoint paths ports databases and roles", () => {
  const a = target(v1),
    b = target(v2);
  assert.equal(b.port, 55435);
  assert.equal(b.database, "darkpool_phase9_evidence_payment_v2");
  assert.equal(
    b.data,
    join(
      base,
      "ZcashDarkPoolDev/postgres-live-evidence/phase9_payment_v2/data",
    ),
  );
  assert.equal(b.signer, join(b.root, "protected/signer"));
  assert.equal(b.watcher, join(b.root, "protected/watcher"));
  assert.equal(b.evidence, join(b.root, "protected/evidence"));
  for (const key of [
    "root",
    "data",
    "profile",
    "marker",
    "signer",
    "watcher",
    "evidence",
    "port",
    "database",
    "maintenance",
  ])
    assert.notEqual(a[key], b[key]);
  assert.equal(
    new Set([...Object.values(a.roles), ...Object.values(b.roles)]).size,
    12,
  );
});
test("unknown malformed absent and non-string LIVE instances fail closed", () => {
  for (const instance of [
    undefined,
    "",
    v2 + "_extra",
    "../" + v2,
    "__proto__",
    [v2],
    {},
    "PHASE9_PAYMENT_V2",
  ])
    assert.throws(() => target(instance), /POSTGRES_TARGET_REJECTED/);
});
test("HISTORICAL and TEST with a LIVE selector fail closed", () => {
  assert.throws(() => approvedTarget("HISTORICAL", base));
  assert.throws(() => approvedTarget("TEST", base, v1));
  assert.throws(() => approvedTarget("TEST", base, v2));
  assert.equal(approvedTarget("TEST", base).port, 55433);
});
for (const [name, edit] of [
  [
    "v1 path with v2 identity",
    ({ profile }) => (profile.data_directory = target(v1).data),
  ],
  ["v2 path with v1 identity", ({ env }) => (env.DARKPOOL_LIVE_INSTANCE = v1)],
  ["v1 port with v2 identity", ({ env }) => (env.PGPORT = "55434")],
  [
    "wrong canonical database",
    ({ env }) => (env.PGDATABASE = target(v1).database),
  ],
  [
    "wrong credential identity",
    ({ env }) => (env.PGUSER = target(v1).roles.maintenance),
  ],
  [
    "cross-instance password file",
    ({ env }) => (env.PGPASSFILE = join(target(v1).root, "maintenance.pgpass")),
  ],
  ["missing v2 marker instance", ({ profile }) => delete profile.instance],
  [
    "reused old LIVE system ID",
    ({ profile }) => (profile.system_identifier = "7697706083887339692"),
  ],
  [
    "reused TEST system ID",
    ({ profile }) => (profile.system_identifier = "7697541254856017064"),
  ],
  [
    "reused old marker UUID",
    ({ profile }) =>
      (profile.cluster_id = "0c39a4b7-f37f-4fde-b81d-502d61724e52"),
  ],
  [
    "reused TEST marker UUID",
    ({ profile }) =>
      (profile.cluster_id = "8a0bf1f9-e2e5-4af4-b449-90ab32d950af"),
  ],
])
  test(`target rejection: ${name}`, () => {
    const value = sample();
    edit(value);
    assert.throws(
      () => validateEnvironment(value.profile, value.env),
      /POSTGRES_TARGET_REJECTED/,
    );
  });

test("synthetic approved v2 profile control and marker validate without any SQL", async () =>
  identityFixture(v2, async ({ env }) => {
    const bound = await loadEnvironmentGuard(env, {
      requireKind: "LIVE_EVIDENCE",
    });
    assert.match(bound.prefix, /55435/);
    assert.match(bound.prefix, /payment_v2/);
  }));
test("legacy v1 profile remains recognizable using explicit instance and unchanged marker bytes", async () =>
  identityFixture(v1, async ({ env }) => {
    await loadEnvironmentGuard(env, { requireKind: "LIVE_EVIDENCE" });
    assert.throws(() =>
      assertLiveComponent({ ...env, PGUSER: target(v1).roles.admin }, "admin"),
    );
  }));
test("v2 wrong marker and actual control system ID reject before any SQL", async () =>
  identityFixture(v2, async ({ env, layout, control, save }) => {
    await writeFile(layout.marker, "{}");
    await assert.rejects(
      loadEnvironmentGuard(env, { requireKind: "LIVE_EVIDENCE" }),
    );
    await save();
    control.writeBigUInt64LE(7654321098765432102n);
    await save();
    await assert.rejects(
      loadEnvironmentGuard(env, { requireKind: "LIVE_EVIDENCE" }),
    );
  }));
test("TEST destructive clients reject both approved LIVE instances and names", async () => {
  for (const instance of [v1, v2]) {
    const { profile, env } = sample(instance);
    assert.throws(() =>
      validateEnvironment(
        profile,
        { ...env, DARKPOOL_TEST_ONLY: "TEST_ONLY" },
        { requireKind: "TEST" },
      ),
    );
    for (const op of ["CREATE", "DROP"])
      assert.throws(() =>
        assertFixtureSql(`${op} DATABASE ${target(instance).database};`),
      );
  }
});
test("HISTORICAL and TEST evidence capture reject preserved target paths before writes", async () => {
  await assert.rejects(
    assertEvidenceTarget(join(base, "new"), { DARKPOOL_PG_ENV: "HISTORICAL" }),
  );
  for (const instance of [v1, v2])
    await assert.rejects(
      assertEvidenceTarget(join(target(instance).root, "capture"), {
        DARKPOOL_PG_ENV: "TEST",
        LOCALAPPDATA: base,
      }),
    );
});
test("unknown environment knobs cannot override reviewed registry properties", () => {
  const { profile, env } = sample();
  const changed = {
    ...env,
    DARKPOOL_TARGET_ROOT: "C:/elsewhere",
    DARKPOOL_TARGET_PORT: "55434",
    DARKPOOL_TARGET_DATABASE: target(v1).database,
    DARKPOOL_INSTANCE: v1,
  };
  assert.deepEqual(configuredTarget(changed), configuredTarget(env));
  assert.equal(validateEnvironment(profile, changed).port, 55435);
  for (const key of [
    "PGOPTIONS",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGHOSTADDR",
    "DATABASE_URL",
  ])
    assert.throws(() =>
      validateEnvironment(profile, { ...env, [key]: "override" }),
    );
});
test("admin issuer and watcher agree on a single approved v2 role and reject v1 credentials", () => {
  const { env, layout } = sample();
  requireInternalEnvironment({
    ...env,
    PGUSER: layout.roles.admin,
    DARKPOOL_ADMIN_INTERNAL: "1",
  });
  issuanceEnvironment({
    ...env,
    PGUSER: layout.roles.issue,
    DARKPOOL_ISSUANCE_INTERNAL: "1",
  });
  watcherEnvironment({
    ...env,
    PGUSER: layout.roles.watch,
    DARKPOOL_WATCHER_INTERNAL: "1",
  });
  for (const role of ["admin", "issue", "watch"])
    assert.throws(() =>
      assertLiveComponent({ ...env, PGUSER: target(v1).roles[role] }, role),
    );
});
test("v2 credential identities cannot authenticate the preserved v1 target", () => {
  const { env, profile } = sample(v1);
  for (const role of Object.keys(target(v2).roles))
    assert.throws(() =>
      validateEnvironment(profile, { ...env, PGUSER: target(v2).roles[role] }),
    );
});
test("evidence child cannot switch the parent's instance database port or wallet", () => {
  const { env } = sample();
  for (const patch of [
    { DARKPOOL_LIVE_INSTANCE: v1 },
    { PGPORT: "55434" },
    { PGDATABASE: target(v1).database },
    { PGUSER: target(v1).roles.read },
    { WALLET_DB_PATH: join(target(v1).watcher, "data.sqlite") },
  ])
    assert.throws(() => assertChildTarget(env, patch));
});
test("issuer v2 sends its instance binding so a legacy v1 allocation transport cannot accept it", async () => {
  let fields;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const frame = Buffer.concat(chunks);
      fields = [];
      for (let cursor = 0; cursor < frame.length;) {
        const n = frame.readUInt32BE(cursor);
        cursor += 4;
        fields.push(frame.subarray(cursor, cursor + n).toString());
        cursor += n;
      }
      socket.end(Buffer.alloc(4));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { env, layout } = sample();
    await assert.rejects(
      allocateInternal(
        {
          market_id: "synthetic",
          vault_context_ref: "synthetic",
          ticket_id: "a".repeat(64),
          claim_commitment: "b".repeat(64),
        },
        {
          ...env,
          PGUSER: layout.roles.issue,
          ALLOCATION_AUTH: "c".repeat(64),
          ALLOCATION_PORT: String(server.address().port),
        },
      ),
      /ISSUANCE_RECONCILE_REQUIRED/,
    );
    assert.equal(fields.length, 6);
    assert.equal(fields[5], v2);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
test("issuer allocator watcher and signer paths cannot resolve the v1 wallet or another purpose", () => {
  const { env } = sample();
  const path = liveWalletPath(env, "watcher");
  assertWalletTarget({ ...env, WALLET_DB_PATH: path });
  assert.equal(
    walletEnvironment({
      ...env,
      WALLET_DB_PATH: path,
      CHAIN_ENDPOINT: "https://synthetic.invalid",
    }).DARKPOOL_LIVE_INSTANCE,
    v2,
  );
  for (const wrong of [
    join(target(v1).watcher, "data.sqlite"),
    join(target(v1).signer, "data.sqlite"),
    liveWalletPath(env, "signer"),
  ])
    assert.throws(() => assertWalletTarget({ ...env, WALLET_DB_PATH: wrong }));
  const plan = walletPreparationPlan(env);
  assert.equal(plan.signer_db, liveWalletPath(env, "signer"));
  assert.equal(plan.watcher_db, path);
  assert.equal(plan.resource_creation, false);
  assert.throws(() =>
    walletPreparationPlan({
      ...env,
      WALLET_DB_PATH: join(target(v1).signer, "data.sqlite"),
    }),
  );
});
test("reviewed signer and view-import invocations reject v1 arguments before execution", () => {
  const { env } = sample(),
    plan = walletPreparationPlan(env);
  assert.deepEqual(plan.account_arguments, [
    "wallet",
    "--wallet-dir",
    target(v2).signer,
    "init",
    "--name",
    "phase9-live-payment-v2",
    "--identity",
    join(target(v2).signer, "identity.txt"),
    "-n",
    "test",
    "-s",
    "zecrocks",
    "--connection",
    "direct",
  ]);
  assertLiveInvocation("zcash-devtool.exe", plan.account_arguments, env);
  assertLiveInvocation(
    "phase1_view_import.exe",
    plan.view_import_arguments,
    env,
  );
  assert.throws(() =>
    assertLiveInvocation(
      "zcash-devtool.exe",
      ["--wallet-dir", target(v1).signer, "account", "new"],
      env,
    ),
  );
  assert.throws(() =>
    assertLiveInvocation(
      "phase1_view_import.exe",
      [join(target(v1).signer, "data.sqlite"), target(v2).watcher],
      env,
    ),
  );
  assert.throws(() =>
    assertLiveInvocation(
      "phase1_view_import.exe",
      [plan.signer_db, target(v1).watcher],
      env,
    ),
  );
});

test("preserved mutation and cross-instance provisioning fail before SQL", () => {
  assert.throws(() => assertMutableTarget(sample(v1).env));
  assert.throws(() => assertMutableTarget({ DARKPOOL_PG_ENV: "HISTORICAL" }));
  const { env, layout } = sample();
  for (const purpose of ["admin", "issue", "watch", "read"]) {
    assertProvisionTarget(layout.roles[purpose], purpose, env);
    assert.throws(() =>
      assertProvisionTarget(target(v1).roles[purpose], purpose, env),
    );
    assert.throws(() =>
      assertProvisionTarget(layout.roles[purpose], purpose, {
        ...env,
        PGUSER: layout.roles.read,
      }),
    );
    assert.throws(() =>
      assertProvisionTarget(target(v1).roles[purpose], purpose, sample(v1).env),
    );
  }
});

test("nonempty tablespaces are rejected before any SQL", async () =>
  identityFixture(v2, async ({ env, layout }) => {
    await mkdir(join(layout.data, "pg_tblspc"));
    await writeFile(join(layout.data, "pg_tblspc", "collision"), "synthetic");
    await assert.rejects(
      loadEnvironmentGuard(env, { requireKind: "LIVE_EVIDENCE" }),
    );
  }));

test("v1 bootstrap write commands reject before any SQL or file creation", async () =>
  temporary(async (directory) => {
    for (const command of ["profile", "initialize-marker", "complete"]) {
      const { env } = sample(v1, directory);
      const result = await runBounded(
        process.execPath,
        ["db/environment-bootstrap.mjs", command],
        {
          timeoutMs: 4000,
          env: { ...process.env, ...env, NODE_TEST_CONTEXT: undefined },
        },
      );
      assert.notEqual(boundedExit(result), 0);
      assert.match(result.stderr, /POSTGRES_TARGET_REJECTED/);
      assert.deepEqual(await readdir(directory), []);
    }
  }));

test("initializer rejects credential signer and watcher collisions without creating a cluster", async () =>
  temporary(async (directory) => {
    const layout = approvedTarget("LIVE_EVIDENCE", directory, v2);
    for (const collision of [
      join(layout.root, "maintenance.xml"),
      join(layout.signer, "data.sqlite"),
      join(layout.watcher, "data.sqlite"),
    ]) {
      await mkdir(dirname(collision), { recursive: true });
      await writeFile(collision, "synthetic-only");
    }
    const result = await runBounded(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("scripts/dev/postgres-isolated.ps1"),
        "-Kind",
        "LIVE_EVIDENCE",
        "-Instance",
        v2,
        "-Create",
        "-Worker",
      ],
      { timeoutMs: 15000, env: { ...process.env, LOCALAPPDATA: directory } },
    );
    assert.notEqual(boundedExit(result), 0);
    assert.match(result.stderr, /Isolated root already exists/);
    for (const collision of [
      join(layout.root, "maintenance.xml"),
      join(layout.signer, "data.sqlite"),
      join(layout.watcher, "data.sqlite"),
    ])
      assert.equal(await readFile(collision, "utf8"), "synthetic-only");
    await assert.rejects(stat(layout.data), { code: "ENOENT" });
  }));
test("new LIVE evidence capture rejects v1 paths and sibling-prefix traversal", async () => {
  const { env } = sample();
  await assertEvidenceTarget(join(target(v2).evidence, "new-run"), env);
  for (const path of [
    join(target(v1).evidence, "new-run"),
    target(v2).evidence + "-sibling/run",
    join(target(v2).evidence, "..", "outside"),
  ])
    await assert.rejects(assertEvidenceTarget(path, env));
});
test("public reader binds synthetic v2 once and rejects a v1 credential or database", async () =>
  identityFixture(v2, async ({ env, layout }) => {
    env.PGUSER = layout.roles.read;
    const reader = await bindPublicReaderTarget(env);
    assert.equal(reader.connection.PGPORT, "55435");
    assert.equal(
      reader.connection.PGDATABASE,
      "darkpool_phase9_evidence_payment_v2",
    );
    await assert.rejects(
      bindPublicReaderTarget({ ...env, PGUSER: target(v1).roles.read }),
    );
    await assert.rejects(
      bindPublicReaderTarget({ ...env, PGDATABASE: target(v1).database }),
    );
    env.DARKPOOL_LIVE_INSTANCE = v1;
    env.PGPORT = "55434";
    await reader.verify();
    assert.equal(reader.connection.PGPORT, "55435");
  }));
test("public recursive boundary cannot import target-management APIs or accept target arguments", async () => {
  const path = "db/public-reader-runtime.mjs",
    source = await readFile(
      new URL("../public-reader-runtime.mjs", import.meta.url),
      "utf8",
    );
  await assert.rejects(
    auditPublicClosure(
      new Map([[path, source + "\nexport * from './target-registry.mjs';"]]),
    ),
    /forbidden capability/,
  );
  const httpPath = "apps/web/src/public-server.mjs",
    http = await readFile(
      new URL("../../apps/web/src/public-server.mjs", import.meta.url),
      "utf8",
    );
  await assert.rejects(
    auditPublicClosure(
      new Map([
        [
          httpPath,
          http.replace(
            "await readMarket()",
            "await readMarket({ instance: 'phase9_payment_v2' })",
          ),
        ],
      ]),
    ),
  );
});
test("public HTTP cannot select an instance or database through request parameters", async () => {
  let reads = 0;
  const server = createPublicServer({
    readMarket: async (...args) => {
      assert.equal(args.length, 0);
      reads++;
      return [];
    },
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const instance of [v1, v2]) {
      const response = await fetch(
        origin +
          "/api/market?instance=" +
          instance +
          "&database=" +
          target(instance).database,
      );
      assert.equal(response.status, 400);
    }
    assert.equal(reads, 0);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
test("initializer v2 dry-run resolves exact reviewed values without creating resources", async () =>
  temporary(async (directory) => {
    const plan = await planTarget("LIVE_EVIDENCE", v2, {
      LOCALAPPDATA: directory,
    });
    assert.equal(plan.environment, "LIVE_EVIDENCE");
    assert.equal(plan.instance, v2);
    assert.equal(plan.port, 55435);
    assert.equal(plan.database, "darkpool_phase9_evidence_payment_v2");
    assert.equal(
      plan.data_directory,
      join(
        directory,
        "ZcashDarkPoolDev/postgres-live-evidence/phase9_payment_v2/data",
      ),
    );
    assert.equal(plan.resource_creation, false);
    assert.deepEqual(await readdir(directory), []);
  }));
test("actual PowerShell v2 plan defaults to no execution and creates no resources", async () =>
  temporary(async (directory) => {
    const result = await runBounded(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("scripts/dev/postgres-isolated.ps1"),
        "-Kind",
        "LIVE_EVIDENCE",
        "-Instance",
        v2,
      ],
      { timeoutMs: 15000, env: { ...process.env, LOCALAPPDATA: directory } },
    );
    assert.equal(boundedExit(result), 0);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.port, 55435);
    assert.equal(plan.resource_creation, false);
    assert.deepEqual(await readdir(directory), []);
  }));
test("initializer rejects a preserved v1 identity before creating anything", async () =>
  temporary(async (directory) => {
    const result = await runBounded(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("scripts/dev/postgres-isolated.ps1"),
        "-Kind",
        "LIVE_EVIDENCE",
        "-Instance",
        v1,
        "-Create",
        "-Worker",
      ],
      { timeoutMs: 15000, env: { ...process.env, LOCALAPPDATA: directory } },
    );
    assert.notEqual(boundedExit(result), 0);
    assert.match(result.stderr, /Preserved LIVE identity/);
    assert.deepEqual(await readdir(directory), []);
  }));
test("component launcher plans v2 without loading or creating credentials", async () =>
  temporary(async (directory) => {
    for (const action of ["admin", "issuer", "watcher", "public", "migrate"]) {
      const result = await runBounded(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("scripts/dev/run-target.ps1"),
          "-Instance",
          v2,
          "-Action",
          action,
        ],
        { timeoutMs: 15000, env: { ...process.env, LOCALAPPDATA: directory } },
      );
      assert.equal(boundedExit(result), 0);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.instance, v2);
      assert.equal(plan.port, 55435);
      assert.ok(plan.role.startsWith("darkpool_live_v2_"));
      assert.equal(plan.resource_creation, false);
    }
    assert.deepEqual(await readdir(directory), []);
  }));
test("initializer TEST preflight rejects existing roots and occupied TEST port before writes", async () =>
  temporary(async (directory) => {
    const run = () =>
      runBounded(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("scripts/dev/postgres-isolated.ps1"),
          "-Kind",
          "TEST",
          "-Worker",
        ],
        {
          timeoutMs: 15000,
          env: {
            ...process.env,
            LOCALAPPDATA: directory,
            DARKPOOL_LIVE_INSTANCE: undefined,
          },
        },
      );
    const occupied = await run();
    assert.notEqual(boundedExit(occupied), 0);
    assert.match(occupied.stderr, /Isolated port occupied/);
    assert.deepEqual(await readdir(directory), []);
    const root = initializerPlan("TEST", directory).root;
    await mkdir(root, { recursive: true });
    const existing = await run();
    assert.notEqual(boundedExit(existing), 0);
    assert.match(existing.stderr, /Isolated root already exists/);
  }));

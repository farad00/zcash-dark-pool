import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { psql } from "../../../db/test-fixtures.mjs";
import { loadEnvironmentGuard } from "../../../db/environment.mjs";
import { rehearsalPlan, purposes, literal } from "../../../db/v2-target.mjs";
import { provisionProduct, scramVerifier } from "../../../db/v2-provision.mjs";
import {
  migrateProduct,
  schemaFingerprint,
} from "../../../db/v2-migrations.mjs";
import { provisionLockScript } from "../../../db/lock-provision.mjs";
import { registerOracleScript } from "../../../db/resolution-provision.mjs";
import { fixture, resources } from "../../../db/test/lock-fixtures.mjs";
import { finalizeLock } from "../../lock/finalize.mts";
import {
  fixtureCommand,
  dumpFixture,
  renderFixtureRestore,
} from "../test-database.mjs";
import {
  assertSynthetic,
  syntheticKeyPair,
  sealCapsule,
  openCapsule,
  privateProcess,
  digest,
} from "../crypto.mjs";

assertSynthetic();
const maintenance = { ...process.env };
assert.equal(maintenance.PGPORT, "55433");
assert.equal(maintenance.PGDATABASE, "postgres");
const suffix = randomBytes(8).toString("hex"),
  database = "darkpool_phase9_" + suffix;
const plan = rehearsalPlan(maintenance, database);
const roles = {
  ...Object.fromEntries(purposes.map((p) => [p, plan.roles[p]])),
  ...Object.fromEntries(
    ["oracle", "coordinator", "lock"].map((p) => [
      p,
      `darkpool_backup${p}_${suffix}`,
    ]),
  ),
};
const script = fileURLToPath(
  new URL("../../../scripts/dev/backup-fixture-storage.ps1", import.meta.url),
);
const roots = Array.from({ length: 3 }, () =>
  join(tmpdir(), "darkpool-backup-fixture-" + randomBytes(16).toString("hex")),
);
const createdRoots = [];
const storage = (action, directory, input = Buffer.alloc(0)) =>
  privateProcess(
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
      "-Directory",
      directory,
    ],
    input,
    4096,
    {
      ...Object.fromEntries(
        ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      ),
      DARKPOOL_BACKUP_TEST_ONLY: "1",
    },
  );
const admin = (sql) =>
  fixtureCommand(sql, { ...maintenance, PGDATABASE: database });
const catalog = () =>
  admin(`SET search_path=pg_catalog; SELECT ${schemaFingerprint};`);
const catalogItems = async () =>
  JSON.parse(
    await admin(
      `SET search_path=pg_catalog; SELECT jsonb_agg(item::jsonb ORDER BY item) ${schemaFingerprint.slice(schemaFingerprint.indexOf(" FROM (") + 1, -1)};`,
    ),
  );
const privateState = () =>
  admin(`SELECT jsonb_build_object(
 'seal',(SELECT to_jsonb(s) FROM darkpool_v2_setup.schema_seal s),
 'authority',(SELECT to_jsonb(a) FROM darkpool_private.oracle_authorities a),
 'ledger',(SELECT jsonb_agg(to_jsonb(r) ORDER BY ticket_id) FROM darkpool_private.ledger_records r),
 'commitment',(SELECT to_jsonb(c) FROM darkpool_private.ledger_commitments c),
 'lock',(SELECT to_jsonb(l) FROM darkpool_private.lock_requests l),
 'watcher',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM darkpool_private.watcher_evidence w),
 'probe',(SELECT to_jsonb(p) FROM backup_fixture.private_probe p));`);
let ownsFixture = false,
  backup,
  receipt,
  portable,
  bindings,
  sourceStateHash,
  sourceCatalog;
let restored = false,
  passwords,
  probe,
  originalItems,
  lockRequest,
  lockResponse;
const envFor = (purpose, recovered = portable?.credentials) => ({
  ...maintenance,
  PGDATABASE: database,
  PGUSER: roles[purpose],
  PGPASSWORD: recovered
    ? recovered.find((c) => c.purpose === purpose).password
    : passwords[purpose],
});

before(async () => {
  assert.equal(
    await psql(
      `SELECT (SELECT count(*) FROM pg_database WHERE datname=${literal(database)})+(SELECT count(*) FROM pg_roles WHERE rolname IN (${Object.values(roles).map(literal).join(",")}));`,
      { database: "postgres" },
    ),
    "0",
  );
  ownsFixture = true;
  passwords = Object.fromEntries(
    Object.keys(roles).map((p) => [p, randomBytes(32).toString("hex")]),
  );
  await provisionProduct(
    plan,
    Object.fromEntries(purposes.map((p) => [p, passwords[p]])),
    maintenance,
  );
  assert.equal((await migrateProduct(plan, envFor("owner"))).migrations, 13);
  await psql(
    Object.keys(roles)
      .filter((p) => !purposes.includes(p))
      .map(
        (p) =>
          `CREATE ROLE "${roles[p]}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(scramVerifier(passwords[p]))};`,
      )
      .join("\n"),
    { database: "postgres" },
  );
  await psql(
    `GRANT CONNECT ON DATABASE "${database}" TO "${roles.lock}","${roles.oracle}","${roles.coordinator}";`,
    { database: "postgres" },
  );
  await admin(provisionLockScript(roles.lock));
  const f = fixture(Math.floor(Date.now() / 1000) + 3, 3);
  const observation = new Date(f.close * 1000)
    .toISOString()
    .replace(/(\.\d{3})Z$/, "$1000Z");
  const rule = {
    question: "Synthetic Phase 11 question",
    yes_definition: "Yes",
    no_definition: "No",
    resolution_rule: `Observe synthetic-source at ${observation}`,
    resolution_sources: ["synthetic-source"],
    void_conditions: ["void"],
    rule_version: "backup-test-v1",
  };
  const registration = registerOracleScript({
    market_id: f.mid,
    oracle_login: roles.oracle,
    coordinator_login: roles.coordinator,
    actor_ref: "synthetic-backup-fixture",
    execution_class: "SYNTHETIC_TEST",
    rule,
    observation_at: observation,
    resources: {
      ...resources,
      max_tickets: "4096",
      max_total_zat: ((1n << 128n) - 1n).toString(),
      max_numerator_zat_squared: ((1n << 256n) - 1n).toString(),
    },
  });
  await admin(
    f.setup
      .replace(
        "'Rule',ARRAY['synthetic-source']",
        `${literal(rule.resolution_rule)},ARRAY['synthetic-source']`,
      )
      .replace(
        "UPDATE markets SET status='OPEN';",
        registration + "\nUPDATE markets SET status='OPEN';",
      ),
  );
  await new Promise((r) =>
    setTimeout(r, Math.max(0, f.close * 1000 - Date.now() + 20)),
  );
  lockRequest = f.lockRequest;
  lockResponse = await finalizeLock(lockRequest, resources, {
    ...envFor("lock"),
    DARKPOOL_LOCK_INTERNAL: "1",
  });
  probe = randomBytes(32).toString("hex");
  await admin(
    `CREATE SCHEMA backup_fixture; REVOKE ALL ON SCHEMA backup_fixture FROM PUBLIC; CREATE TABLE backup_fixture.private_probe(payload text NOT NULL); REVOKE ALL ON backup_fixture.private_probe FROM PUBLIC; INSERT INTO backup_fixture.private_probe VALUES(${literal(probe)});`,
  );
  assert.equal(
    await admin(
      "SELECT darkpool_resolution.test_scope(a) FROM darkpool_private.oracle_authorities a;",
    ),
    "t",
  );
  const { profile } = await loadEnvironmentGuard(maintenance, {
    database: "postgres",
    requireKind: "TEST",
  });
  sourceStateHash = digest(Buffer.from(await privateState()));
  sourceCatalog = await catalog();
  originalItems = await catalogItems();
  bindings = {
    profile,
    database_oid: await admin(
      "SELECT oid FROM pg_database WHERE datname=current_database();",
    ),
    catalog_sha256: sourceCatalog,
    private_state_sha256: sourceStateHash,
  };
  // Dump as maintenance: the fixture includes private records inaccessible to the owner.
  // Only this generated database is exported; TEST maintenance credentials are excluded.
  const dump = await dumpFixture({ ...maintenance, PGDATABASE: database });
  const capsule = {
    version: 1,
    scope: "SYNTHETIC_TEST",
    kind: "LOGICAL_QUARANTINE",
    database,
    identity_bindings: bindings,
    credentials: Object.keys(roles).map((p) => ({
      purpose: p,
      login: roles[p],
      password: passwords[p],
    })),
    dump: dump.toString("base64"),
    dump_sha256: digest(dump),
  };
  const key = await syntheticKeyPair();
  backup = await sealCapsule(capsule, key.recipient);
  receipt = backup.receipt;
  for (const root of roots) {
    await storage("create", root);
    createdRoots.push(root);
  }
  await writeFile(join(roots[0], "snapshot.age"), backup.ciphertext, {
    flag: "wx",
  });
  // Synthetic key ONLY, separate restricted root. This is not real offline custody.
  await writeFile(join(roots[1], "recovery.identity"), key.identity, {
    flag: "wx",
  });
  portable = await openCapsule(
    await readFile(join(roots[0], "snapshot.age")),
    (await readFile(join(roots[1], "recovery.identity"))).toString(),
    receipt,
  );
});

after(async () => {
  try {
    if (ownsFixture) {
      await psql(`DROP DATABASE IF EXISTS "${database}";`, {
        database: "postgres",
      });
      await psql(
        Object.values(roles)
          .map((r) => `DROP ROLE IF EXISTS "${r}";`)
          .join("\n"),
        { database: "postgres" },
      );
    }
  } finally {
    for (const root of createdRoots) {
      // Verify absolute deletion target remains an owned direct temporary child.
      assert.equal(
        dirname(resolve(root)).toLowerCase(),
        resolve(tmpdir()).toLowerCase(),
      );
      assert.match(basename(root), /^darkpool-backup-fixture-[a-f0-9]{32}$/);
      await storage("check", root);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("encrypted archive excludes plaintext credentials and private probe; key has separate restricted custody", async () => {
  const bytes = await readFile(join(roots[0], "snapshot.age"));
  assert.equal(bytes.includes(Buffer.from(probe)), false);
  for (const p of Object.values(passwords))
    assert.equal(bytes.includes(Buffer.from(p)), false);
  assert.deepEqual(await readdir(roots[0]), ["snapshot.age"]);
  for (const root of roots)
    assert.equal(
      (await storage("check", root)).toString().trim(),
      "SYNTHETIC_STORAGE_OK",
    );
  assert.equal(digest(bytes), receipt.ciphertext_sha256);
});
test("restoration requires independently retained digest and key; failures do not alter source", async () => {
  await assert.rejects(
    openCapsule(backup.ciphertext, "", receipt),
    /BACKUP_REJECTED/,
  );
  await assert.rejects(
    openCapsule(
      backup.ciphertext,
      (await syntheticKeyPair()).identity,
      receipt,
    ),
    /BACKUP_REJECTED/,
  );
  const wrong = { ...receipt, ciphertext_sha256: "0".repeat(64) };
  await assert.rejects(
    openCapsule(backup.ciphertext, "", wrong),
    /BACKUP_REJECTED/,
  );
  assert.equal(digest(Buffer.from(await privateState())), sourceStateHash);
});
test("native logical restore recovers all 13 migrations and exact locked private state after fixture deletion", async () => {
  await psql(`DROP DATABASE "${database}";`, { database: "postgres" });
  await psql(
    Object.values(roles)
      .map((r) => `DROP ROLE "${r}";`)
      .join("\n"),
    { database: "postgres" },
  );
  passwords = undefined;
  probe = undefined;
  portable = undefined;
  backup = undefined;
  portable = await openCapsule(
    await readFile(join(roots[0], "snapshot.age")),
    (await readFile(join(roots[1], "recovery.identity"))).toString(),
    receipt,
  );
  // Recreate only the explicitly allowlisted generated roles, never cluster globals.
  await provisionProduct(
    plan,
    Object.fromEntries(
      purposes.map((p) => [
        p,
        portable.credentials.find((c) => c.purpose === p).password,
      ]),
    ),
    maintenance,
  );
  await psql(
    portable.credentials
      .filter((c) => !purposes.includes(c.purpose))
      .map(
        (c) =>
          `CREATE ROLE "${c.login}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(scramVerifier(c.password))};`,
      )
      .join("\n"),
    { database: "postgres" },
  );
  await psql(
    `GRANT CONNECT ON DATABASE "${database}" TO "${roles.lock}","${roles.oracle}","${roles.coordinator}";`,
    { database: "postgres" },
  );
  const sql = await renderFixtureRestore(Buffer.from(portable.dump, "base64"));
  await admin(sql.toString("utf8"));
  restored = true;
  assert.equal(
    await admin("SELECT count(*) FROM darkpool_migrations.applied;"),
    "13",
  );
  assert.equal(digest(Buffer.from(await privateState())), sourceStateHash);
  const current = await catalogItems();
  // pg_dump omits explicit ACLs identical to PostgreSQL's owner-only defaults.
  // Verify ONLY this representational difference; do not repair/reseal the clone.
  const originals = new Map(
    originalItems.map((i) => [JSON.stringify(i.slice(0, 3)), i]),
  );
  const normalized = current.map((item) => {
    const old = originals.get(JSON.stringify(item.slice(0, 3)));
    assert.ok(old);
    const slot = item[0] === "relation" ? 5 : item[0] === "schema" ? 3 : -1;
    if (slot >= 0 && item[slot] === null && old[slot] !== null) {
      const expected = `{${roles.owner}=${slot === 3 ? "UC" : "arwdDxtm"}/${roles.owner}}`;
      assert.equal(old[slot], expected);
      const copy = [...item];
      copy[slot] = old[slot];
      return copy;
    }
    return item;
  });
  assert.ok(
    JSON.stringify(normalized.map(JSON.stringify).sort()) ===
      JSON.stringify(originalItems.map(JSON.stringify).sort()),
  );
  assert.notEqual(await catalog(), sourceCatalog);
});
test("recovered retained blindings recompute the original commitment without new randomness", async () => {
  assert.equal(restored, true);
  const result = await finalizeLock(lockRequest, resources, {
    ...envFor("lock"),
    DARKPOOL_LOCK_INTERNAL: "1",
  });
  assert.deepEqual(result, lockResponse);
  assert.equal(digest(Buffer.from(await privateState())), sourceStateHash);
});
test("retained cluster/lock/blinding bindings remain unchanged; logical clone is correctly quarantined", async () => {
  assert.equal(restored, true);
  assert.deepEqual(portable.identity_bindings, bindings);
  assert.notEqual(
    await admin(
      "SELECT oid FROM pg_database WHERE datname=current_database();",
    ),
    bindings.database_oid,
  );
  assert.equal(
    await admin("SELECT system_identifier::text FROM pg_control_system();"),
    bindings.profile.system_identifier,
  );
  assert.equal(
    await admin(
      "SELECT darkpool_resolution.test_scope(a) FROM darkpool_private.oracle_authorities a;",
    ),
    "f",
  );
  assert.equal(
    await admin("SELECT status FROM darkpool_private.markets;"),
    "LOCKED",
  );
  assert.equal(
    await admin(
      "SELECT count(*) FROM darkpool_private.ledger_publication_receipts;",
    ),
    "0",
  );
  await assert.rejects(
    admin(
      "UPDATE darkpool_private.oracle_authorities SET database_oid=(SELECT oid FROM pg_database WHERE datname=current_database());",
    ),
    /BACKUP_REJECTED/,
  );
  assert.equal(digest(Buffer.from(await privateState())), sourceStateHash);
});
test("portable passwords authenticate and rewrap into fresh DPAPI files without original XML; runtime privacy persists", async () => {
  assert.equal(restored, true);
  assert.equal(
    await fixtureCommand("SELECT current_user;", envFor("owner")),
    roles.owner,
  );
  await assert.rejects(
    fixtureCommand(
      "SELECT * FROM darkpool_private.ledger_records;",
      envFor("read"),
    ),
    /BACKUP_REJECTED/,
  );
  await assert.rejects(
    fixtureCommand(
      "SELECT * FROM backup_fixture.private_probe;",
      envFor("read"),
    ),
    /BACKUP_REJECTED/,
  );
  assert.equal(
    (
      await storage(
        "rewrap",
        roots[2],
        Buffer.from(JSON.stringify(portable.credentials)),
      )
    )
      .toString()
      .trim(),
    "SYNTHETIC_STORAGE_OK",
  );
  assert.equal((await readdir(roots[2])).length, 8);
  assert.equal(
    (await storage("check", roots[2])).toString().trim(),
    "SYNTHETIC_STORAGE_OK",
  );
  for (const file of await readdir(roots[2])) {
    const xml = await readFile(join(roots[2], file));
    for (const c of portable.credentials)
      assert.equal(xml.includes(Buffer.from(c.password)), false);
  }
});

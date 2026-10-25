// Offline reader identity/credential fixtures. No PostgreSQL or network access.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { markerText } from "../environment-identity.mjs";
import { bindPublicReaderTarget } from "../public-reader-runtime.mjs";

async function fixture(run) {
  const base = await mkdtemp(join(tmpdir(), "darkpool-reader-"));
  try {
    const root = join(base, "ZcashDarkPoolDev", "postgres-test"),
      data = join(root, "data");
    await mkdir(join(data, "global"), { recursive: true });
    const info = await stat(data);
    const profile = {
      version: 1,
      maintenance_user: "darkpool_test_maintenance",
      kind: "TEST",
      cluster_id: randomUUID(),
      host: "127.0.0.1",
      port: 55433,
      data_directory: data,
      system_identifier: "7654321098765432101",
      directory_identity: { dev: String(info.dev), ino: String(info.ino) },
    };
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(profile.system_identifier));
    const save = async () => {
      await writeFile(join(root, "profile.json"), JSON.stringify(profile));
      await writeFile(join(root, "cluster-marker.json"), markerText(profile));
      await writeFile(join(data, "global", "pg_control"), bytes);
    };
    await save();
    const env = {
      LOCALAPPDATA: base,
      DARKPOOL_PG_ENV: "TEST",
      DARKPOOL_PG_PROFILE: join(root, "profile.json"),
      PGHOST: "127.0.0.1",
      PGPORT: "55433",
      PGDATABASE: "reader_fixture",
      PGUSER: "reader_fixture",
      PGPASSWORD: "synthetic-reader-only",
      ZCASH_NETWORK: "testnet",
      PSQL_PATH: "fixed-client",
    };
    await run({ env, profile, root, bytes, save });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("reader target captures endpoint/database/role/credential/client once; no retained mutable configuration", async () => {
  await fixture(async ({ env }) => {
    const target = await bindPublicReaderTarget(env);
    for (const key of Object.keys(env)) env[key] = "changed";
    assert.equal(target.connection.PGHOST, "127.0.0.1");
    assert.equal(target.connection.PGPORT, "55433");
    assert.equal(target.connection.PGDATABASE, "reader_fixture");
    assert.equal(target.connection.PGUSER, "reader_fixture");
    assert.equal(target.connection.PGPASSWORD, "synthetic-reader-only");
    assert.equal(target.executable, "fixed-client");
    assert.ok(Object.isFrozen(target) && Object.isFrozen(target.connection));
    assert.match(target.prefix, /current_database\(\)='reader_fixture'/);
    assert.match(
      target.prefix,
      /current_user='reader_fixture' AND session_user='reader_fixture'/,
    );
    await target.verify();
  });
});

test("wrong local marker and control system ID fail closed before DB access", async () => {
  await fixture(async ({ env, root, bytes, save }) => {
    const target = await bindPublicReaderTarget(env);
    await writeFile(join(root, "cluster-marker.json"), "{}");
    await assert.rejects(bindPublicReaderTarget(env));
    await assert.rejects(target.verify());
    await save();
    bytes.writeBigUInt64LE(7654321098765432102n);
    await save();
    await assert.rejects(bindPublicReaderTarget(env));
    await assert.rejects(target.verify());
  });
});

test("a self-consistent replacement identity cannot retarget an already-bound reader", async () => {
  await fixture(async ({ env, profile, save }) => {
    const target = await bindPublicReaderTarget(env);
    profile.cluster_id = randomUUID();
    await save();
    await assert.rejects(target.verify());
  });
});

test("wrong kind/path/port/host and maintenance databases rejected by reader binding", async () => {
  await fixture(async ({ env }) => {
    for (const change of [
      { DARKPOOL_PG_ENV: "HISTORICAL" },
      { DARKPOOL_PG_ENV: "LIVE_EVIDENCE" },
      { PGHOST: "localhost" },
      { PGPORT: "55432" },
      { DARKPOOL_PG_PROFILE: join(tmpdir(), "elsewhere.json") },
      { PGDATABASE: "postgres" },
      { PGDATABASE: "template1" },
      { PGHOSTADDR: "127.0.0.1" },
    ])
      await assert.rejects(bindPublicReaderTarget({ ...env, ...change }));
  });
});

test("reader password file is bound once to one credential; later file changes cannot change it", async () => {
  await fixture(async ({ env, root }) => {
    delete env.PGPASSWORD;
    env.PGPASSFILE = join(root, "reader.pgpass");
    await writeFile(
      env.PGPASSFILE,
      "127.0.0.1:55433:reader_fixture:reader_fixture:synthetic\\:reader\\\\only\n",
    );
    const target = await bindPublicReaderTarget(env);
    assert.equal(target.connection.PGPASSWORD, "synthetic:reader\\only");
    assert.equal(target.connection.PGPASSFILE, undefined);
    await writeFile(
      env.PGPASSFILE,
      "127.0.0.1:55433:reader_fixture:reader_fixture:replacement\n",
    );
    assert.equal(target.connection.PGPASSWORD, "synthetic:reader\\only");
    for (const contents of [
      "127.0.0.1:55433:other:reader_fixture:wrong\n",
      "a:b:c:d:e\nf:g:h:i:j\n",
      "malformed\n",
    ]) {
      await writeFile(env.PGPASSFILE, contents);
      await assert.rejects(bindPublicReaderTarget(env));
    }
  });
});

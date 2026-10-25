import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { migrate, psql } from "../test-fixtures.mjs";
import { provisionWatcherScript } from "../watcher-provision.mjs";
import { provisionPublicScript } from "../public-provision.mjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  createCoordinator,
  framedWalletProcess,
} from "../../services/watcher/main.mjs";
import { createWatcherDb, watcherQuery } from "../../services/watcher/db.mjs";

// Real PostgreSQL; all chain/output messages here are synthetic policy fixtures.
// Actual maintained wallet scanning is tested separately in watcher.rs.
const suffix = randomBytes(8).toString("hex");
const database = `darkpool_phase9_${suffix}`,
  role = `darkpool_watch_${suffix}`,
  reader = `darkpool_p9_read_${suffix}`;
const password = randomBytes(32).toString("hex"),
  maintenance = process.env.PGDATABASE;
const C = Math.floor(Date.now() / 1000) + 3600;
const id = (n) => n.toString(16).padStart(64, "0");
const hash = id;
const account = "11111111-1111-4111-8111-111111111111";
const endpoint = "https://synthetic.invalid:9067";
const literal = (v) => `'${v.replaceAll("'", "''")}'`;
const json = (v) => `${literal(JSON.stringify(v))}::jsonb`;
const sql = (q) => psql(q, { database });
const env = () => ({
  ...process.env,
  APP_ENV: "development",
  DARKPOOL_WATCHER_INTERNAL: "1",
  ZCASH_NETWORK: "testnet",
  PGDATABASE: database,
  PGUSER: role,
  PGPASSWORD: password,
});
let created = false,
  roles = false;

function fixture(
  close = C,
  anchor = 100,
  anchorHash = hash(anchor),
  includeTickets = true,
) {
  return `SET LOCAL search_path=darkpool_private,pg_catalog;
  INSERT INTO policy_refs VALUES('p9-test','PINNED',NULL,'synthetic-fixture-only');
  INSERT INTO markets VALUES('m9',1,'testnet','v9','Synthetic question','Yes','No',to_timestamp(${close}-7200),to_timestamp(${close}),
   'phase9-exact-chainclock-3-v1','Rule',ARRAY['source'],ARRAY['void'],1,100000000,'phase9-exact-chainclock-3-v1','p9-test','NO_WINNER_REFUND',3,NULL,'DRAFT',now(),now());
  INSERT INTO watcher_state VALUES('m9','phase9-exact-chainclock-3-v1','${account}','${endpoint}',${anchor},decode('${anchorHash}','hex'),to_timestamp(${close}),0,NULL,NULL,now());
  UPDATE markets SET status='OPEN';
  ${(includeTickets ? [1, 2, 3, 4] : [])
    .map(
      (
        n,
      ) => `INSERT INTO tickets VALUES('${id(n)}',1,'m9','v9','${n % 2 ? "YES" : "NO"}',1000,0,'receiver${n}','external:${n.toString(16).padStart(22, "0")}',decode(repeat('ab',32),'hex'),
    'DARKPOOL_CLAIM_V1_ID_FRAME_1','market-close:m9','AWAITING_PAYMENT','phase7-issued-unpaid-v1',NULL,now(),NULL);
    INSERT INTO issuance_attempts VALUES(decode('${id(n)}','hex'),'${id(n)}','m9','v9','${n % 2 ? "YES" : "NO"}',1000,decode(repeat('ab',32),'hex'),'ISSUED');`,
    )
    .join("\n")}
  SET CONSTRAINTS ALL IMMEDIATE;
  CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $t$ BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'policy assertion failed'; END IF; END $t$;
  CREATE FUNCTION pg_temp.expect_failure(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $t$ BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected THEN RETURN; END IF; RAISE; END;
    RAISE EXCEPTION USING ERRCODE='P4910',MESSAGE='negative case unexpectedly succeeded'; END $t$;
  SET CONSTRAINTS ALL DEFERRED;`;
}
function output(n = 1, extra = {}) {
  return {
    txid: hash(1000 + n),
    pool: "IRONWOOD",
    output_index: 0,
    amount_zat: "1000",
    ticket_id: id(n),
    receiver_ref: `receiver${n}`,
    diversifier_ref: `external:${n.toString(16).padStart(22, "0")}`,
    journal_commitment: "ab".repeat(32),
    key_scope: 0,
    is_change: false,
    receiver_verified: true,
    present: true,
    canonical: true,
    block_height: 101,
    block_hash: hash(101),
    block_time: C - 19,
    tx_index: n,
    ...extra,
  };
}
function request(outputs, extra = {}) {
  const tip = extra.tip ?? 103,
    close = extra.close ?? C,
    base = extra.base ?? close - 20;
  const blocks = Array.from({ length: tip - 89 }, (_, i) => ({
    height: i + 90,
    hash: hash(i + 90),
    time: base + (i + 90 - 100),
  }));
  return {
    version: 1,
    request_id: randomBytes(32).toString("hex"),
    network: "testnet",
    market_id: "m9",
    vault_context_ref: "v9",
    account_ref: account,
    endpoint_ref: endpoint,
    mode: "snapshot",
    outputs,
    chain: {
      complete: true,
      verified: true,
      tip_height: tip,
      tip_hash: hash(tip),
      scanned_height: tip,
      scanned_hash: hash(tip),
      anchor_hash: hash(100),
      verified_at: new Date().toISOString(),
      mtp_blocks: blocks,
    },
  };
}
const reconcile = (r, revision = 0) =>
  `SET LOCAL ROLE "${role}"; SELECT darkpool_watcher.reconcile(${revision},${json(r)}); RESET ROLE; SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;`;
const check = (q) => `SELECT pg_temp.assert_true((${q}));`;
const fail = (statement, state = "23514") =>
  `SELECT pg_temp.expect_failure(${literal(statement)},'${state}');`;
const accepted = (n = 1) =>
  `SELECT accepted_amount_zat=1000 AND payment_state='CONFIRMED' FROM tickets WHERE id='${id(n)}'`;
const noStake = `SELECT sum(accepted_amount_zat)=0 FROM tickets`;
const isolated = (body, close = C) =>
  sql(
    `BEGIN; ${fixture(close)} ${body} SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`,
  );

// Test-only representation conversion. SQL's unchanged V1 branch is the independent
// economic reference; V2 fixtures retain exactly the same chain and received notes.
function boundedRequest(original, close = C) {
  const r = structuredClone(original),
    all = r.chain.mtp_blocks;
  const a = 100,
    H = Number(r.chain.tip_height);
  const headers = all.map((b) => ({
    ...b,
    prev_hash: hash(Number(b.height) - 1),
  }));
  const med = (x) => x.map((b) => b.time).sort((a, b) => a - b)[5];
  let B = null;
  for (let h = a + 1; h <= H; h++)
    if (
      med(headers.filter((b) => b.height >= h - 11 && b.height < h)) >= close
    ) {
      B = h;
      break;
    }
  const heights = [
    ...new Set(
      r.outputs
        .filter((o) => o.present && o.canonical)
        .map((o) => o.block_height),
    ),
  ].sort((a, b) => a - b);
  delete r.chain.mtp_blocks;
  r.chain.close_proof = {
    version: 2,
    profile: "phase9-exact-chainclock-3-v1",
    status: B === null ? "NO_CROSSING_BY_H" : "FOUND",
    boundary_height: B,
    anchor_window: headers.filter((b) => b.height >= a - 10 && b.height <= a),
    window:
      H === a
        ? []
        : headers.filter(
            (b) =>
              b.height >= (B === null ? H - 11 : B - 12) &&
              b.height <= (B ?? H),
          ),
    target: headers.at(-1),
  };
  r.chain.inclusion_blocks = heights.map((h) =>
    headers.find((b) => b.height === h),
  );
  return r;
}

const economicSummary = `SELECT jsonb_build_object(
 'tickets',(SELECT jsonb_agg(jsonb_build_array(id,payment_state,accepted_amount_zat) ORDER BY id) FROM tickets),
 'selected',(SELECT jsonb_agg(receipt_id ORDER BY receipt_id) FROM accepted_payment_receipts),
 'inclusions',(SELECT jsonb_agg(jsonb_build_array(details->>'classification',details->>'height',details->>'time',details->>'tx_index') ORDER BY receipt_id) FROM watcher_evidence WHERE kind='INCLUSION'),
 'boundary',(SELECT jsonb_agg(jsonb_build_array(details->>'height',details->>'close_height') ORDER BY id) FROM watcher_evidence WHERE kind='BOUNDARY'),
 'held',(SELECT hold_ref IS NOT NULL FROM watcher_state));`;

test("Bounded close: V1/V2 economic equivalence before/equal/after, confirmations and deterministic selection", async () => {
  const originalMigration = await readFile(
    resolve("db/migrations/0005_phase9_watcher.sql"),
    "utf8",
  );
  const reference = originalMigration
    .slice(
      originalMigration.indexOf("CREATE FUNCTION darkpool_watcher.reconcile("),
      originalMigration.indexOf("REVOKE ALL ON ALL TABLES"),
    )
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  const cases = [
    request([output()]),
    request([output(1, { pool: "ORCHARD" })]),
    request([output(1, { pool: "ORCHARD", block_time: C })], { base: C - 1 }),
    request([output(1, { pool: "ORCHARD", block_time: C + 1 })], { base: C }),
    request([output()], { tip: 101 }),
    request([output()], { tip: 102 }),
    request([output(1, { block_time: C - 1 })], { base: C - 2 }),
    request([output(1, { block_time: C })], { base: C - 1 }),
    request([output(1, { block_time: C + 1 })], { base: C }),
    request(
      [
        output(1, {
          block_height: 3720,
          block_hash: hash(3720),
          block_time: C + 3600,
        }),
      ],
      { tip: 3722 },
    ),
    request(
      [
        output(1, {
          block_height: 105,
          block_hash: hash(105),
          block_time: C - 1,
        }),
        output(2, { block_height: 106, block_hash: hash(106), block_time: C }),
        output(3, {
          block_height: 107,
          block_hash: hash(107),
          block_time: C + 1,
        }),
      ],
      { tip: 115, base: C - 6 },
    ),
    request([], { tip: 115, base: C - 6 }),
    request([
      output(),
      output(1, { txid: hash(2000), tx_index: 9, output_index: 1 }),
    ]),
  ];
  for (const old of cases) {
    const legacy = await isolated(reference + reconcile(old) + economicSummary);
    const compact = await isolated(
      reconcile(boundedRequest(old)) + economicSummary,
    );
    assert.deepEqual(
      JSON.parse(compact.split("\n").at(-1)),
      JSON.parse(legacy.split("\n").at(-1)),
    );
  }
  const first = request([output()]);
  const second = request([
    output(1, {
      present: false,
      canonical: false,
      block_height: null,
      block_hash: null,
      block_time: null,
      tx_index: null,
    }),
  ]);
  const oldHold = await isolated(
    reference + reconcile(first) + reconcile(second, 1) + economicSummary,
  );
  const newHold = await isolated(
    reconcile(boundedRequest(first)) +
      reconcile(boundedRequest(second), 1) +
      economicSummary,
  );
  assert.deepEqual(
    JSON.parse(newHold.split("\n").at(-1)),
    JSON.parse(oldHold.split("\n").at(-1)),
  );
});

test("Bounded close: first feasible/middle/H/no-crossing, equality and fractional close", async () => {
  for (const [base, tip, B] of [
    [C + 4, 110, 102],
    [C - 6, 115, 112],
    [C - 6, 112, 112],
    [C - 6, 111, null],
    [C - 6, 100, null],
    [C - 6, 101, null],
  ]) {
    const r = boundedRequest(request([], { base, tip }));
    await isolated(
      reconcile(r) +
        check(
          B === null
            ? "SELECT count(*)=0 FROM watcher_evidence WHERE kind='BOUNDARY'"
            : `SELECT (details->>'height')::bigint=${B} AND jsonb_array_length(details->'window')=13 FROM watcher_evidence WHERE kind='BOUNDARY'`,
        ),
    );
  }
  const fractional = C + 0.5;
  const old = request([output(1, { block_time: C })], { base: C - 1 });
  await isolated(
    reconcile(boundedRequest(old, fractional)) + check(accepted()),
    fractional,
  );
});

test("Bounded close: closed proof rejects bad versions, missing/gapped/reordered/conflicting/forged evidence", async () => {
  const valid = boundedRequest(
    request([output(1, { block_time: C - 5 })], { tip: 115, base: C - 6 }),
  );
  for (const edit of [
    (r) => (r.chain.close_proof.version = 3),
    (r) => (r.chain.close_proof.profile = "other"),
    (r) => (r.chain.close_proof.extra = true),
    (r) => r.chain.close_proof.window.pop(),
    (r) => r.chain.close_proof.window[1].height++,
    (r) => r.chain.close_proof.window.reverse(),
    (r) => (r.chain.close_proof.window[1].hash = "00"),
    (r) => (r.chain.close_proof.window[1].time = null),
    (r) => (r.chain.close_proof.window[1].time = "123"),
    (r) => (r.chain.close_proof.window[1].time = 1.5),
    (r) => delete r.chain.close_proof.window[1].prev_hash,
    (r) => (r.chain.close_proof.window[1].prev_hash = hash(0)),
    (r) => r.chain.close_proof.boundary_height++,
    (r) => r.chain.close_proof.target.height++,
    (r) => (r.chain.close_proof.target.hash = hash(0)),
    (r) => (r.chain.close_proof.anchor_window[10].hash = hash(0)),
    (r) => r.chain.inclusion_blocks[0].time++,
    (r) => r.chain.inclusion_blocks.push(r.chain.inclusion_blocks[0]),
    (r) => delete r.chain.inclusion_blocks,
    (r) => (r.chain.inclusion_blocks = []),
    (r) => (r.chain.mtp_blocks = []),
    (r) => (r.chain.close_proof.status = "OTHER"),
  ]) {
    const r = structuredClone(valid);
    edit(r);
    await assert.rejects(isolated(reconcile(r)));
  }
  const no = boundedRequest(request([]));
  no.chain.close_proof.boundary_height = 104;
  await assert.rejects(isolated(reconcile(no)));
});

test("Bounded close: legal raw timestamp backstep is not a median-time violation", async () => {
  const old = request([], { tip: 115, base: C - 6 });
  old.chain.mtp_blocks.find((b) => b.height === 101).time = C - 8; // below t[100], above preceding median C-11.
  const r = boundedRequest(old);
  await isolated(reconcile(r));
});

test("Bounded close: pre-acceptance boundary recomputes; accepted boundary contradiction holds without rewrite", async () => {
  const legacyEncoded = request([output(1, { block_time: C - 5 })], {
    tip: 115,
    base: C - 6,
  });
  legacyEncoded.chain.mtp_blocks.find((b) => b.height === 112).height = "0112";
  const canonicalEncoded = boundedRequest(
    request([output(1, { block_time: C - 5 })], { tip: 115, base: C - 6 }),
  );
  await isolated(
    reconcile(legacyEncoded) +
      reconcile(canonicalEncoded, 1) +
      check(accepted()) +
      check("SELECT hold_ref IS NULL FROM watcher_state"),
  );
  const first = boundedRequest(request([], { tip: 115, base: C - 6 }));
  const changed = structuredClone(first);
  changed.request_id = randomBytes(32).toString("hex");
  changed.chain.close_proof.window.at(-1).time++;
  await isolated(
    reconcile(first) +
      reconcile(changed, 1) +
      check("SELECT hold_ref IS NULL FROM watcher_state"),
  );
  const paid = boundedRequest(
    request([output(1, { block_time: C - 5 })], { tip: 115, base: C - 6 }),
  );
  const conflict = structuredClone(paid);
  conflict.request_id = randomBytes(32).toString("hex");
  conflict.chain.close_proof.window.at(-1).time++;
  await isolated(
    reconcile(paid) +
      reconcile(paid, 0) +
      reconcile(conflict, 1) +
      check(accepted()) +
      check("SELECT hold_ref IS NOT NULL FROM watcher_state") +
      check("SELECT count(*)=1 FROM accepted_payments") +
      fail(
        "UPDATE watcher_state SET hold_ref=NULL,revision=revision+1",
        "23514",
      ),
  );
});

test("Bounded close: output contradiction holds, UNMAPPED/Sapling remain non-economic, private checker denied", async () => {
  const paid = boundedRequest(request([output()], { tip: 115 }));
  const conflict = structuredClone(paid);
  conflict.request_id = randomBytes(32).toString("hex");
  conflict.outputs[0].block_hash = hash(0);
  await isolated(
    reconcile(paid) +
      reconcile(conflict, 1) +
      check(accepted()) +
      check("SELECT hold_ref IS NOT NULL FROM watcher_state"),
  );
  for (const extra of [
    { receiver_ref: "unmapped" },
    { pool: "SAPLING" },
    { key_scope: 1 },
  ])
    await isolated(
      reconcile(boundedRequest(request([output(1, extra)]))) +
        check(noStake) +
        check(
          "SELECT count(*)=1 FROM watcher_evidence WHERE kind='OBSERVATION' AND details->>'classification'='UNMAPPED'",
        ),
    );
  await assert.rejects(
    watcherQuery(
      "SELECT darkpool_watcher.validate_close_v2('{}',100,repeat('00',32),now())",
      env(),
    ),
    { message: "WATCHER_UNAVAILABLE" },
  );
});

test("Bounded close: real 30,000-block Rust no-payment frame crosses Node and restricted SQL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "darkpool-bounded-close-"));
  const framePath = join(dir, "snapshot.frame");
  const largeDb = `darkpool_phase9_${randomBytes(8).toString("hex")}`;
  let made = false,
    wallet;
  try {
    const candidates = (await readdir(resolve("target/debug/deps"))).filter(
      (n) => /^darkpool_zcash-.*\.exe$/.test(n),
    );
    let executable;
    const rustEnv = Object.fromEntries(
      [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "LOCALAPPDATA",
      ]
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    );
    for (const n of candidates) {
      const path = resolve("target/debug/deps", n);
      if (
        execFileSync(path, ["--list"], {
          encoding: "utf8",
          windowsHide: true,
          env: rustEnv,
        }).includes("bounded_close_large_no_payment_and_export_frame_fixture")
      ) {
        executable = path;
        break;
      }
    }
    assert.ok(executable, "compiled real-wallet fixture required");
    execFileSync(
      executable,
      [
        "watcher::sync_tests::bounded_close_large_no_payment_and_export_frame_fixture",
        "--exact",
        "--nocapture",
      ],
      {
        env: { ...rustEnv, DARKPOOL_BOUNDED_CLOSE_EXPORT: framePath },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      },
    ); // harness bound only
    const frame = await readFile(framePath),
      meta = JSON.parse(await readFile(framePath + ".context", "utf8"));
    assert.equal(frame.readUInt32BE(), frame.length - 4);
    assert.ok(frame.length < 16384);
    const snapshot = JSON.parse(frame.subarray(4));
    assert.ok(snapshot.chain.tip_height - meta.anchor + 11 > 28813);
    assert.equal(snapshot.outputs.length, 0);
    await psql(
      `CREATE DATABASE "${largeDb}" TEMPLATE template0 ENCODING 'UTF8';`,
      { database: maintenance },
    );
    made = true;
    await migrate({ database: largeDb });
    await psql(provisionWatcherScript(role), { database: largeDb });
    const boundFixture = fixture(
      meta.close,
      meta.anchor,
      snapshot.chain.anchor_hash,
      false,
    )
      .replaceAll(literal("m9"), literal(meta.market_id))
      .replaceAll(literal("v9"), literal(meta.vault_context_ref))
      .replaceAll(literal(account), literal(meta.account_ref));
    await psql(`BEGIN; ${boundFixture} COMMIT;`, { database: largeDb });
    // Replay the bytes produced by Rust's production write_frame through the real
    // Node transport/coordinator. The child is a socket-free fixture, not a watcher.
    const script = `const fs=require('node:fs');const frame=fs.readFileSync(process.argv[1]);let b=Buffer.alloc(0);process.stdin.on('data',x=>{b=Buffer.concat([b,x]);while(b.length>=4&&b.length>=b.readUInt32BE()+4){const n=b.readUInt32BE();const r=JSON.parse(b.subarray(4,n+4));b=b.subarray(n+4);if(r.operation==='sync')process.stdout.write(frame);else{const v=Buffer.from(JSON.stringify({outputs:[]})),h=Buffer.alloc(4);h.writeUInt32BE(v.length);process.stdout.write(Buffer.concat([h,v]));}}});process.stdin.on('end',()=>process.exit(0));`;
    const child = spawn(process.execPath, ["-e", script, framePath], {
      windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    wallet = framedWalletProcess(child);
    const db = createWatcherDb({ ...env(), PGDATABASE: largeDb });
    const initialContext = await db.context();
    assert.equal(initialContext.account_ref, meta.account_ref);
    assert.equal(initialContext.market_id, meta.market_id);
    assert.equal(initialContext.vault_context_ref, meta.vault_context_ref);
    assert.match(initialContext.closes_at_us, /^[0-9]+(?:\.0+)?$/);
    assert.equal(
      BigInt(initialContext.closes_at_us.split(".")[0]),
      BigInt(meta.close) * 1_000_000n,
    );
    const result = await createCoordinator({
      db,
      wallet,
      stopFile: join(dir, "stop"),
    }).cycle();
    assert.equal(result.result, "RECONCILED");
    const context = await db.context();
    assert.equal(context.revision, "1");
    assert.equal(context.receipts.length, 0);
    assert.equal(context.hold, false);
    console.log(
      JSON.stringify({
        bounded_close_history_span:
          snapshot.chain.tip_height - meta.anchor + 11,
        rust_frame_bytes: frame.length,
        boundary_records: snapshot.chain.close_proof.window.length,
        anchor_records: snapshot.chain.close_proof.anchor_window.length,
        inclusion_records: snapshot.chain.inclusion_blocks.length,
      }),
    );
    assert.equal(
      await psql(
        "SELECT count(*) FROM darkpool_private.watcher_evidence WHERE kind='BOUNDARY';",
        { database: largeDb },
      ),
      "1",
    );
    assert.equal(
      await psql("SELECT count(*) FROM darkpool_private.accepted_payments;", {
        database: largeDb,
      }),
      "0",
    );
  } finally {
    await wallet?.close();
    if (made) {
      assert.match(largeDb, /^darkpool_phase9_[a-f0-9]{16}$/);
      await psql(`DROP DATABASE "${largeDb}";`, { database: maintenance });
    }
    assert.equal(resolve(dir), dir);
    assert.ok(
      dir.startsWith(join(resolve(tmpdir()), "darkpool-bounded-close-")),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

before(async () => {
  assert.equal(
    maintenance,
    "postgres",
    "maintenance DB only; product dev must not be adopted",
  );
  await psql(
    `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
    { database: maintenance },
  );
  created = true;
  await migrate({ database });
  await psql(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE "${reader}" NOLOGIN;`,
    { database: maintenance },
  );
  roles = true;
  await sql(provisionWatcherScript(role));
  await sql(provisionPublicScript(reader));
});
after(async () => {
  if (created) {
    assert.match(database, /^darkpool_phase9_[a-f0-9]{16}$/);
    await psql(`DROP DATABASE "${database}";`, { database: maintenance });
  }
  if (roles)
    await psql(`DROP ROLE "${role}"; DROP ROLE "${reader}";`, {
      database: maintenance,
    });
});

test("DB01 exact one-output acceptance atomically records group, membership, evidence and audit, independent YES/NO", async () => {
  await isolated(
    reconcile(request([output(), output(2)])) +
      check(accepted()) +
      check(accepted(2)) +
      check("SELECT count(*)=2 FROM accepted_payments") +
      check("SELECT count(*)=2 FROM accepted_payment_receipts") +
      check("SELECT count(*)=2 FROM watcher_evidence WHERE kind='ACCEPTANCE'") +
      check(
        "SELECT count(*)=2 FROM audit_events WHERE event='TICKET_CONFIRMED'",
      ) +
      check(
        "SELECT bool_and(accepted_at>to_timestamp(0)) FROM tickets WHERE accepted_amount_zat>0",
      ),
  );
});
for (const [name, values] of [
  ["underpayment", [900]],
  ["overpayment entire principal", [1100]],
  ["two partials never aggregate", [400, 600]],
]) {
  test(`DB policy: ${name}`, async () => {
    await isolated(
      reconcile(
        request(
          values.map((v, i) =>
            output(1, { amount_zat: String(v), output_index: i }),
          ),
        ),
      ) +
        check(noStake) +
        check(
          `SELECT count(*)=${values.length} AND sum(principal_zat)=${values.reduce((a, b) => a + b, 0)} FROM payment_liabilities`,
        ),
    );
  });
}
test("DB05 deterministic height/transaction/pool/output ordering ignores arrival; all other principal stays separate", async () => {
  const notes = [
    output(1, { txid: hash(2004), tx_index: 9, output_index: 0 }),
    output(1, { txid: hash(2003), tx_index: 2, output_index: 2 }),
    output(1, { txid: hash(2002), tx_index: 2, output_index: 1 }),
    output(1, {
      txid: hash(2001),
      tx_index: 2,
      output_index: 8,
      pool: "ORCHARD",
    }),
    output(1, {
      txid: hash(2000),
      tx_index: 1,
      block_height: 102,
      block_hash: hash(102),
      block_time: C - 18,
    }),
  ];
  await isolated(
    reconcile(request(notes, { tip: 104 })) +
      check(accepted()) +
      check(
        `SELECT encode(p.txid,'hex')='${hash(2001)}' FROM payment_receipts p JOIN accepted_payment_receipts a ON a.receipt_id=p.id`,
      ) +
      check(
        "SELECT count(*)=4 AND sum(principal_zat)=4000 FROM payment_liabilities",
      ),
  );
});
for (const confirmations of [1, 2, 3]) {
  test(`DB confirmations: ${confirmations}`, async () => {
    await isolated(
      reconcile(request([output()], { tip: 100 + confirmations })) +
        check(confirmations === 3 ? accepted() : noStake),
    );
  });
}
for (const [name, delta] of [
  ["timestamp equality is late", 0],
  ["after close is late", 1],
]) {
  test(`DB close: ${name}`, async () => {
    await isolated(
      reconcile(
        request([output(1, { block_time: C + delta })], {
          base: C + delta - 1,
        }),
      ) +
        check(noStake) +
        check(
          "SELECT principal_zat=1000 AND state_policy_ref='phase9-late' FROM payment_liabilities",
        ),
    );
  });
}
test("DB close: timely payment accepts after actual wall clock close", async () => {
  const close = Math.floor(Date.now() / 1000) + 2;
  await isolated(
    `SELECT pg_sleep(2.1);` +
      reconcile(request([output(1, { block_time: close - 19 })], { close })) +
      check(accepted()),
    close,
  );
});
test("DB MTP: first preceding-11 crossing persists minimal boundary, equality closes; nonmonotonic and gaps reject", async () => {
  const r = request([], { tip: 115, base: C - 6 });
  await isolated(
    reconcile(r) +
      check(
        "SELECT (details->>'height')::bigint=112 AND (details->>'close_height')::bigint=111 AND jsonb_array_length(details->'window')=12 FROM watcher_evidence WHERE kind='BOUNDARY'",
      ),
  );
  const invalid = structuredClone(r);
  invalid.request_id = randomBytes(32).toString("hex");
  invalid.chain.mtp_blocks[11].time = C - 100;
  await assert.rejects(
    isolated(reconcile(invalid)),
    (e) => e.sqlstate === "P4903",
  );
  const gap = structuredClone(r);
  gap.chain.mtp_blocks.splice(4, 1);
  await assert.rejects(isolated(reconcile(gap)), (e) => e.sqlstate === "P4903");
});
test("DB duplicate observation/scan/request retain one stake; conflicting same request fails", async () => {
  const observe = {
    ...request([output(1, { canonical: false })]),
    mode: "observe_only",
  };
  delete observe.chain;
  const snapshot = request([output()]),
    duplicate = request([output()]);
  const conflict = { ...snapshot, mode: "observe_only" };
  delete conflict.chain;
  await isolated(
    reconcile(observe) +
      reconcile(observe) +
      reconcile(snapshot, 1) +
      reconcile(snapshot, 1) +
      reconcile(duplicate, 2) +
      check(accepted()) +
      check("SELECT count(*)=1 FROM payment_receipts") +
      check("SELECT count(*)=1 FROM accepted_payments") +
      fail(`SELECT darkpool_watcher.reconcile(1,${json(conflict)})`, "P4902") +
      check("SELECT count(*)=1 FROM watcher_evidence WHERE kind='OBSERVATION'"),
  );
});
test("DB preaccept reorg retains principal, removes qualification; re-mining may qualify", async () => {
  const a = request([output()], { tip: 101 }),
    orphan = request([output(1, { present: false, canonical: false })], {
      tip: 102,
    });
  const remine = request(
    [
      output(1, {
        block_height: 102,
        block_hash: hash(102),
        block_time: C - 18,
      }),
    ],
    { tip: 104 },
  );
  await isolated(
    reconcile(a) +
      reconcile(orphan, 1) +
      check(noStake) +
      check(
        "SELECT count(*)=1 AND bool_and(block_height IS NULL) FROM payment_receipts",
      ) +
      reconcile(remine, 2) +
      check(accepted()) +
      check("SELECT count(*)=1 FROM payment_receipts"),
  );
});
test("DB changed mapping before acceptance cannot reuse a stale qualifying candidate", async () => {
  await isolated(
    reconcile(request([output()], { tip: 101 })) +
      reconcile(request([output(1, { receiver_verified: false })]), 1) +
      check(noStake) +
      check("SELECT hold_ref IS NOT NULL FROM watcher_state") +
      check("SELECT count(*)=0 FROM accepted_payments"),
  );
});
test("DB PAUSED retains, synchronizes, classifies without accepting; frozen ledger blocks acceptance", async () => {
  await isolated(
    "UPDATE markets SET status='PAUSED';" +
      reconcile(request([output()])) +
      check(noStake) +
      check("SELECT count(*)=1 FROM payment_receipts"),
  );
  await isolated(
    "INSERT INTO ledger_sets VALUES('m9','p9-test',NULL); UPDATE ledger_sets SET frozen_at=now();" +
      reconcile(request([output()])) +
      check(noStake),
  );
});
test("DB unmapped, wrong receiver, internal, change and Sapling output never guessed by amount", async () => {
  const rows = [
    output(1, { receiver_ref: "wrong", txid: hash(4000) }),
    output(1, { receiver_verified: false, txid: hash(4001) }),
    output(1, { key_scope: 1, txid: hash(4002) }),
    output(1, { is_change: true, txid: hash(4003) }),
    output(1, { pool: "SAPLING", txid: hash(4004) }),
  ];
  await isolated(
    reconcile(request(rows)) +
      check(noStake) +
      check("SELECT count(*)=0 FROM payment_receipts") +
      check("SELECT count(*)=5 FROM watcher_evidence WHERE kind='OBSERVATION'"),
  );
});
test("DB postaccept contradiction preserves accepted history; sticky hold forbids replacement and progression", async () => {
  const a = request([output()]),
    contradiction = request([
      output(1, { canonical: false, present: false }),
      output(2),
    ]);
  await isolated(
    reconcile(a) +
      reconcile(contradiction, 1) +
      check(accepted()) +
      check(
        "SELECT accepted_amount_zat=0 FROM tickets WHERE side='NO' LIMIT 1",
      ) +
      check(
        "SELECT hold_ref IS NOT NULL AND checkpoint_ref='reconcile:" +
          a.request_id +
          "' FROM watcher_state",
      ) +
      reconcile(request([output(), output(2)]), 2) +
      check("SELECT sum(accepted_amount_zat)=1000 FROM tickets") +
      fail("UPDATE watcher_state SET revision=revision+1,hold_ref=NULL") +
      fail("UPDATE payment_receipts SET block_height=102") +
      fail(
        "UPDATE tickets SET accepted_amount_zat=0,accepted_at=NULL,accepted_payment_ref=NULL,payment_state='AWAITING_PAYMENT' WHERE accepted_amount_zat>0",
      ) +
      fail("INSERT INTO ledger_sets VALUES('m9','p9-test',now())") +
      fail("UPDATE markets SET status='LOCKED'") +
      fail("UPDATE watcher_evidence SET details='{}' WHERE kind='ACCEPTANCE'"),
  );
  const changed = request([output(1, { block_time: C - 18 })]);
  changed.chain.mtp_blocks.find((b) => b.height === 101).time = C - 18;
  await isolated(
    reconcile(request([output()])) +
      reconcile(changed, 1) +
      check(accepted()) +
      check("SELECT hold_ref IS NOT NULL FROM watcher_state"),
  );
});
test("DB missing/null/forged frame fields and incomplete inclusion fail without writes", async () => {
  for (const edit of [
    (r) => delete r.request_id,
    (r) => delete r.network,
    (r) => delete r.outputs[0].txid,
    (r) => delete r.outputs[0].is_change,
    (r) => delete r.outputs[0].block_time,
    (r) => (r.chain.complete = "true"),
    (r) => (r.chain.verified_at = "2000-01-01Z"),
    (r) => r.outputs[0].block_time++,
    (r) => r.outputs.push({ ...r.outputs[0] }),
    (r) => (r.chain.scanned_hash = hash(99)),
    (r) => (r.claim_secret = "never retained"),
    (r) => (r.outputs[0].memo = "never retained"),
  ]) {
    const r = request([output()]);
    edit(r);
    await assert.rejects(isolated(reconcile(r)));
  }
  const r = request([]);
  r.mode = "safety_stop";
  delete r.chain;
  delete r.outputs;
  await assert.rejects(isolated(reconcile(r)), (e) => e.sqlstate === "P4901");
});
test("DB private capabilities deny tables, helpers, issuance, admin, public reader watcher access and overprivileged role", async () => {
  for (const q of [
    "SELECT * FROM darkpool_private.tickets",
    "SELECT * FROM darkpool_private.watcher_evidence",
    "SELECT darkpool_admin.command('open','{}')",
    "SELECT darkpool_issuance.reserve(NULL,NULL,NULL,NULL,NULL)",
    "SELECT darkpool_watcher.guard_state()",
  ])
    await assert.rejects(watcherQuery(q, env()), {
      message: "WATCHER_UNAVAILABLE",
    });
  await isolated(
    fail(
      `SET LOCAL ROLE "${reader}"; SELECT darkpool_watcher.context()`,
      "42501",
    ) +
      `SET LOCAL ROLE "${reader}"; SELECT * FROM darkpool_public.markets; RESET ROLE;`,
  );
  await assert.rejects(
    watcherQuery("SELECT darkpool_watcher.context();", {
      ...env(),
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    }),
    { message: "WATCHER_UNAVAILABLE" },
  );
  await sql(`GRANT SELECT ON darkpool_private.tickets TO "${role}"`);
  try {
    await assert.rejects(watcherQuery("SELECT 1;", env()), {
      message: "WATCHER_UNAVAILABLE",
    });
  } finally {
    await sql(`REVOKE SELECT ON darkpool_private.tickets FROM "${role}"`);
  }
});
test("DB injected write failure rolls back receipt/group/ticket/audit/evidence/revision and exact retry recovers", async () => {
  const r = request([output()]);
  await isolated(
    `CREATE FUNCTION pg_temp.break_audit() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RAISE EXCEPTION USING ERRCODE='P4999',MESSAGE='synthetic storage fault'; END $t$;
    CREATE TRIGGER synthetic_storage_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION pg_temp.break_audit();` +
      fail(`SELECT darkpool_watcher.reconcile(0,${json(r)})`, "P4999") +
      check(noStake) +
      check("SELECT count(*)=0 FROM payment_receipts") +
      check("SELECT count(*)=0 FROM accepted_payments") +
      check("SELECT count(*)=0 FROM watcher_evidence WHERE kind<>'PROFILE'") +
      check("SELECT revision=0 FROM watcher_state") +
      "DROP TRIGGER synthetic_storage_fault ON audit_events;" +
      reconcile(r) +
      check(accepted()),
  );
});
test("DB real login concurrency, stale revision, restart and ambiguous commit retry", async () => {
  await sql(`BEGIN; ${fixture()} COMMIT;`);
  const db = createWatcherDb(env());
  const context = await db.context();
  assert.equal(context.revision, "0");
  const r = request([output()]);
  const results = await Promise.all([
    db.reconcile("0", r),
    db.reconcile("0", r),
  ]);
  assert.deepEqual(results[0], results[1]);
  const restarted = createWatcherDb(env());
  assert.deepEqual(await restarted.reconcile("0", r), results[0]); // committed reply deliberately ignored above
  await assert.rejects(restarted.reconcile("0", request([output()])), {
    message: "WATCHER_CONFLICT",
  });
  const revision = (await restarted.context()).revision;
  const race = await Promise.allSettled([
    db.reconcile(revision, request([output()])),
    db.reconcile(revision, request([output()])),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.accepted_payments"),
    "1",
  );
  const unavailable = createWatcherDb({ ...env(), PGPORT: "1" });
  await assert.rejects(unavailable.context(), {
    message: "WATCHER_UNAVAILABLE",
  });
  const current = await restarted.context();
  const contradiction = request([
    output(1, { canonical: false, present: false }),
  ]);
  assert.equal(
    (await restarted.reconcile(current.revision, contradiction)).result,
    "HELD",
  );
  assert.equal((await createWatcherDb(env()).context()).hold, true);
});

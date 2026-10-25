import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, psql } from "../../../db/test-fixtures.mjs";
import { provisionIssuanceScript } from "../../../db/issuance-provision.mjs";
import {
  issuanceQuery,
  issuancePrivilegeCheck,
} from "../../../db/issuance-runtime.mjs";
import { provisionPublicScript } from "../../../db/public-provision.mjs";
import {
  createIssuer,
  allocateInternal,
  parseIssuance,
} from "../src/issuance.mjs";
import { createIssuanceServer } from "../src/issuance-server.mjs";
import { launchBrowser } from "./vault-browser.mjs";
import { createServer } from "node:http";

const suffix = randomBytes(8).toString("hex"),
  database = `darkpool_phase7_${suffix}`,
  role = `darkpool_issue_${suffix}`,
  reader = `darkpool_p7_reader_${suffix}`;
const password = randomBytes(32).toString("hex"),
  authority = randomBytes(32).toString("hex"),
  maintenance = process.env.PGDATABASE;
let directory,
  wallet,
  allocator,
  allocatorClosed,
  allocationPort,
  created = false,
  roles = false,
  issuedCount = 0;
let stdout = "",
  stderr = "";
const sql = (query) => psql(query, { database });
const env = () => ({
  ...process.env,
  APP_ENV: "development",
  DARKPOOL_ISSUANCE_INTERNAL: "1",
  ZCASH_NETWORK: "testnet",
  PGDATABASE: database,
  PGUSER: role,
  PGPASSWORD: password,
  ALLOCATION_PORT: String(allocationPort),
  ALLOCATION_AUTH: authority,
});
const query = (q) => issuanceQuery(q, env());
const allocate = (c) => allocateInternal(c, env());
const issuer = createIssuer({ query, allocate });
const token = () => randomBytes(32).toString("hex");
const hash = (t) =>
  createHash("sha256").update(Buffer.from(t, "hex")).digest("hex");
const reservation = (t) => ({
  operation: "reserve",
  issuance_token: t,
  market_id: "m7",
  side: "YES",
  requested_amount_zat: "1000",
});
const completion = (t, id, digest = "ab".repeat(32)) => ({
  operation: "complete",
  issuance_token: t,
  ticket_id: id,
  claim_commitment: digest,
  claim_commitment_profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1",
});
const runProgram = (path, args, extra = {}) =>
  new Promise((done, reject) => {
    const child = spawn(path, args, {
      env: { ...process.env, ...extra },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("Test executable unavailable")));
    child.on("close", (code) =>
      code === 0 ? done() : reject(new Error("Test executable failed")),
    );
  });

async function startAllocator() {
  const extension = process.platform === "win32" ? ".exe" : "";
  allocator = spawn(
    resolve(`target/debug/darkpool-zcash${extension}`),
    ["serve-allocation"],
    {
      env: {
        ...process.env,
        ZCASH_NETWORK: "testnet",
        WALLET_DB_PATH: wallet,
        ALLOCATION_MARKET_ID: "m7",
        ALLOCATION_VAULT_CONTEXT: "v7",
        ALLOCATION_AUTH: authority,
        ALLOCATION_PORT: "0",
      },
      windowsHide: true,
    },
  );
  allocatorClosed = new Promise((done) => allocator.once("close", done));
  allocator.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  allocationPort = await new Promise((done, reject) => {
    let startup = "";
    const timer = setTimeout(
      () => reject(new Error("Allocator startup timed out")),
      10000,
    );
    allocator.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Allocator startup failed"));
    });
    allocator.stdout.on("data", (chunk) => {
      stdout += chunk;
      startup += chunk;
      const found = /127\.0\.0\.1:(\d+)/.exec(startup);
      if (found) {
        clearTimeout(timer);
        done(+found[1]);
      }
    });
  });
}
before(async () => {
  assert.ok(maintenance);
  directory = await mkdtemp(join(tmpdir(), "darkpool-phase7-"));
  wallet = join(directory, "unfunded.sqlite");
  const extension = process.platform === "win32" ? ".exe" : "";
  await runProgram(
    resolve(`target/debug/examples/issuance-fixture${extension}`),
    [wallet],
    { DARKPOOL_SYNTHETIC_TEST: "1" },
  );
  await startAllocator();
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
  await sql(provisionIssuanceScript(role));
  await sql(provisionPublicScript(reader));
  // Owner-only OPEN fixture. Admin OPEN remains blocked; no reviewed payment policy.
  await sql(`INSERT INTO darkpool_private.policy_refs VALUES('unresolved7','UNPINNED','test fixture only',NULL);
    INSERT INTO darkpool_private.markets VALUES('m7',1,'testnet','v7','Synthetic question','Yes definition','No definition',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','unresolved7','Rule',ARRAY['source'],ARRAY['void'],1,100000000,'unresolved7','unresolved7','NO_WINNER_REFUND',NULL,NULL,'DRAFT',now(),now());
    UPDATE darkpool_private.markets SET status='OPEN';`);
});
after(async () => {
  allocator?.kill();
  await allocatorClosed;
  assert.equal(stderr, "");
  assert.match(
    stdout,
    /^(Private testnet allocator listening on 127\.0\.0\.1:\d+\r?\n)+$/,
  );
  if (created)
    await psql(`DROP DATABASE "${database}";`, { database: maintenance });
  if (roles)
    await psql(`DROP ROLE "${role}"; DROP ROLE "${reader}";`, {
      database: maintenance,
    });
  if (directory) {
    assert.ok(
      resolve(directory).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ),
    );
    assert.ok(basename(directory).startsWith("darkpool-phase7-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Phase 7 strict commitment-only inputs, authenticated role and public mapping denial", async () => {
  const t = token();
  for (const bad of [
    { ...reservation(t), claim_secret: "secret" },
    { ...reservation(t), local_id: 1 },
    { ...reservation(t), requested_amount_zat: 1000 },
    { ...reservation(t), requested_amount_zat: "0" },
    { ...reservation(t), side: "MAYBE" },
    { ...completion(t, token()), claim_secret: "secret" },
    { ...completion(t, token()), claim_commitment_profile: "unknown" },
  ])
    assert.throws(() => parseIssuance(bad), { message: "INVALID_REQUEST" });
  await assert.rejects(
    issuanceQuery("SELECT 1;", {
      ...env(),
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    }),
    { message: "ISSUANCE_UNAVAILABLE" },
  );
  for (const q of [
    "SELECT * FROM darkpool_private.issuance_attempts;",
    "SELECT * FROM darkpool_private.tickets;",
    "SELECT darkpool_admin.command('open','{}');",
    "SELECT * FROM darkpool_migrations.applied;",
  ])
    await assert.rejects(query(q), { message: "ISSUANCE_UNAVAILABLE" });
  await assert.rejects(
    sql(
      `SET ROLE "${reader}"; SELECT * FROM darkpool_private.issuance_attempts;`,
    ),
  );
  await assert.rejects(
    sql(
      `SET ROLE "${reader}"; SELECT darkpool_issuance.reserve(decode(repeat('ab',32),'hex'),'m7','YES','1',repeat('ab',32));`,
    ),
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM information_schema.columns WHERE table_schema='darkpool_private' AND column_name IN ('claim_secret','issuance_token','seed','ufvk','spending_key','user_id');",
    ),
    "0",
  );
  await assert.rejects(
    allocateInternal(
      {
        market_id: "m7",
        vault_context_ref: "v7",
        ticket_id: token(),
        claim_commitment: "ab".repeat(32),
      },
      { ...env(), ALLOCATION_AUTH: token() },
    ),
  );
  assert.equal(
    await sql("SELECT darkpool_admin.command('open','{}')->>'result';"),
    "BLOCKED",
  );
  await sql(`GRANT USAGE ON SCHEMA darkpool_private TO "${role}";`);
  await assert.rejects(query("SELECT 1;"));
  await sql(`REVOKE USAGE ON SCHEMA darkpool_private FROM "${role}";`);
  assert.equal(
    await query(
      `SELECT to_json(permitted) FROM (${issuancePrivilegeCheck}) AS checked(permitted);`,
    ),
    true,
  );
  for (const requested_amount_zat of ["100000001", "0001", "1.2", "-1"])
    await assert.rejects(
      issuer({ ...reservation(token()), requested_amount_zat }),
      { message: "INVALID_REQUEST" },
    );
});

test("Generic HTTP operation, origin/body guards, private response allowlist and sanitized failures", async () => {
  let mode = "normal",
    calls = 0;
  const server = createIssuanceServer({
    issue: async (input) => {
      calls++;
      parseIssuance(input);
      if (mode === "failure") throw new Error("private database diagnostic");
      const result = {
        issuance_profile_version: 1,
        network: "testnet",
        market_id: "m7",
        ticket_id: "ab".repeat(32),
        closes_at: "2030-01-01T00:00:00.000000Z",
        status: "RESERVED",
      };
      return mode === "leak"
        ? { ...result, side: "YES", claim_commitment: "cd".repeat(32) }
        : result;
    },
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) =>
    fetch(base + "/api/issuance", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    const raw = "ef".repeat(32),
      t = token();
    const rejected = await post({ ...reservation(t), claim_secret: raw });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "INVALID_REQUEST" });
    const hostile = await post(reservation(t), {
      Origin: "https://other.example",
    });
    assert.equal(hostile.status, 403);
    assert.equal((await fetch(base + "/api/issuance?side=YES")).status, 400);
    assert.equal((await fetch(base + "/api/issuance")).status, 405);
    assert.equal((await post({ padding: "x".repeat(17000) })).status, 413);
    assert.equal(calls, 1);
    mode = "leak";
    const leaked = await post(reservation(t));
    assert.equal(leaked.status, 503);
    assert.deepEqual(await leaked.json(), { error: "ISSUANCE_UNAVAILABLE" });
    mode = "failure";
    const failed = await post(reservation(t));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "ISSUANCE_UNAVAILABLE" });
    mode = "normal";
    const success = await post(reservation(t));
    assert.equal(success.status, 200);
    const text = await success.text();
    assert.ok(!text.includes(t) && !text.includes(raw));
    assert.equal(success.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise((done) => server.close(done));
  }
});
test("Reservation concurrency, independent server IDs, immutable-input conflict and hash-only SQL", async () => {
  const t = token(),
    r = reservation(t);
  let captured = "";
  const observing = createIssuer({
    query: async (q) => {
      captured += q;
      return query(q);
    },
    allocate,
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => observing(r)),
  );
  assert.ok(results.every((value) => value.ticket_id === results[0].ticket_id));
  assert.match(results[0].ticket_id, /^[0-9a-f]{64}$/);
  assert.notEqual(results[0].ticket_id, t);
  assert.ok(!captured.includes(t));
  assert.ok(captured.includes(hash(t)));
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.tickets;"),
    "0",
  );
  for (const changed of [
    { side: "NO" },
    { requested_amount_zat: "1001" },
    { market_id: "another" },
  ])
    await assert.rejects(issuer({ ...r, ...changed }), {
      message: "ISSUANCE_CONFLICT",
    });
  const independent = await issuer(reservation(token()));
  assert.notEqual(independent.ticket_id, results[0].ticket_id);
});
test("Real allocator: 101 issued tickets have fresh private mappings and retries never allocate again", async () => {
  const addresses = new Set();
  for (let n = 0; n < 101; n++) {
    const t = token(),
      r = await issuer({ ...reservation(t), side: n % 2 ? "NO" : "YES" }),
      c = completion(t, r.ticket_id);
    const [a, b] = await Promise.all([issuer(c), issuer(c)]);
    assert.deepEqual(a, b);
    assert.equal(a.status, "ISSUED");
    assert.deepEqual(Object.keys(a).sort(), [
      "closes_at",
      "issuance_profile_version",
      "market_id",
      "network",
      "receiving_ua",
      "status",
      "ticket_id",
    ]);
    assert.ok(!addresses.has(a.receiving_ua));
    addresses.add(a.receiving_ua);
    assert.deepEqual(await issuer(c), a);
    await assert.rejects(issuer({ ...c, claim_commitment: "cd".repeat(32) }), {
      message: "ISSUANCE_CONFLICT",
    });
  }
  issuedCount = 101;
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.tickets;"),
    String(issuedCount),
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.tickets WHERE accepted_amount_zat<>0 OR accepted_at IS NOT NULL OR accepted_payment_ref IS NOT NULL OR payment_state<>'AWAITING_PAYMENT';",
    ),
    "0",
  );
  const conn = new DatabaseSync(wallet, { readOnly: true });
  assert.equal(
    conn.prepare("SELECT count(*) AS n FROM ext_darkpool_allocations").get().n,
    101,
  );
  conn.close();
  const publicRow = await sql(
    `SET ROLE "${reader}"; SELECT row_to_json(m) FROM darkpool_public.markets m;`,
  );
  assert.doesNotMatch(
    publicRow,
    /receiver|ticket|diversifier|commitment|issuance|side|1000|v7/,
  );
});
test("REC01: crash/lost wallet reply, failed product finish and lost successful HTTP response recover same allocation", async () => {
  const t = token(),
    r = await issuer(reservation(t)),
    c = completion(t, r.ticket_id);
  let allocated;
  const lostWallet = createIssuer({
    query,
    allocate: async (context) => {
      allocated = await allocate(context);
      throw new Error("simulated lost private response");
    },
  });
  await assert.rejects(lostWallet(c));
  allocator.kill();
  await allocatorClosed;
  await startAllocator();
  assert.equal(
    await sql(
      `SELECT state FROM darkpool_private.issuance_attempts WHERE ticket_id='${r.ticket_id}';`,
    ),
    "COMPLETING",
  );
  const failedFinish = createIssuer({
    query: (q) =>
      q.includes("darkpool_issuance.finish")
        ? Promise.reject(new Error("database unavailable"))
        : query(q),
    allocate,
  });
  await assert.rejects(failedFinish(c));
  const success = await issuer(c);
  assert.equal(success.receiving_ua, allocated.ua);
  assert.deepEqual(await issuer(c), success);
  issuedCount++;
  const conn = new DatabaseSync(wallet, { readOnly: true });
  assert.equal(
    conn
      .prepare(
        "SELECT count(*) AS n FROM ext_darkpool_allocations WHERE ticket=?",
      )
      .get(r.ticket_id).n,
    1,
  );
  conn.close();
  assert.equal(
    await sql("SELECT count(*) FROM darkpool_private.tickets;"),
    String(issuedCount),
  );
});
test("Browser original secret, pending persistence, failed finalization and network/privacy boundary", async () => {
  const assets = createIssuanceServer({ issue: issuer });
  const server = createServer((req, res) => {
    if (req.url === "/test") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>Phase 7 browser test</title>");
    } else assets.emit("request", req, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`,
    browser = await launchBrowser();
  try {
    await browser.navigate(base + "/test");
    await browser.evaluate(`(async()=>{
      const {openLocalVault}=await import('/local-vault.mjs');const {openIssuanceClient}=await import('/issuance-client.mjs');
      const vault=await openLocalVault();const id=await vault.createDraft();const original=await vault.readCredential(id);
      const client=await openIssuanceClient(vault);const before=Array.from(original.claim_secret);
      const originalFetch=globalThis.fetch;let lostReserve=false,lostComplete=false;
      const rawHex=before.map(b=>b.toString(16).padStart(2,'0')).join('');
      globalThis.fetch=async function(url,options){if(String(url).includes(rawHex)||options.body.includes(rawHex))throw new Error('Secret escaped browser boundary');const response=await originalFetch(url,options);const op=JSON.parse(options.body).operation;
        if(op==='reserve'&&!lostReserve){lostReserve=true;throw new Error('lost reservation response');}
        if(op==='complete'&&!lostComplete){lostComplete=true;throw new Error('lost issued response');}
        return response;};
      for(let n=0;n<2;n++){let rejected=false;try{await client.issue(id,{market_id:'m7',side:'NO',requested_amount_zat:'1000'});}catch{rejected=true;}if(!rejected)throw new Error('Lost response boundary failed');}
      globalThis.fetch=originalFetch;
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(record){if(this.name==='records'&&record.state==='FINALIZED')throw new Error('test local write failure');return put.call(this,record);};
      let failed=false;try{await client.issue(id,{market_id:'m7',side:'NO',requested_amount_zat:'1000'});}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
      const retained=await vault.readCredential(id);
      if(!failed||(await vault.list())[0].state!=='DRAFT'||!before.every((b,i)=>b===retained.claim_secret[i]))throw new Error('Local failure boundary failed');
      globalThis.testLocalId=id;globalThis.testSecretBefore=before;client.close();vault.close();return true;
    })()`);
    await browser.call("Page.reload");
    await browser.navigate(base + "/test");
    await browser.evaluate(`(async()=>{
      const {openLocalVault}=await import('/local-vault.mjs');const {openIssuanceClient}=await import('/issuance-client.mjs');
      const vault=await openLocalVault(),client=await openIssuanceClient(vault);const draft=(await vault.list())[0];
      const before=await vault.readCredential(draft.local_id);
      const rng=globalThis.crypto.getRandomValues;globalThis.crypto.getRandomValues=()=>{throw new Error('Recovery must not need fresh randomness');};
      const result=await client.issue(draft.local_id);globalThis.crypto.getRandomValues=rng;
      const after=await vault.readCredential(draft.local_id);
      if(!before.claim_secret.every((b,i)=>b===after.claim_secret[i])||result.ticket_id===String(draft.local_id)||(await vault.list())[0].state!=='FINALIZED')throw new Error('Finalization boundary failed');
      await client.issue(draft.local_id);
      const second=await vault.createDraft();await client.issue(second,{market_id:'m7',side:'YES',requested_amount_zat:'1000'});
      if((await vault.list()).length!==2)throw new Error('Independent tickets failed');
      client.close();vault.close();return true;
    })()`);
    issuedCount += 2;
    const requests = browser.events
      .filter((e) => e.method === "Network.requestWillBeSent")
      .map((e) => e.params.request);
    const posts = requests.filter((r) => r.method === "POST");
    assert.ok(posts.length >= 7);
    for (const r of posts) {
      assert.equal(r.url, base + "/api/issuance");
      const body = JSON.parse(r.postData);
      assert.equal(Object.hasOwn(body, "claim_secret"), false);
      assert.equal(Object.hasOwn(body, "local_id"), false);
      assert.equal(Object.hasOwn(body, "secret_tag"), false);
    }
    assert.equal(
      browser.events.filter((e) =>
        ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"].includes(
          e.method,
        ),
      ).length,
      0,
    );
    assert.equal(
      await sql("SELECT count(*) FROM darkpool_private.tickets;"),
      String(issuedCount),
    );
  } finally {
    await browser.stop();
    await new Promise((done) => server.close(done));
  }
});
test("Phase 8 formats a real issued destination without changing payment state, wallet allocation or schema privileges", async () => {
  const t = token(),
    r = await issuer(reservation(t)),
    issued = await issuer(completion(t, r.ticket_id));
  issuedCount++;
  const snapshot = () =>
    sql(
      `SELECT row_to_json(t)::text FROM darkpool_private.tickets t WHERE id='${r.ticket_id}';`,
    );
  const before = await snapshot();
  const conn = new DatabaseSync(wallet, { readOnly: true });
  const allocations = conn
    .prepare("SELECT count(*) AS n FROM ext_darkpool_allocations")
    .get().n;
  conn.close();
  const server = createIssuanceServer({ issue: issuer });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + "/api/payment-request", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({
        receiving_ua: issued.receiving_ua,
        requested_amount_zat: "1000",
      }),
    });
    assert.equal(response.status, 200);
    const payment = await response.json();
    assert.equal(
      payment.payment_uri,
      `zcash:${issued.receiving_ua}?amount=0.00001`,
    );
    assert.equal(await snapshot(), before);
    const ticket = JSON.parse(before);
    assert.equal(ticket.payment_state, "AWAITING_PAYMENT");
    assert.equal(ticket.accepted_amount_zat, 0);
    assert.equal(ticket.accepted_payment_ref, null);
    assert.equal(ticket.accepted_at, null);
    const reopened = new DatabaseSync(wallet, { readOnly: true });
    assert.equal(
      reopened
        .prepare("SELECT count(*) AS n FROM ext_darkpool_allocations")
        .get().n,
      allocations,
    );
    reopened.close();
    assert.equal(
      await sql("SELECT count(*) FROM darkpool_private.payment_receipts;"),
      "0",
    );
    await assert.rejects(query("SELECT * FROM darkpool_private.tickets;"));
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("PAY10: pause and inconsistent multi-market state fail closed; deferred deadline rolls back", async () => {
  // DRAFT is used only to update the synthetic owner fixture before re-opening.
  const t = token(),
    r = await issuer(reservation(t)),
    c = completion(t, r.ticket_id);
  let allocation;
  const pause = createIssuer({
    query,
    allocate: async (context) => {
      allocation = await allocate(context);
      await sql("UPDATE darkpool_private.markets SET status='PAUSED';");
      return allocation;
    },
  });
  await assert.rejects(pause(c));
  assert.equal(
    await sql(
      `SELECT count(*) FROM darkpool_private.tickets WHERE id='${r.ticket_id}';`,
    ),
    "0",
  );
  await assert.rejects(issuer(reservation(token())));
  await sql("UPDATE darkpool_private.markets SET status='OPEN';");
  assert.equal((await issuer(c)).receiving_ua, allocation.ua);
  issuedCount++;
  // Approved production rule remains immutable; a temporary isolated synthetic
  // market is owner-provisioned with a near deadline, without bypassing triggers.
  await sql(
    `BEGIN; INSERT INTO darkpool_private.markets SELECT 'boundary',version,network,'vb',question,yes_definition,no_definition,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '0.6 second',close_policy_ref,resolution_rule,resolution_sources,void_conditions,min_stake_zat,max_stake_zat,payment_policy_ref,fee_policy_ref,zero_winner_policy,deposit_confirmations,payout_confirmations,'OPEN',now(),now() FROM darkpool_private.markets; COMMIT;`,
  );
  // Multi-market state fails closed, including reservation retries.
  await assert.rejects(issuer(reservation(t)));
  await sql("DELETE FROM darkpool_private.markets WHERE id='boundary';");
  // Direct helper proves deferred close equality without changing market rules.
  await sql(`BEGIN; INSERT INTO darkpool_private.markets SELECT 'boundary',version,network,'vb',question,yes_definition,no_definition,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '0.25 second',close_policy_ref,resolution_rule,resolution_sources,void_conditions,min_stake_zat,max_stake_zat,payment_policy_ref,fee_policy_ref,zero_winner_policy,deposit_confirmations,payout_confirmations,'OPEN',now(),now() FROM darkpool_private.markets;
    INSERT INTO darkpool_private.issuance_attempts VALUES(decode(repeat('ff',32),'hex'),repeat('ff',32),'boundary','vb','YES',1,NULL,'RESERVED'); SELECT pg_sleep(0.4); COMMIT;`).then(
    () => assert.fail("Post-close commit accepted"),
    () => {},
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM darkpool_private.markets WHERE id='boundary';",
    ),
    "0",
  );
  const persisted = await issuer(c);
  await sql("UPDATE darkpool_private.markets SET status='LOCKED';");
  assert.deepEqual(await issuer(c), persisted);
  await assert.rejects(issuer(reservation(token())));
  const neverCompleted = await sql(
    "SELECT ticket_id,encode(token_hash,'hex') AS h FROM darkpool_private.issuance_attempts WHERE state='RESERVED' LIMIT 1;",
  );
  assert.ok(neverCompleted);
});

test("Actual UTC close: issued recovery succeeds, new issuance fails, finish crossing close rolls back", async () => {
  const boundary = `darkpool_phase7_boundary_${suffix}`;
  await psql(
    `CREATE DATABASE "${boundary}" TEMPLATE template0 ENCODING 'UTF8';`,
    { database: maintenance },
  );
  const owner = (q) => psql(q, { database: boundary });
  try {
    await migrate({ database: boundary });
    await owner(provisionIssuanceScript(role));
    await owner(`INSERT INTO darkpool_private.policy_refs VALUES('unresolved7','UNPINNED','test fixture only',NULL);
      INSERT INTO darkpool_private.markets VALUES('m7',1,'testnet','v7','Synthetic close question','Yes definition','No definition',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '3 seconds','unresolved7','Rule',ARRAY['source'],ARRAY['void'],1,100000000,'unresolved7','unresolved7','NO_WINNER_REFUND',NULL,NULL,'OPEN',now(),now());`);
    const boundaryQuery = (q) =>
      issuanceQuery(q, { ...env(), PGDATABASE: boundary });
    const boundaryIssuer = createIssuer({ query: boundaryQuery, allocate });
    const t = token(),
      r = await boundaryIssuer(reservation(t)),
      c = completion(t, r.ticket_id),
      issued = await boundaryIssuer(c);
    const pendingToken = token(),
      pending = await boundaryIssuer(reservation(pendingToken));
    let existing;
    const crossing = createIssuer({
      query: (q) =>
        boundaryQuery(
          q.includes("darkpool_issuance.finish")
            ? q + " SELECT pg_sleep(4);"
            : q,
        ),
      allocate: async (context) => {
        existing = await allocate(context);
        return existing;
      },
    });
    await assert.rejects(
      crossing(completion(pendingToken, pending.ticket_id)),
      { message: "ISSUANCE_UNAVAILABLE" },
    );
    assert.ok(existing);
    assert.equal(
      await owner("SELECT count(*) FROM darkpool_private.tickets;"),
      "1",
    );
    assert.equal(
      await owner(
        `SELECT state FROM darkpool_private.issuance_attempts WHERE ticket_id='${pending.ticket_id}';`,
      ),
      "COMPLETING",
    );
    assert.deepEqual(await boundaryIssuer(c), issued);
    assert.deepEqual(await boundaryIssuer(reservation(t)), r);
    await assert.rejects(boundaryIssuer(reservation(token())), {
      message: "ISSUANCE_UNAVAILABLE",
    });
    await assert.rejects(
      boundaryIssuer(completion(pendingToken, pending.ticket_id)),
      { message: "ISSUANCE_UNAVAILABLE" },
    );
    const conn = new DatabaseSync(wallet, { readOnly: true });
    assert.equal(
      conn
        .prepare("SELECT ua FROM ext_darkpool_allocations WHERE ticket=?")
        .get(pending.ticket_id).ua,
      existing.ua,
    );
    conn.close();
  } finally {
    await psql(`DROP DATABASE "${boundary}";`, { database: maintenance });
  }
});

test("Actual issuance process logs startup only, with no request or private diagnostic logging", async () => {
  const child = spawn(
    process.execPath,
    [resolve("apps/web/src/issuance-cli.mjs")],
    {
      env: { ...env(), VAULT_PORT: "0" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = new Promise((done) => child.once("close", done));
  let out = "",
    err = "";
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  try {
    const port = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Issuance process startup timed out")),
        10000,
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Issuance process failed"));
      });
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const found = /127\.0\.0\.1:(\d+)/.exec(out);
        if (found) {
          clearTimeout(timer);
          done(+found[1]);
        }
      });
    });
    const base = `http://127.0.0.1:${port}`,
      raw = "fa".repeat(32),
      t = token();
    const post = (body) =>
      fetch(base + "/api/issuance", {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await fetch(base + "/")).status, 200);
    const invalid = await post({ ...reservation(t), claim_secret: raw });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "INVALID_REQUEST" });
    const unavailable = await post(reservation(t));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "ISSUANCE_UNAVAILABLE",
    });
    assert.equal(
      (await fetch(base + "/api/issuance?unexpected=1")).status,
      400,
    );
  } finally {
    child.kill();
    await closed;
  }
  assert.equal(err, "");
  assert.match(out, /^Ticket issuance listening on 127\.0\.0\.1:\d+\r?\n$/);
});

import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createVaultServer } from "../src/vault-server.mjs";
import { launchBrowser } from "./vault-browser.mjs";

let browser, server, base;
const prelude = `
const {openLocalVault} = await import('/local-vault.mjs');
const assert = (condition, label = 'Browser assertion failed') => { if (!condition) throw new Error(label); };
const rejects = async (action, code) => {
  let failed = false;
  try { await action(); } catch (error) { failed = error.message === code; }
  assert(failed, 'Expected safe rejection: ' + code);
};
const raw = async (action, version = 1) => {
  const db = await new Promise((done, reject) => {
    const request = indexedDB.open('darkpool-local-ticket-vault', version);
    request.onsuccess = () => done(request.result);
    request.onerror = () => reject(new Error('Synthetic raw open failed'));
  });
  try {
    return await new Promise((done, reject) => {
      const tx = db.transaction(['metadata','records'], 'readwrite');
      const result = action(tx);
      tx.oncomplete = () => done(result?.result);
      tx.onabort = () => reject(new Error('Synthetic raw write failed'));
    });
  } finally { db.close(); }
};
`;
const run = (body) =>
  browser.evaluate(`(async () => { ${prelude} ${body}; return true; })()`);

before(async () => {
  const assets = createVaultServer();
  // Test-only empty page permits local module tests without mounting the production UI.
  server = createServer((request, response) => {
    if (request.url === "/test") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      response.end(
        "<!doctype html><title>Isolated Phase 6 browser tests</title>",
      );
    } else assets.emit("request", request, response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
beforeEach(async () => {
  await browser.navigate(base + "/test");
  await browser.evaluate(`new Promise((done, reject) => {
    const request = indexedDB.deleteDatabase('darkpool-local-ticket-vault');
    request.onsuccess = () => done(true); request.onerror = () => reject(new Error('Synthetic reset failed'));
  })`);
});
after(async () => {
  await browser?.stop();
  if (server) await new Promise((done) => server.close(done));
});

test("U04: real browser CSPRNG, independent 32-byte records; no insecure randomness", async () => {
  assert.equal(
    await run(`
    const vault = await openLocalVault();
    const original = crypto.getRandomValues.bind(crypto), random = Math.random;
    let calls = 0;
    crypto.getRandomValues = (value) => { assert(value instanceof Uint8Array && value.length === 32); calls++; return original(value); };
    Math.random = () => { throw new Error('Insecure RNG used'); };
    try {
      const samples = new Set();
      for (let index = 0; index < 32; index++) {
        const id = await vault.createDraft(), credential = await vault.readCredential(id);
        assert(credential.claim_secret.length === 32);
        samples.add(Array.from(credential.claim_secret).join(','));
        credential.claim_secret.fill(0);
      }
      assert(calls === 32 && samples.size === 32);
      const records = await vault.list();
      assert(records.length === 32 && records.every(r => r.state === 'DRAFT' && Object.keys(r).length === 2));
    } finally { crypto.getRandomValues = original; Math.random = random; vault.close(); }
  `),
    true,
  );
});

test("U04/SEC03: RNG and storage failures redact diagnostics and do not save a credential", async () => {
  await run(`
    const vault = await openLocalVault(), original = crypto.getRandomValues.bind(crypto);
    const add = IDBObjectStore.prototype.add;
    try {
      crypto.getRandomValues = bytes => { bytes.fill(19); throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'); };
      await rejects(() => vault.createDraft(), 'LOCAL_DRAFT_NOT_SAVED');
      assert((await vault.list()).length === 0);
      crypto.getRandomValues = undefined;
      await rejects(() => vault.createDraft(), 'LOCAL_DRAFT_NOT_SAVED');
      crypto.getRandomValues = original;
      const kept = await vault.createDraft();
      IDBObjectStore.prototype.add = () => { throw new DOMException('SYNTHETIC_PRIVATE_DIAGNOSTIC', 'QuotaExceededError'); };
      await rejects(() => vault.createDraft(), 'LOCAL_DRAFT_NOT_SAVED');
      assert((await vault.list()).length === 1 && (await vault.list())[0].local_id === kept);
    } finally { IDBObjectStore.prototype.add = add; crypto.getRandomValues = original; vault.close(); }
  `);
});

test("Local browser storage capability failures fail closed", async () => {
  await run(`
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    try {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
      await rejects(openLocalVault, 'LOCAL_STORAGE_UNAVAILABLE');
    } finally { if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else delete globalThis.indexedDB; }
    const open = IDBFactory.prototype.open;
    try {
      IDBFactory.prototype.open = () => { throw new DOMException('SYNTHETIC_PRIVATE_DIAGNOSTIC','SecurityError'); };
      await rejects(openLocalVault,'LOCAL_STORAGE_UNAVAILABLE');
    } finally { IDBFactory.prototype.open = open; }
    const secure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
    try {
      Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
      await rejects(openLocalVault, 'LOCAL_STORAGE_UNAVAILABLE');
    } finally { if (secure) Object.defineProperty(globalThis, 'isSecureContext', secure); else delete globalThis.isSecureContext; }
  `);
});

test("V01/U05: browser finalization matches every independent approved V1 vector", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../test-vectors/claim-commitment-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await run(`
    const fixture = ${JSON.stringify(fixture)}, vault = await openLocalVault();
    try {
      assert(vault.commitmentProfile === fixture.profile_id);
      for (const vector of fixture.vectors) {
        const id = await vault.createDraft();
        await raw(tx => {
          const request = tx.objectStore('records').get(id);
          request.onsuccess = () => {
            const record = request.result;
            record.claim_secret = Uint8Array.from(vector.input.claim_secret_hex.match(/../g).map(byte => parseInt(byte, 16)));
            tx.objectStore('records').put(record);
          };
        });
        const context = { version:1, network:'testnet', market_id:vector.input.market_id, ticket_id:vector.input.ticket_id };
        assert(await vault.finalize(id, context) === vector.expected_digest_hex);
        assert(await vault.finalize(id, context) === vector.expected_digest_hex);
        const credential = await vault.readCredential(id);
        assert(credential.ticket_id === context.ticket_id && credential.market_id === context.market_id);
        assert(credential.claim_secret.length === 32 && !Object.hasOwn(credential, 'claim_commitment'));
        await vault.remove(id, () => true); // Same synthetic secret appears in all five vectors.
      }
    } finally { vault.close(); }
  `);
});

test("Independent local records: duplicate secrets/credentials, immutable final IDs and safe atomic update", async () => {
  await run(`
    const vault = await openLocalVault(), original = crypto.getRandomValues.bind(crypto);
    try {
      crypto.getRandomValues = bytes => { bytes.fill(37); return bytes; };
      const first = await vault.createDraft();
      await rejects(() => vault.createDraft(), 'LOCAL_DRAFT_NOT_SAVED');
      crypto.getRandomValues = original;
      const second = await vault.createDraft(), third = await vault.createDraft();
      const context = {version:1,network:'testnet',market_id:'m1',ticket_id:'server-synthetic'};
      const committed = await vault.finalize(first, context);
      await rejects(() => vault.finalize(second, context), 'DUPLICATE_LOCAL_RECORD');
      assert((await vault.list()).find(r => r.local_id === second).state === 'DRAFT');
      await rejects(() => vault.finalize(first, {...context,ticket_id:'changed'}), 'LOCAL_RECORD_IMMUTABLE');
      assert(await vault.finalize(first, context) === committed);
      for (const candidate of [{...context,version:2}, {...context,network:'mainnet'}, {...context,ticket_id:''}, {...context,market_id:'\ud800'}, {...context,side:'YES'}, {...context,requested_amount_zat:'1'}])
        await rejects(() => vault.finalize(third, candidate), 'INVALID_LOCAL_RECORD');
      assert((await vault.list()).length === 3);
      const credential = await vault.readCredential(first); credential.claim_secret.fill(0);
      assert((await vault.readCredential(first)).claim_secret.some(byte => byte !== 0));
      assert((await vault.list()).every(r => !Object.hasOwn(r,'claim_secret') && !Object.hasOwn(r,'user_id')));
    } finally { crypto.getRandomValues = original; vault.close(); }
  `);
});

test("Concurrent browser connections serialize additions and prevent duplicate finalization", async () => {
  await run(`
    const a = await openLocalVault(), b = await openLocalVault();
    try {
      const ids = await Promise.all(Array.from({length:12}, (_,i) => (i%2 ? a : b).createDraft()));
      assert(new Set(ids).size === 12 && (await a.list()).length === 12);
      const context = {version:1,network:'testnet',market_id:'m1',ticket_id:'synthetic-concurrent'};
      const outcomes = await Promise.allSettled([a.finalize(ids[0],context), b.finalize(ids[1],context)]);
      assert(outcomes.filter(r => r.status === 'fulfilled').length === 1);
      assert(outcomes.find(r => r.status === 'rejected').reason.message === 'DUPLICATE_LOCAL_RECORD');
      assert((await a.list()).length === 12);
    } finally { a.close(); b.close(); }
  `);
});

test("Secret-bearing draft and finalized deletion require confirmation; cancellation/errors preserve data", async () => {
  await run(`
    const vault = await openLocalVault();
    try {
      const draft = await vault.createDraft(), final = await vault.createDraft();
      await vault.finalize(final,{version:1,network:'testnet',market_id:'m1',ticket_id:'synthetic-final'});
      for (const id of [draft,final]) {
        await rejects(() => vault.remove(id), 'LOCAL_CONFIRMATION_REQUIRED');
        assert(await vault.remove(id, () => false) === false);
        assert(await vault.remove(id, () => 'true') === false);
        await rejects(() => vault.remove(id, () => { throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'); }), 'LOCAL_CONFIRMATION_FAILED');
        assert((await vault.list()).length === 2);
      }
      assert(await vault.remove(final, summary => { assert(!Object.hasOwn(summary,'claim_secret')); return true; }));
      assert((await vault.list()).length === 1 && (await vault.list())[0].local_id === draft);
      assert(await vault.remove(draft, () => true));
      assert((await vault.list()).length === 0);
    } finally { vault.close(); }
  `);
});

test("Deletion confirmation cannot delete a record changed while confirmation was pending", async () => {
  await run(`
    const vault = await openLocalVault();
    try {
      const id = await vault.createDraft();
      await rejects(() => vault.remove(id, async () => {
        await vault.finalize(id,{version:1,network:'testnet',market_id:'m1',ticket_id:'synthetic-changed'});
        return true;
      }), 'LOCAL_RECORD_CHANGED');
      assert((await vault.list())[0].state === 'FINALIZED');
    } finally { vault.close(); }
  `);
});

test("Corrupted records reject reads and writes without deleting or resetting existing records", async () => {
  await run(`
    const vault = await openLocalVault(), id = await vault.createDraft();
    const original = (await raw(tx => tx.objectStore('records').getAll()))[0];
    try {
      const variants = [ {...original,version:2}, {...original,network:'mainnet'}, {...original,state:'CONFIRMED'},
        {...original,claim_secret:new Uint8Array(31)}, {...original,claim_secret:new Uint8Array(33)},
        {...original,claim_secret:Array(32).fill(1)}, {...original,claim_secret:null}, {...original,user_id:'identity'},
        {...original,state:'FINALIZED',market_id:'m1',ticket_id:'t1',claim_commitment:'wrong'} ];
      for (const record of variants) {
        await raw(tx => tx.objectStore('records').put(record));
        await rejects(() => vault.list(),'INVALID_LOCAL_RECORD');
        await rejects(() => vault.createDraft(),'LOCAL_DRAFT_NOT_SAVED');
        let confirmationCalled = false;
        await rejects(() => vault.remove(id, () => { confirmationCalled = true; return true; }), 'INVALID_LOCAL_RECORD');
        assert(!confirmationCalled && (await raw(tx => tx.objectStore('records').count())) === 1);
        await rejects(openLocalVault, 'INVALID_LOCAL_RECORD');
      }
      await raw(tx => tx.objectStore('records').put(original));
      assert((await vault.list()).length === 1);
    } finally { vault.close(); }
  `);
});

test("Unsupported metadata and IndexedDB versions preserve data and close old connections safely", async () => {
  await run(`
    const vault = await openLocalVault(); await vault.createDraft();
    await raw(tx => tx.objectStore('metadata').put({schema_version:2},'schema'));
    await rejects(() => vault.list(),'UNSUPPORTED_VAULT_SCHEMA');
    await rejects(openLocalVault,'UNSUPPORTED_VAULT_SCHEMA');
    await raw(tx => {tx.objectStore('metadata').clear();tx.objectStore('metadata').put({schema_version:1},'wrong-key');});
    await rejects(openLocalVault,'UNSUPPORTED_VAULT_SCHEMA');
    await raw(tx => {tx.objectStore('metadata').clear();tx.objectStore('metadata').put({schema_version:1},'schema');tx.objectStore('metadata').put({schema_version:1},'extra');});
    await rejects(openLocalVault,'UNSUPPORTED_VAULT_SCHEMA');
    await raw(tx => tx.objectStore('metadata').delete('extra'));
    await raw(tx => tx.objectStore('metadata').put({schema_version:1},'schema'));
    const future = await new Promise((done,reject) => {
      const request = indexedDB.open('darkpool-local-ticket-vault',2);
      request.onsuccess = () => done(request.result); request.onerror = () => reject(new Error('Synthetic upgrade failed'));
    });
    future.close();
    await rejects(() => vault.list(),'LOCAL_STORAGE_UNAVAILABLE');
    await rejects(openLocalVault,'UNSUPPORTED_VAULT_VERSION');
    assert((await raw(tx => tx.objectStore('records').count(),2)) === 1);
  `);
});

test("Malformed actual storage schema fails safely without automatic recreation", async () => {
  await browser.evaluate(`new Promise(done => {
    const request = indexedDB.open('darkpool-local-ticket-vault',1);
    request.onupgradeneeded = () => request.result.createObjectStore('wrong');
    request.onsuccess = () => { request.result.close(); done(true); };
  })`);
  await run(`await rejects(openLocalVault,'UNSUPPORTED_VAULT_SCHEMA');`);
});

test("Malformed indexes and metadata keys fail safely through transaction validation", async () => {
  await browser.evaluate(`new Promise(done => {
    const request = indexedDB.open('darkpool-local-ticket-vault',1);
    request.onupgradeneeded = () => {
      const db=request.result;
      db.createObjectStore('metadata').add({schema_version:1},'schema');
      db.createObjectStore('records',{keyPath:'local_id',autoIncrement:true});
    };
    request.onsuccess = () => { request.result.close(); done(true); };
  })`);
  await run(`await rejects(openLocalVault,'UNSUPPORTED_VAULT_SCHEMA');`);
});

test("Queued/blocked storage open times out safely and preserves records until blocker is released", async () => {
  await run(`
    const vault=await openLocalVault(); await vault.createDraft(); vault.close();
    const held=await new Promise(done=>{const request=indexedDB.open('darkpool-local-ticket-vault',1);request.onsuccess=()=>done(request.result);});
    let removed;
    const deletion=new Promise(done=>{removed=done;});
    await new Promise(done=>{const request=indexedDB.deleteDatabase('darkpool-local-ticket-vault');request.onblocked=done;request.onsuccess=removed;});
    try {
      await rejects(openLocalVault,'LOCAL_STORAGE_BLOCKED');
      const count=await new Promise(done=>{const request=held.transaction('records').objectStore('records').count();request.onsuccess=()=>done(request.result);});
      assert(count===1);
    } finally {held.close();await deletion;}
  `);
});

test("Actual page reload persists draft/finalized credentials, without URL/HTTP/console secret disclosure", async () => {
  const firstEvent = browser.events.length;
  await run(`
    const vault = await openLocalVault();
    const id = await vault.createDraft(); await vault.createDraft();
    await raw(tx => {
      const request = tx.objectStore('records').get(id);
      request.onsuccess = () => { const record = request.result; record.claim_secret = Uint8Array.from({length:32},(_,i)=>i); tx.objectStore('records').put(record); };
    });
    assert(await vault.finalize(id,{version:1,network:'testnet',market_id:'m1',ticket_id:'t1'}) === '39fe1b1e0383976626942f13f1defe23504fb5c73cc2cc1c23894d70bfef1fa7');
    // Leave connection open: reload must close it and persistence must survive.
  `);
  await browser.navigate(base + "/test");
  await run(`
    const vault = await openLocalVault();
    try {
      const records = await vault.list(); assert(records.length === 2 && records.filter(r=>r.state==='DRAFT').length === 1);
      const final = records.find(r=>r.state==='FINALIZED'), credential = await vault.readCredential(final.local_id);
      assert(credential.claim_secret.every((byte,i)=>byte===i));
      assert(await vault.finalize(final.local_id,{version:1,network:'testnet',market_id:'m1',ticket_id:'t1'}) === '39fe1b1e0383976626942f13f1defe23504fb5c73cc2cc1c23894d70bfef1fa7');
      assert(location.href.endsWith('/test') && !location.search && !location.hash);
    } finally { vault.close(); }
  `);
  const events = browser.events.slice(firstEvent);
  const requests = events
    .filter((event) => event.method === "Network.requestWillBeSent")
    .map((event) => event.params.request);
  assert.ok(requests.length > 0);
  const allowed = new Set([
    "/test",
    "/local-vault.mjs",
    "/ticket-backup.mjs",
    "/secrets.js",
    "/claim-commitment.js",
    "/vendor/blake2.js",
    "/vendor/utils.js",
    "/vendor/_blake.js",
    "/vendor/_md.js",
    "/vendor/_u64.js",
  ]);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, base);
    assert.ok(allowed.has(url.pathname));
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.equal(request.method, "GET");
    assert.equal(request.postData, undefined);
    assert.doesNotMatch(
      JSON.stringify(request.headers),
      /claim_secret|ticket_id|claim_commitment|39fe1b1e/,
    );
  }
  assert.equal(
    events.filter((event) =>
      ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"].includes(
        event.method,
      ),
    ).length,
    0,
  );
});

test("Real vault UI: drafts, explicit deletion confirmation, safe text rendering and no secret/network output", async () => {
  const firstEvent = browser.events.length;
  await browser.navigate(base + "/");
  await browser.evaluate(`(async()=>{
    const wait = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await new Promise(done=>setTimeout(done,10));}throw new Error('UI timed out'); };
    const assert = value => {if(!value)throw new Error('UI assertion failed');};
    await wait(()=>!document.getElementById('create-draft').disabled);
    document.getElementById('create-draft').click();
    await wait(()=>document.querySelectorAll('#records li').length===1);
    document.getElementById('create-draft').click();
    await wait(()=>document.querySelectorAll('#records li').length===2);
    let confirmations = 0;
    globalThis.confirm = message => {confirmations++;assert(message.includes('Permanently delete') && message.includes('server cannot recover'));return false;};
    document.querySelector('#records button').click();
    await wait(()=>document.getElementById('message').textContent.includes('cancelled'));
    assert(document.querySelectorAll('#records li').length===2 && confirmations===1);
    globalThis.confirm = () => {confirmations++;return true;};
    document.querySelector('#records button').click();
    await wait(()=>document.querySelectorAll('#records li').length===1);
    assert(confirmations===2);
    const {openLocalVault}=await import('/local-vault.mjs'); const vault=await openLocalVault();
    const record=(await vault.list())[0];
    await vault.finalize(record.local_id,{version:1,network:'testnet',market_id:'<img src="https://attacker.invalid">',ticket_id:'synthetic-ui'});vault.close();
    // A further UI action reloads the local list using textContent only.
    document.getElementById('create-draft').click();
    await wait(()=>document.querySelectorAll('#records li').length===2);
    assert(!document.querySelector('#records img'));
    assert(document.querySelector('#records').textContent.includes('<img'));
    assert(!document.body.textContent.includes('claim_secret') && !document.body.textContent.includes('synthetic-ui'));
    assert(!location.search && !location.hash);
    return true;
  })()`);
  const requests = browser.events
    .slice(firstEvent)
    .filter((event) => event.method === "Network.requestWillBeSent")
    .map((event) => event.params.request);
  for (const request of requests) {
    assert.equal(new URL(request.url).origin, base);
    assert.equal(request.method, "GET");
    assert.equal(request.postData, undefined);
    assert.doesNotMatch(request.url, /\?|#|claim_secret|synthetic-ui|attacker/);
  }
  assert.equal(
    browser.events
      .slice(firstEvent)
      .filter((event) => event.method === "Runtime.consoleAPICalled").length,
    0,
  );
  await mkdir(
    new URL("../../../.tools/browser-screenshots-v1/", import.meta.url),
    {
      recursive: true,
    },
  );
  const screenshotDirectory = await mkdtemp(
    new URL(
      "../../../.tools/browser-screenshots-v1/phase6-vault-",
      import.meta.url,
    ),
  );
  for (const [label, width, height] of [
    ["desktop", 1280, 1200],
    ["narrow", 390, 1300],
  ]) {
    await browser.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await browser.evaluate(
        "document.documentElement.scrollWidth <= innerWidth",
      ),
      true,
    );
    const screenshot = await browser.call("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      join(screenshotDirectory, `${label}.png`),
      Buffer.from(screenshot.data, "base64"),
      { flag: "wx" },
    );
  }
});

import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createVaultServer } from "../src/vault-server.mjs";
import { createPublicServer } from "../src/public-server.mjs";
import { market } from "./public-fixtures.mjs";
import { launchBrowser } from "./vault-browser.mjs";

let browser, server, base;
const prelude = `
const {openLocalVault}=await import('/local-vault.mjs');
const {openIssuanceClient}=await import('/issuance-client.mjs');
const {encodeTicketBackup,decodeTicketBackup}=await import('/ticket-backup.mjs');
const assert=(v)=>{if(!v)throw new Error('Backup browser assertion failed');};
const rejects=async(action,code)=>{let error;try{await action();}catch(e){error=e;}assert(error?.message===code);};
const bytes=text=>new TextEncoder().encode(text);
const raw=async(action,name='darkpool-local-ticket-vault',stores=['metadata','records'])=>{
 const db=await new Promise((done,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>done(r.result);r.onerror=()=>reject(new Error('Synthetic storage failure'));});
 try{return await new Promise((done,reject)=>{const tx=db.transaction(stores,'readwrite'),r=action(tx);tx.oncomplete=()=>done(r?.result);tx.onabort=()=>reject(new Error('Synthetic write failure'));});}finally{db.close();}
};
// Synthetic ISSUED response exercises the real browser client/finalization gate.
// Actual PostgreSQL/Rust issuance remains covered by the unchanged Phase 7 suite.
const issueFixture=async(vault,id,ticket='ab'.repeat(32),mode='issued')=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(_url,options)=>{
  const request=JSON.parse(options.body);
  const response={issuance_profile_version:1,network:'testnet',market_id:'m-backup',ticket_id:ticket,status:request.operation==='reserve'?'RESERVED':'ISSUED',closes_at:'2030-01-01T00:00:00.000000Z'};
  if(request.operation==='complete'){
   if(mode==='pending')return {ok:false,json:async()=>({error:'ISSUANCE_UNAVAILABLE'})};
   response.receiving_ua='utest1qqqq';
  }
  return {ok:true,json:async()=>response};
 };
 const client=await openIssuanceClient(vault);
 try{return await client.issue(id,{market_id:'m-backup',side:'YES',requested_amount_zat:'1000'});}
 finally{client.close();globalThis.fetch=original;}
};
const seed=async(vault,ticket='ab'.repeat(32))=>{const id=await vault.createDraft();await issueFixture(vault,id,ticket);return id;};
`;
const run = (body) =>
  browser.evaluate(`(async()=>{${prelude}${body};return true;})()`);

before(async () => {
  const assets = createVaultServer();
  const client = await readFile(
    new URL("../dist/vault/issuance-client.mjs", import.meta.url),
  );
  server = createServer((req, res) => {
    if (req.url === "/test") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      res.end("<!doctype html><title>Isolated backup tests</title>");
    } else if (req.url === "/issuance-client.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(client);
    } else assets.emit("request", req, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
beforeEach(async () => {
  await browser.navigate(base + "/test");
  await browser.evaluate(
    `(async()=>{for(const name of ['darkpool-local-ticket-vault','darkpool-pending-issuance'])await new Promise((done,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=()=>done();r.onerror=()=>reject(new Error('Synthetic reset failed'));});return true;})()`,
  );
});
after(async () => {
  await browser?.stop();
  if (server) await new Promise((done) => server.close(done));
});

test("Backup exact schema and byte-for-byte round trip survive storage loss/reload; pending remains untouched", async () => {
  await run(`
   const vault=await openLocalVault(),rng=crypto.getRandomValues.bind(crypto);
   crypto.getRandomValues=b=>{b.set(Uint8Array.from({length:32},(_,i)=>i));return b;};
   const id=await vault.createDraft();crypto.getRandomValues=rng;
   await issueFixture(vault,id);const original=await vault.readCredential(id);
   const text=await vault.exportBackup(id),parsed=JSON.parse(text);
   assert(Object.keys(parsed).sort().join(',')==='backup_version,claim_commitment,claim_commitment_profile,claim_secret_hex,format,market_id,network,ticket_id,version');
   assert(parsed.claim_secret_hex===Array.from(original.claim_secret,b=>b.toString(16).padStart(2,'0')).join(''));
   const pendingBefore=JSON.stringify(await raw(tx=>tx.objectStore('attempts').getAll(),'darkpool-pending-issuance',['attempts']));
   globalThis.testBackup=text;globalThis.pendingBefore=pendingBefore;vault.close();
   await new Promise(done=>{const r=indexedDB.deleteDatabase('darkpool-local-ticket-vault');r.onsuccess=done;});
   const restored=await openLocalVault();assert(await restored.importBackup(bytes(text))==='RESTORED');
   assert(await restored.importBackup(bytes(text))==='ALREADY_STORED');
   const record=(await restored.list())[0],credential=await restored.readCredential(record.local_id);
   assert(credential.claim_secret.every((b,i)=>b===i));assert(credential.market_id===original.market_id&&credential.ticket_id===original.ticket_id);
   assert(await restored.exportBackup(record.local_id)===text);
   assert(JSON.stringify(await raw(tx=>tx.objectStore('attempts').getAll(),'darkpool-pending-issuance',['attempts']))===pendingBefore);
   restored.close();
  `);
  await browser.navigate(base + "/test");
  await run(
    `const v=await openLocalVault();try{const r=(await v.list())[0];assert(await v.canExport(r.local_id));assert((await v.readCredential(r.local_id)).claim_secret.every((b,i)=>b===i));}finally{v.close();}`,
  );
});

test("Only validated ISSUED plus committed local finalization enables export, including legacy retry", async () => {
  await run(`
   const v=await openLocalVault();try{
    const draft=await v.createDraft();await rejects(()=>v.exportBackup(draft),'TICKET_NOT_EXPORTABLE');
    await rejects(()=>issueFixture(v,draft,'ab'.repeat(32),'pending'),'ISSUANCE_NOT_FINALIZED');
    assert(!await v.canExport(draft));await rejects(()=>v.exportBackup(draft),'TICKET_NOT_EXPORTABLE');
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(record,...args){if(this.name==='records')throw new Error('PRIVATE_STORAGE_SENTINEL');return put.call(this,record,...args);};
    try{await rejects(()=>issueFixture(v,draft),'ISSUANCE_NOT_FINALIZED');}finally{IDBObjectStore.prototype.put=put;}
    assert((await v.list())[0].state==='DRAFT');await rejects(()=>v.exportBackup(draft),'TICKET_NOT_EXPORTABLE');
    IDBObjectStore.prototype.put=function(record,...args){if(this.name==='metadata'&&String(args[0]).startsWith('backup:'))throw new Error('PRIVATE_STORAGE_SENTINEL');return put.call(this,record,...args);};
    try{await rejects(()=>issueFixture(v,draft),'ISSUANCE_NOT_FINALIZED');}finally{IDBObjectStore.prototype.put=put;}
    assert((await v.list())[0].state==='FINALIZED');await rejects(()=>v.exportBackup(draft),'TICKET_NOT_EXPORTABLE');
    await issueFixture(v,draft);assert(await v.canExport(draft));
    const local=await v.createDraft();await v.finalize(local,{version:1,network:'testnet',market_id:'m-backup',ticket_id:'cd'.repeat(32)});
    assert(!await v.canExport(local));await rejects(()=>v.exportBackup(local),'TICKET_NOT_EXPORTABLE');
    await rejects(()=>v.recordIssued(local,{version:1,network:'testnet',market_id:'other',ticket_id:'cd'.repeat(32)}),'TICKET_NOT_EXPORTABLE');
   }finally{v.close();}
  `);
});

test("Strict primitive JSON parser rejects malformed, duplicate/escaped keys, nested data, invalid UTF-8 and oversize", async () => {
  await run(`
   const v=await openLocalVault();try{
    const id=await seed(v),text=await v.exportBackup(id),before=JSON.stringify(await raw(tx=>tx.objectStore('records').getAll()));
    const variants=['','null','[]','{}','true',text+'{}',text+',',text.replace('"backup_version": 1','"backup_version": 1,'),text.replace('"backup_version": 1','"backup_version": null'),text.replace('"backup_version": 1','"backup_version": {}'),text.replace('"backup_version": 1','"backup_version": 01'),text.replace('"format":','"format" '),text.replace('{','{"format":"darkpool-ticket-backup",'),text.replace('{','{"\\u0066ormat":"darkpool-ticket-backup",'),text.replace('{','{"other":{"x":1,"x":2},'),text.replace('{','{"__proto__":{},')];
    for(const input of variants)await rejects(()=>v.importBackup(bytes(input)),'INVALID_TICKET_BACKUP');
    for(const input of [new Uint8Array(65537),new Uint8Array([0xff]),new Uint8Array([0xc0,0xaf]),new Uint8Array([0xef,0xbb,0xbf,...bytes(text)])])await rejects(()=>v.importBackup(input),'INVALID_TICKET_BACKUP');
    assert(JSON.stringify(await raw(tx=>tx.objectStore('records').getAll()))===before);
    const exact=bytes(text+' '.repeat(65536-bytes(text).length));assert(await v.importBackup(exact)==='ALREADY_STORED');
    assert(await v.importBackup(bytes(' \\n'+JSON.stringify(JSON.parse(text),Object.keys(JSON.parse(text)).reverse())+'\\t'))==='ALREADY_STORED');
   }finally{v.close();}
  `);
});

test("Exact fields, compatibility, lowercase hex and existing market boundary; corruption never repaired", async () => {
  await run(`
   const v=await openLocalVault();try{
    const id=await seed(v),valid=JSON.parse(await v.exportBackup(id));
    for(const key of Object.keys(valid)){const changed={...valid};delete changed[key];await rejects(()=>v.importBackup(bytes(JSON.stringify(changed))),'INVALID_TICKET_BACKUP');}
    const mutations=[['extra',1],['issuance_token','cd'.repeat(32)],['local_id',1],['format','other'],['backup_version',2],['backup_version','1'],['version',2],['network','mainnet'],['claim_commitment_profile','other'],['market_id',''],['market_id','\\ud800'],['market_id','m\\0'],['market_id','a'.repeat(8193)],['ticket_id',valid.ticket_id.toUpperCase()],['ticket_id','00'],['claim_secret_hex','GG'.repeat(32)],['claim_secret_hex',valid.claim_secret_hex.toUpperCase()],['claim_secret_hex','0'.repeat(63)],['claim_secret_hex','0'.repeat(66)],['claim_commitment','00'.repeat(32)],['claim_commitment',valid.claim_commitment.toUpperCase()],['claim_secret_hex',' '+valid.claim_secret_hex]];
    for(const [key,value] of mutations)await rejects(()=>v.importBackup(bytes(JSON.stringify({...valid,[key]:value}))),'INVALID_TICKET_BACKUP');
    const c=await v.readCredential(id);
    for(const market of ['é','e\\u0301','a'.repeat(8192),'<img src="https://attacker.invalid">']){
      const payload=encodeTicketBackup({...c,market_id:market});const decoded=decodeTicketBackup(bytes(payload));assert(decoded.market_id===market);decoded.claim_secret.fill(0);
    }
    const unicode=JSON.parse(encodeTicketBackup({...c,market_id:'é'}));unicode.market_id='e\\u0301';await rejects(()=>v.importBackup(bytes(JSON.stringify(unicode))),'INVALID_TICKET_BACKUP');
    c.claim_secret.fill(0);assert((await v.list()).length===1);
   }finally{v.close();}
  `);
});

test("Duplicate imports are idempotent; identity, reused secret and draft conflicts preserve all data", async () => {
  await run(`
   const v=await openLocalVault();try{
    const id=await seed(v),text=await v.exportBackup(id),c=await v.readCredential(id),before=JSON.stringify(await raw(tx=>tx.objectStore('records').getAll()));
    assert(await v.importBackup(bytes(text))==='ALREADY_STORED');
    await rejects(()=>v.importBackup(bytes(encodeTicketBackup({...c,claim_secret:new Uint8Array(32)}))),'TICKET_BACKUP_CONFLICT');
    await rejects(()=>v.importBackup(bytes(encodeTicketBackup({...c,ticket_id:'cd'.repeat(32)}))),'TICKET_BACKUP_CONFLICT');
    assert(JSON.stringify(await raw(tx=>tx.objectStore('records').getAll()))===before);
    const draft=await v.createDraft(),d=await v.readCredential(draft);
    await rejects(()=>v.importBackup(bytes(encodeTicketBackup({...d,market_id:'m-backup',ticket_id:'ef'.repeat(32)}))),'TICKET_BACKUP_CONFLICT');
    const independent=encodeTicketBackup({...c,ticket_id:'12'.repeat(32),claim_secret:Uint8Array.from({length:32},(_,i)=>i)});
    assert(await v.importBackup(bytes(independent))==='RESTORED');assert((await v.list()).length===3);
    const stored=(await v.list()).find(r=>r.ticket_id==='12'.repeat(32));assert(stored.local_id!==id&&stored.local_id!==draft);
    c.claim_secret.fill(0);d.claim_secret.fill(0);
   }finally{v.close();}
  `);
});

test("Concurrent connections converge atomically; late write/transaction failure rolls back credential and marker", async () => {
  await run(`
   const a=await openLocalVault(),b=await openLocalVault();try{
    const fixture={version:1,network:'testnet',market_id:'m-backup',ticket_id:'ab'.repeat(32),claim_secret:Uint8Array.from({length:32},(_,i)=>i)};
    const input=bytes(encodeTicketBackup(fixture)),results=await Promise.all([a.importBackup(input),b.importBackup(input)]);
    assert(results.includes('RESTORED')&&results.includes('ALREADY_STORED'));assert((await a.list()).length===1);
    const conflict=bytes(encodeTicketBackup({...fixture,claim_secret:new Uint8Array(32)}));
    await rejects(()=>b.importBackup(conflict),'TICKET_BACKUP_CONFLICT');
    const before=JSON.stringify(await raw(tx=>tx.objectStore('records').getAll())),metadata=JSON.stringify(await raw(tx=>tx.objectStore('metadata').getAll()));
    const next=bytes(encodeTicketBackup({...fixture,ticket_id:'cd'.repeat(32),claim_secret:new Uint8Array(32)}));
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='metadata')throw new DOMException('PRIVATE_STORAGE_SENTINEL','QuotaExceededError');return put.apply(this,args);};
    try{await rejects(()=>a.importBackup(next),'LOCAL_STORAGE_FAILED');}finally{IDBObjectStore.prototype.put=put;}
    assert(JSON.stringify(await raw(tx=>tx.objectStore('records').getAll()))===before);assert(JSON.stringify(await raw(tx=>tx.objectStore('metadata').getAll()))===metadata);
    const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args){const r=add.apply(this,args);if(this.name==='records'){const tx=this.transaction;r.addEventListener('success',()=>tx.abort());}return r;};
    try{await rejects(()=>a.importBackup(next),'LOCAL_STORAGE_FAILED');}finally{IDBObjectStore.prototype.add=add;}
    assert(JSON.stringify(await raw(tx=>tx.objectStore('records').getAll()))===before);
    assert(await a.importBackup(next)==='RESTORED');const local=(await a.list()).find(r=>r.ticket_id==='cd'.repeat(32)).local_id;
    assert(await a.remove(local,()=>true));assert((await raw(tx=>tx.objectStore('metadata').getAllKeys())).length===2);
   }finally{a.close();b.close();}
  `);
});

test("Corrupt receipts/records and unsupported metadata reject import/export without resetting data", async () => {
  await run(`
   const v=await openLocalVault();try{
    const id=await seed(v),input=bytes(await v.exportBackup(id));
    const saved=(await raw(tx=>tx.objectStore('metadata').getAll())).find(r=>r.backup_version);
    await raw(tx=>tx.objectStore('metadata').put({...saved,ticket_id:'cd'.repeat(32)},'backup:'+id));
    await rejects(()=>v.exportBackup(id),'UNSUPPORTED_VAULT_SCHEMA');await rejects(()=>v.importBackup(input),'UNSUPPORTED_VAULT_SCHEMA');await rejects(openLocalVault,'UNSUPPORTED_VAULT_SCHEMA');
    assert((await raw(tx=>tx.objectStore('records').count()))===1);
    await raw(tx=>tx.objectStore('metadata').put(saved,'backup:'+id));
    const record=(await raw(tx=>tx.objectStore('records').getAll()))[0];await raw(tx=>tx.objectStore('records').put({...record,claim_secret:new Uint8Array(31)}));
    await rejects(()=>v.importBackup(input),'INVALID_LOCAL_RECORD');assert((await raw(tx=>tx.objectStore('records').count()))===1);
    await raw(tx=>tx.objectStore('records').put(record));await raw(tx=>tx.objectStore('metadata').put({schema_version:2},'schema'));
    await rejects(()=>v.importBackup(input),'UNSUPPORTED_VAULT_SCHEMA');assert((await raw(tx=>tx.objectStore('records').count()))===1);
   }finally{v.close();}
  `);
});

test("Actual UI requires export confirmation, generic filename, local restore semantics and no network/secret output", async () => {
  await run(
    `const v=await openLocalVault();try{const id=await seed(v);globalThis.testBackup=await v.exportBackup(id);}finally{v.close();}`,
  );
  await browser.navigate(base + "/backup");
  const eventStart = browser.events.length;
  await browser.evaluate(`(async()=>{
    let stage=0;
    const wait=async f=>{stage++;for(let i=0;i<300;i++){if(f())return;await new Promise(done=>setTimeout(done,10));}throw new Error('Backup UI timed out at stage '+stage);};
    const assert=v=>{if(!v)throw new Error('Backup UI assertion failed');};
    await wait(()=>!document.getElementById('restore').disabled);
    const {openLocalVault}=await import('/local-vault.mjs');const v=await openLocalVault(),r=(await v.list())[0];
    const text=await v.exportBackup(r.local_id);globalThis.uiBackup=text;
    const click=HTMLAnchorElement.prototype.click,create=URL.createObjectURL,revoke=URL.revokeObjectURL;
    let downloads=0,warnings=0,revoked=0,blob;
    HTMLAnchorElement.prototype.click=function(){downloads++;assert(this.download==='darkpool-ticket-backup.json');assert(this.href==='blob:synthetic-backup');assert(!this.hasAttribute('data-secret'));};
    URL.createObjectURL=b=>{blob=b;return 'blob:synthetic-backup';};URL.revokeObjectURL=()=>revoked++;
    try{
      globalThis.confirm=warning=>{warnings++;assert(warning.includes('unencrypted')&&warning.includes('does not revoke'));return false;};
      document.querySelector('#backup-records button').click();await wait(()=>document.getElementById('backup-message').textContent.includes('cancelled'));assert(downloads===0);
      await wait(()=>!document.querySelector('#backup-records button').disabled);
      globalThis.confirm=()=>true;document.querySelector('#backup-records button').click();await wait(()=>downloads===1);assert(await blob.text()===text);
      await wait(()=>revoked===1);assert(warnings===1&&!document.querySelector('a[download]'));
    }finally{HTMLAnchorElement.prototype.click=click;URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
    await v.remove(r.local_id,()=>true);v.close();
    const selected=new DataTransfer();selected.items.add(new File([text],'private-name.json',{type:'application/json'}));document.getElementById('backup-file').files=selected.files;
    document.getElementById('restore').click();await wait(()=>document.getElementById('backup-message').textContent==='Credential restored. Server status has not been checked.');
    await wait(()=>!document.getElementById('restore').disabled);
    const again=new DataTransfer();again.items.add(new File([text],'other.json'));document.getElementById('backup-file').files=again.files;
    document.getElementById('restore').click();await wait(()=>document.getElementById('backup-message').textContent==='Already stored. Server status has not been checked.');
    await wait(()=>!document.getElementById('restore').disabled);
    const oversize=new DataTransfer();oversize.items.add(new File([new Uint8Array(65537)],'big.json'));document.getElementById('backup-file').files=oversize.files;
    document.getElementById('restore').click();await wait(()=>document.getElementById('backup-message').textContent.includes('too large'));
    const parsed=JSON.parse(text);assert(!document.body.textContent.includes(parsed.claim_secret_hex)&&!document.documentElement.outerHTML.includes(parsed.ticket_id));
    assert(!location.search&&!location.hash);return true;
  })()`);
  const events = browser.events.slice(eventStart);
  assert.equal(
    events.filter((e) => e.method === "Network.requestWillBeSent").length,
    0,
  );
  assert.equal(
    events.filter((e) =>
      ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"].includes(
        e.method,
      ),
    ).length,
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
      "../../../.tools/browser-screenshots-v1/ticket-backup-",
      import.meta.url,
    ),
  );
  for (const [label, width, height] of [
    ["desktop", 1280, 1400],
    ["narrow", 390, 1400],
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

test("Backup modules have no exfiltration path; public APIs expose no backup or private credential", async () => {
  for (const name of [
    "ticket-backup.mjs",
    "backup-ui.mjs",
    "local-vault.mjs",
  ]) {
    const source = await readFile(
      new URL(`../src/${name}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|console\.|clipboard|innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage/,
    );
  }
  const ui = await readFile(
    new URL("../src/backup-ui.mjs", import.meta.url),
    "utf8",
  );
  assert.match(ui, /link\.download = "darkpool-ticket-backup\.json"/);
  assert.doesNotMatch(ui, /encodeURIComponent|searchParams|qr|btoa|atob/);
  const response = await fetch(base + "/backup");
  assert.match(
    response.headers.get("content-security-policy"),
    /connect-src 'none'/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const publicServer = createPublicServer({ readMarket: async () => [market] });
  await new Promise((done) => publicServer.listen(0, "127.0.0.1", done));
  const publicBase = `http://127.0.0.1:${publicServer.address().port}`;
  try {
    assert.deepEqual(await (await fetch(publicBase + "/api/market")).json(), {
      market,
    });
    for (const path of [
      "/backup",
      "/backup-ui.mjs",
      "/ticket-backup.mjs",
      "/api/import",
      "/api/export",
    ])
      assert.equal((await fetch(publicBase + path)).status, 404);
  } finally {
    await new Promise((done) => publicServer.close(done));
  }
});

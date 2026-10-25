import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  formatZatoshi,
  parseZecToZatoshi,
} from "../../../packages/protocol/dist/money.js";
import {
  formatPaymentRequest,
  parsePaymentRequest,
} from "../src/payment-request.mjs";
import { createIssuanceServer } from "../src/issuance-server.mjs";
import { createPublicServer } from "../src/public-server.mjs";
import { createVaultServer } from "../src/vault-server.mjs";
import { market } from "./public-fixtures.mjs";
import { launchBrowser } from "./vault-browser.mjs";

let ua,
  browser,
  server,
  base,
  failFormat = false,
  formatted = 0,
  completed = 0;
const attempts = new Map();
const formatterInputs = [];
const extension = process.platform === "win32" ? ".exe" : "";
const executable = resolve(`target/debug/darkpool-zcash${extension}`);
const seed = `
const {openLocalVault}=await import('/local-vault.mjs');
const {openIssuanceClient}=await import('/issuance-client.mjs');
const {preparePaymentRequest,paymentContext,createPaymentPanel}=await import('/payment-ui.mjs');
const assert=v=>{if(!v)throw new Error('Phase 8 browser assertion failed');};
const v=await openLocalVault(),c=await openIssuanceClient(v);
try {
const id=await v.createDraft(),original=await v.readCredential(id);
const result=await c.issue(id,{market_id:'synthetic-phase8',side:'NO',requested_amount_zat:'1000001'});
`;
const runSeed = (body) =>
  browser.evaluate(
    `(async()=>{${seed}${body};return true;}finally{c.close();v.close();}})()`,
  );

before(async () => {
  ua = execFileSync(
    resolve(`target/debug/examples/payment-request-fixture${extension}`),
    [],
    {
      env: { ...process.env, DARKPOOL_SYNTHETIC_TEST: "1" },
      windowsHide: true,
      encoding: "utf8",
    },
  ).trim();
  const assets = createIssuanceServer({
    issue: async (r) => {
      let a = attempts.get(r.issuance_token);
      if (r.operation === "reserve") {
        if (!a) {
          a = {
            market_id: r.market_id,
            side: r.side,
            requested_amount_zat: r.requested_amount_zat,
            ticket_id: randomBytes(32).toString("hex"),
            issued: false,
          };
          attempts.set(r.issuance_token, a);
        }
        if (
          a.market_id !== r.market_id ||
          a.side !== r.side ||
          a.requested_amount_zat !== r.requested_amount_zat
        )
          throw new Error("ISSUANCE_CONFLICT");
      } else {
        if (!a || a.ticket_id !== r.ticket_id)
          throw new Error("ISSUANCE_CONFLICT");
        if (!a.issued) {
          a.issued = true;
          completed++;
        }
      }
      return {
        issuance_profile_version: 1,
        network: "testnet",
        market_id: a.market_id,
        ticket_id: a.ticket_id,
        status: r.operation === "reserve" ? "RESERVED" : "ISSUED",
        closes_at: "2030-01-01T00:00:00.123456Z",
        ...(r.operation === "complete" ? { receiving_ua: ua } : {}),
      };
    },
    preparePayment: async (value) => {
      formatted++;
      formatterInputs.push(value);
      if (failFormat)
        throw new Error("Synthetic secret-bearing diagnostic must not escape");
      return formatPaymentRequest(value);
    },
  });
  server = createServer((req, res) => {
    if (req.url === "/test") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      res.end(
        '<!doctype html><title>Isolated Phase 8 tests</title><section id="payment" hidden></section>',
      );
    } else assets.emit("request", req, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
beforeEach(async () => {
  failFormat = false;
  await browser.navigate(base + "/test");
  await browser.evaluate(
    `(async()=>{for(const name of ['darkpool-local-ticket-vault','darkpool-pending-issuance'])await new Promise((done,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=done;r.onerror=()=>reject(new Error('Synthetic reset failed'));});})()`,
  );
});
after(async () => {
  await browser?.stop();
  if (server) await new Promise((done) => server.close(done));
});

test("Integer conversion boundaries, literal canonical ZIP-321 and exact UA round trips", async () => {
  for (const [zat, decimal] of [
    ["1", "0.00000001"],
    ["10", "0.0000001"],
    ["100000", "0.001"],
    ["1000000", "0.01"],
    ["99999999", "0.99999999"],
    ["100000000", "1"],
    ["100000001", "1.00000001"],
    ["2099999999999999", "20999999.99999999"],
    ["2100000000000000", "21000000"],
  ]) {
    const result = await formatPaymentRequest({
      receiving_ua: ua,
      requested_amount_zat: zat,
    });
    assert.deepEqual(Object.keys(result).sort(), [
      "network",
      "payment_request_profile_version",
      "payment_uri",
    ]);
    assert.equal(result.payment_uri, `zcash:${ua}?amount=${decimal}`);
    assert.equal(
      parseZecToZatoshi(decimal, { min: 1n, max: 2100000000000000n }),
      BigInt(zat),
    );
    assert.equal(
      parseZecToZatoshi(formatZatoshi(BigInt(zat)), {
        min: 1n,
        max: 2100000000000000n,
      }),
      BigInt(zat),
    );
  }
  const bounds = { min: 1000n, max: 2000n };
  for (const [decimal, zat] of [
    ["0.00001", 1000n],
    ["0.00002", 2000n],
  ])
    assert.equal(parseZecToZatoshi(decimal, bounds), zat);
  for (const bad of [
    "0.00000999",
    "0.00002001",
    "0",
    "-1",
    "1e-8",
    "1.000000000",
    "1,000",
    ".5",
    "1.",
    "NaN",
    "Infinity",
  ])
    assert.throws(() => parseZecToZatoshi(bad, bounds));
});

test("Private input allowlist rejects credentials, malformed amounts and malformed destinations", async () => {
  const input = { receiving_ua: ua, requested_amount_zat: "1" };
  for (const key of [
    "side",
    "ticket_id",
    "market_id",
    "claim_secret",
    "issuance_token",
    "claim_commitment",
    "identity",
    "memo",
  ])
    assert.throws(() => parsePaymentRequest({ ...input, [key]: "synthetic" }), {
      message: "INVALID_REQUEST",
    });
  for (const amount of [
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e8",
    " 1",
    "1 ",
    "2100000000000001",
    "9007199254740993",
  ])
    assert.throws(() =>
      parsePaymentRequest({ ...input, requested_amount_zat: amount }),
    );
  await assert.rejects(
    formatPaymentRequest({ ...input, receiving_ua: "utest1qqqq" }),
    { message: "PAYMENT_REQUEST_UNAVAILABLE" },
  );
  assert.throws(() =>
    parsePaymentRequest({
      ...input,
      receiving_ua: "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
    }),
  );
});

test("Rust process uses only bounded pipes, no wallet/config authority, and no diagnostic leakage", () => {
  const frame = (fields) =>
    Buffer.concat(
      fields.map((f) => {
        const b = Buffer.from(f),
          s = Buffer.alloc(4);
        s.writeUInt32BE(b.length);
        return Buffer.concat([s, b]);
      }),
    );
  const good = spawnSync(executable, ["format-payment-request"], {
    input: frame([ua, "1"]),
    env: { ZCASH_NETWORK: "testnet" },
    windowsHide: true,
  });
  assert.equal(good.status, 0);
  assert.equal(good.stderr.length, 0);
  assert.equal(
    good.stdout.subarray(4).toString(),
    `zcash:${ua}?amount=0.00000001`,
  );
  for (const input of [
    frame(["utest1qqqq", "1"]),
    frame([ua, "0"]),
    frame([ua, "1", "secret"]),
    Buffer.from([0, 0, 0, 1, 255]),
  ]) {
    const bad = spawnSync(executable, ["format-payment-request"], {
      input,
      env: { ZCASH_NETWORK: "testnet" },
      windowsHide: true,
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout.length, 0);
    assert.equal(bad.stderr.length, 0);
  }
});

test("HTTP payment surface preserves privacy/origin guards and sanitizes errors", async () => {
  const post = (body, extra = {}) =>
    fetch(base + "/api/payment-request", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  const input = { receiving_ua: ua, requested_amount_zat: "1000000" };
  const result = await post(input);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await result.json()).payment_uri, `zcash:${ua}?amount=0.01`);
  assert.equal(
    (await post(input, { Origin: "https://other.invalid" })).status,
    403,
  );
  assert.equal((await fetch(base + "/api/payment-request")).status, 405);
  assert.equal(
    (await fetch(base + "/api/payment-request?secret=x")).status,
    400,
  );
  assert.equal((await post({ ...input, side: "NO" })).status, 400);
  assert.equal(
    (await post({ receiving_ua: "utest1qqqq", requested_amount_zat: "1" }))
      .status,
    503,
  );
  failFormat = true;
  assert.deepEqual(await (await post(input)).json(), {
    error: "ISSUANCE_UNAVAILABLE",
  });
});

test("Only durable issuance exposes payment context; preparation failure/retry retains original credential", async () => {
  const start = completed;
  await runSeed(`
    assert(result.payment.receiving_ua===${JSON.stringify(ua)});
    assert(result.payment.requested_amount_zat==='1000001');
    assert(await v.canExport(id));
    const fetchOriginal=globalThis.fetch;
    globalThis.fetch=async()=>{throw new Error('synthetic transport failure');};
    let failed=false;try{await preparePaymentRequest(result.payment);}catch(e){failed=e.message==='PAYMENT_REQUEST_UNAVAILABLE';}
    globalThis.fetch=fetchOriginal;assert(failed);
    assert((await v.readCredential(id)).claim_secret.every((b,i)=>b===original.claim_secret[i]));
    const ready=await preparePaymentRequest(result.payment);assert(ready.uri==='zcash:'+result.payment.receiving_ua+'?amount=0.01000001');
    const backup=JSON.parse(await v.exportBackup(id));
    assert(!Object.hasOwn(backup,'receiving_ua')&&!Object.hasOwn(backup,'requested_amount_zat')&&!Object.hasOwn(backup,'payment_uri'));
    globalThis.savedPhase8={id,payment:result.payment};
  `);
  assert.equal(completed, start + 1);
  assert.deepEqual(Object.keys(formatterInputs.at(-1)).sort(), [
    "receiving_ua",
    "requested_amount_zat",
  ]);
});

test("Failed completion-marker write exposes no payment context; same-attempt recovery uses original identity", async () => {
  await browser.evaluate(`(async()=>{
    const {openLocalVault}=await import('/local-vault.mjs'),{openIssuanceClient}=await import('/issuance-client.mjs');
    const v=await openLocalVault(),c=await openIssuanceClient(v),id=await v.createDraft();
    const put=IDBObjectStore.prototype.put;
    try {
      IDBObjectStore.prototype.put=function(record,key){if(this.name==='metadata'&&String(key).startsWith('backup:'))throw new Error('synthetic marker failure');return put.call(this,record,key);};
      let failed=false;try{await c.issue(id,{market_id:'synthetic-phase8',side:'YES',requested_amount_zat:'1'});}catch{failed=true;}
      IDBObjectStore.prototype.put=put;
      if(!failed||await v.canExport(id))throw new Error('Marker gate failed');
      const identity=(await v.readCredential(id)).ticket_id,recovered=await c.issue(id);
      if(recovered.ticket_id!==identity||recovered.payment.requested_amount_zat!=='1')throw new Error('Recovery failed');
    } finally {IDBObjectStore.prototype.put=put;c.close();v.close();}
  })()`);
});

test("Recovery revalidates immutable selection before presentation, including changed local amount/side", async () => {
  await runSeed(`
    const recovered=await c.issue(id);assert(recovered.ticket_id===result.ticket_id&&recovered.payment.receiving_ua===result.payment.receiving_ua);
    const db=await new Promise(done=>{const r=indexedDB.open('darkpool-pending-issuance');r.onsuccess=()=>done(r.result);});
    for(const changed of [{requested_amount_zat:'1000002'},{side:'YES'},{market_id:'different'}]){
      await new Promise((done,reject)=>{const tx=db.transaction('attempts','readwrite'),s=tx.objectStore('attempts'),r=s.get(id);r.onsuccess=()=>s.put({...r.result,...changed});tx.oncomplete=done;tx.onabort=()=>reject(new Error('Synthetic write failed'));});
      let failed=false;try{await c.issue(id);}catch(e){failed=e.message==='ISSUANCE_CONFLICT';}assert(failed);
      await new Promise(done=>{const tx=db.transaction('attempts','readwrite'),s=tx.objectStore('attempts'),r=s.get(id);r.onsuccess=()=>s.put({...r.result,market_id:'synthetic-phase8',side:'NO',requested_amount_zat:'1000001'});tx.oncomplete=done;});
    }
    db.close();
  `);
});

test("Selection changes during the reservation round trip fail before completion or payment context", async () => {
  const issuedBefore = completed;
  await browser.evaluate(`(async()=>{
    const {openLocalVault}=await import('/local-vault.mjs'),{openIssuanceClient}=await import('/issuance-client.mjs');
    const v=await openLocalVault(),c=await openIssuanceClient(v),originalFetch=globalThis.fetch;
    try {
      for(const changed of [{requested_amount_zat:'2'},{side:'YES'},{market_id:'different'},{secret_tag:'ef'.repeat(32)}]){
        const id=await v.createDraft(),before=await v.readCredential(id);
        globalThis.fetch=async(url,options)=>{
          const response=await originalFetch(url,options);
          if(url==='/api/issuance'&&JSON.parse(options.body).operation==='reserve'){
            const db=await new Promise(done=>{const r=indexedDB.open('darkpool-pending-issuance');r.onsuccess=()=>done(r.result);});
            try{await new Promise((done,reject)=>{const tx=db.transaction('attempts','readwrite'),s=tx.objectStore('attempts'),r=s.get(id);r.onsuccess=()=>s.put({...r.result,...changed});tx.oncomplete=done;tx.onabort=()=>reject(new Error('Synthetic write failed'));});}finally{db.close();}
          }
          return response;
        };
        let failed=false;try{await c.issue(id,{market_id:'synthetic-phase8',side:'NO',requested_amount_zat:'1'});}catch(e){failed=e.message==='ISSUANCE_NOT_FINALIZED';}
        const after=await v.readCredential(id);
        if(!failed||after.ticket_id||await v.canExport(id)||!after.claim_secret.every((b,i)=>b===before.claim_secret[i]))throw new Error('Reservation race failed');
      }
    }finally{globalThis.fetch=originalFetch;c.close();v.close();}
  })()`);
  assert.equal(completed, issuedBefore);
});

test("Imported backup and generic finalized binding do not fabricate payment context or issue requests", async () => {
  await runSeed(`
    const backup=await v.exportBackup(id);await v.remove(id,()=>true);
    await new Promise(done=>{const r=indexedDB.deleteDatabase('unused-synthetic-db');r.onsuccess=done;});
    await v.importBackup(new TextEncoder().encode(backup));const restored=(await v.list())[0];
    // Imported record has a new local key and no matching pending attempt.
    const originalFetch=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('No request expected');};
    try{
      let failed=false;try{await c.issue(restored.local_id);}catch{failed=true;}assert(failed&&requests===0);
      const generic=await v.createDraft();await v.finalize(generic,{version:1,network:'testnet',market_id:'generic',ticket_id:'ef'.repeat(32)});
      failed=false;try{await c.issue(generic);}catch{failed=true;}assert(failed&&requests===0);
    }finally{globalThis.fetch=originalFetch;}
  `);
});

test("Clipboard writes exact request after gesture, awaits success and leaves selectable text on failure", async () => {
  await runSeed(`
    const ready=await preparePaymentRequest(result.payment),panel=createPaymentPanel(document.getElementById('payment'));
    const originalClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
    let resolveCopy,writes=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:s=>{writes.push(s);return new Promise(done=>{resolveCopy=done;});}}});
    try{
      panel.show(ready);assert(writes.length===0);
      document.querySelector('#payment button').click();assert(writes.length===1&&writes[0]===ready.uri);
      assert(!document.getElementById('payment').textContent.includes('Payment request copied.'));
      resolveCopy();await new Promise(done=>setTimeout(done,0));assert(document.getElementById('payment').textContent.includes('Payment request copied.'));
      navigator.clipboard.writeText=async()=>{throw new Error('synthetic clipboard diagnostic');};
      document.querySelector('#payment button').click();await new Promise(done=>setTimeout(done,0));
      assert(document.getElementById('payment').textContent.includes('Clipboard unavailable.'));
      assert(document.querySelector('.payment-request').textContent===ready.uri);
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
      document.querySelector('#payment button').click();await new Promise(done=>setTimeout(done,0));
      assert(document.querySelector('.payment-request').textContent===ready.uri);
    }finally{panel.clear();if(originalClipboard)Object.defineProperty(navigator,'clipboard',originalClipboard);else delete navigator.clipboard;}
  `);
});

test("Browser close equality/crossing withholds payment text and controls without economic classification", async () => {
  await runSeed(`
    const ready=await preparePaymentRequest(result.payment),panel=createPaymentPanel(document.getElementById('payment')),clock=Date.now;
    try {
      assert(ready.close_time_ms===Date.parse('2030-01-01T00:00:00.123Z')+1);
      assert(paymentContext({...result.payment,closes_at:'2030-01-01T00:00:00.123000Z'}).close_time_ms===Date.parse('2030-01-01T00:00:00.123Z'));
      Date.now=()=>ready.close_time_ms-1;panel.show(ready);assert(document.querySelector('#payment button'));
      Date.now=()=>ready.close_time_ms;document.querySelector('#payment button').click();
      assert(!document.querySelector('#payment button')&&!document.querySelector('.payment-request'));
      assert(document.getElementById('payment').textContent.includes('closing time has passed'));
      panel.show(ready);assert(!document.querySelector('#payment button'));
      Date.now=()=>ready.close_time_ms-1;panel.show(ready);
      Date.now=()=>ready.close_time_ms+1;await new Promise(done=>setTimeout(done,300));assert(!document.querySelector('#payment button'));
      assert(!/LATE|INVALID|EXPIRED/.test(document.getElementById('payment').textContent));
    }finally{Date.now=clock;panel.clear();}
  `);
});

test("Actual issuance UI displays only payment data, clears side fields and preserves navigation/privacy", async () => {
  await runSeed(`globalThis.phase8LocalId=id;`);
  const start = browser.events.length;
  await browser.navigate(base + "/");
  await browser.evaluate(`(async()=>{
    for(let n=0;n<100&&!document.querySelector('#records button');n++)await new Promise(done=>setTimeout(done,20));
    document.querySelector('#records button').click();
    for(let n=0;n<200&&!document.querySelector('.payment-request');n++)await new Promise(done=>setTimeout(done,20));
    if(!document.querySelector('.payment-request'))throw new Error('Payment UI unavailable');
    const {openLocalVault}=await import('/local-vault.mjs'),v=await openLocalVault();
    try{
      const record=(await v.list())[0],credential=await v.readCredential(record.local_id),html=document.getElementById('payment').outerHTML;
      const secret=Array.from(credential.claim_secret,b=>b.toString(16).padStart(2,'0')).join('');
      const {deriveClaimCommitment}=await import('/claim-commitment.js');
      const commitment=deriveClaimCommitment({version:1,market_id:record.market_id,ticket_id:record.ticket_id,claim_secret:credential.claim_secret});
      const db=await new Promise(done=>{const r=indexedDB.open('darkpool-pending-issuance');r.onsuccess=()=>done(r.result);});
      const pending=await new Promise(done=>{const r=db.transaction('attempts').objectStore('attempts').get(record.local_id);r.onsuccess=()=>done(r.result);});db.close();
      if([record.ticket_id,secret,commitment,pending.issuance_token].some(value=>html.includes(value))||/issuance_token|claim_commitment|side|hidden.*value/.test(html))throw new Error('Private payment DOM leak');
      if(document.getElementById('side').value!==''||!document.getElementById('selection').hidden)throw new Error('Side field retained');
      if(location.href!==${JSON.stringify(base + "/")})throw new Error('Navigation changed');
      if(document.querySelector('#payment a[href]')||document.querySelector('#payment input')||document.querySelector('#payment textarea'))throw new Error('Payment field/navigation leak');
      const text=document.getElementById('payment').textContent;
      if(!text.includes('payment status not checked')||!text.includes('Awaiting payment verification')||/\b(paid|accepted|confirmed|funded)\b/i.test(text))throw new Error('Payment state wording failed');
    }finally{v.close();}
  })()`);
  const events = browser.events.slice(start),
    requests = events
      .filter((e) => e.method === "Network.requestWillBeSent")
      .map((e) => e.params.request);
  for (const r of requests) {
    assert.ok(r.url.startsWith(base + "/"));
    assert.equal(new URL(r.url).search, "");
    assert.equal(new URL(r.url).hash, "");
  }
  const payments = requests.filter(
    (r) => r.url === base + "/api/payment-request",
  );
  assert.equal(payments.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(payments[0].postData)).sort(), [
    "receiving_ua",
    "requested_amount_zat",
  ]);
  assert.equal(
    events.filter((e) =>
      ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"].includes(
        e.method,
      ),
    ).length,
    0,
  );
  const overflow = await browser.evaluate(
    "document.documentElement.scrollWidth>innerWidth",
  );
  assert.equal(overflow, false);
  // Exercise the native write API under a real pointer gesture; do not read it.
  await browser.call("Browser.grantPermissions", {
    origin: base,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  const point = await browser.evaluate(
    `(()=>{const b=document.querySelector('#payment button');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await browser.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await browser.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await browser.evaluate(
    `(async()=>{for(let n=0;n<100&&!document.getElementById('payment').textContent.includes('Payment request copied.');n++)await new Promise(done=>setTimeout(done,20));if(!document.getElementById('payment').textContent.includes('Payment request copied.'))throw new Error('Native clipboard write failed');})()`,
  );
  await mkdir(
    new URL("../../../.tools/browser-screenshots-v1/", import.meta.url),
    {
      recursive: true,
    },
  );
  const screenshotDirectory = await mkdtemp(
    new URL(
      "../../../.tools/browser-screenshots-v1/phase8-payment-",
      import.meta.url,
    ),
  );
  const capture = async (name) => {
    await browser.evaluate(
      "document.getElementById('payment').scrollIntoView({block:'start'})",
    );
    const screenshot = await browser.call("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      join(screenshotDirectory, `${name}.png`),
      Buffer.from(screenshot.data, "base64"),
      { flag: "wx" },
    );
  };
  await capture("desktop");
  await browser.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 1400,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(
    await browser.evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  await capture("narrow");
  await browser.call("Emulation.clearDeviceMetricsOverride");
  // Navigating away clears ephemeral payment DOM before any history restoration.
  await browser.evaluate("dispatchEvent(new Event('pagehide'))");
  assert.equal(
    await browser.evaluate("document.getElementById('payment').textContent"),
    "",
  );
});

test("Actual UI formatter failure retries without issuance or new credential/address", async () => {
  await runSeed("globalThis.phase8LocalId=id;");
  const issuedBefore = completed;
  failFormat = true;
  await browser.navigate(base + "/");
  await browser.evaluate(`(async()=>{
    for(let n=0;n<100&&!document.querySelector('#records button');n++)await new Promise(done=>setTimeout(done,20));
    document.querySelector('#records button').click();
    for(let n=0;n<200&&!document.getElementById('payment').textContent.includes('Retry payment preparation');n++)await new Promise(done=>setTimeout(done,20));
    if(document.querySelector('.payment-request')||!document.getElementById('payment').textContent.includes('Retry payment preparation'))throw new Error('Preparation retry unavailable');
  })()`);
  const requestsBefore = browser.events.filter(
    (e) =>
      e.method === "Network.requestWillBeSent" &&
      e.params.request.url === base + "/api/issuance",
  ).length;
  failFormat = false;
  await browser.evaluate(
    `(async()=>{document.querySelector('#payment button').click();for(let n=0;n<200&&!document.querySelector('.payment-request');n++)await new Promise(done=>setTimeout(done,20));if(!document.querySelector('.payment-request'))throw new Error('Preparation retry failed');})()`,
  );
  assert.equal(completed, issuedBefore);
  assert.equal(
    browser.events.filter(
      (e) =>
        e.method === "Network.requestWillBeSent" &&
        e.params.request.url === base + "/api/issuance",
    ).length,
    requestsBefore,
  );
});

test("Public host and static backup host expose no payment API or participant presentation modules", async () => {
  const publicServer = createPublicServer({ readMarket: async () => [market] });
  await new Promise((done) => publicServer.listen(0, "127.0.0.1", done));
  try {
    const origin = `http://127.0.0.1:${publicServer.address().port}`;
    for (const route of [
      "/api/payment-request",
      "/payment-ui.mjs",
      "/money.js",
    ])
      assert.equal((await fetch(origin + route)).status, 404);
    const publicText = await (await fetch(origin + "/api/market")).text();
    assert.doesNotMatch(
      publicText,
      /payment_uri|receiving_ua|claim_secret|issuance_token|requested_amount_zat/,
    );
  } finally {
    await new Promise((done) => publicServer.close(done));
  }
  const staticServer = createVaultServer();
  await new Promise((done) => staticServer.listen(0, "127.0.0.1", done));
  try {
    const origin = `http://127.0.0.1:${staticServer.address().port}`;
    for (const route of [
      "/api/payment-request",
      "/payment-ui.mjs",
      "/money.js",
    ])
      assert.equal((await fetch(origin + route)).status, 404);
  } finally {
    await new Promise((done) => staticServer.close(done));
  }
  for (const path of ["../src/payment-ui.mjs", "../src/payment-request.mjs"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /console\.|sendBeacon|localStorage|sessionStorage|indexedDB|innerHTML|readText|location\.|history\.|req-asset|memo=/,
    );
  }
  const backup = await readFile(
    new URL("../src/ticket-backup.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(backup, /payment_uri|receiving_ua|requested_amount_zat/);
  assert.ok(formatted > 0);
});

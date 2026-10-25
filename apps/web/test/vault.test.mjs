import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createVaultServer } from "../src/vault-server.mjs";
import { createPublicServer } from "../src/public-server.mjs";
import { market } from "./public-fixtures.mjs";

test("SEC02/03/04: static vault source and dependency boundary, no network/telemetry or unsafe secret output", async () => {
  for (const path of ["../src/local-vault.mjs", "../src/vault-ui.mjs"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /Math\.random|fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|console\.|localStorage|sessionStorage|location\.|innerHTML|outerHTML|insertAdjacentHTML|btoa|atob|Blob|download|clipboard/,
    );
    assert.doesNotMatch(
      source,
      /node:|darkpool_private|admin|receiver|requested_amount|side:/,
    );
  }
  const generator = await readFile(
    new URL("../dist/vault/secrets.js", import.meta.url),
    "utf8",
  );
  assert.equal(
    generator,
    await readFile(
      new URL("../../../packages/protocol/dist/secrets.js", import.meta.url),
      "utf8",
    ),
  );
  assert.match(generator, /getRandomValues\(secret\)/);
  assert.match(generator, /new Uint8Array\(32\)/);
  const original = await readFile(
    new URL(
      "../../../packages/protocol/dist/claim-commitment.js",
      import.meta.url,
    ),
    "utf8",
  );
  const browser = await readFile(
    new URL("../dist/vault/claim-commitment.js", import.meta.url),
    "utf8",
  );
  assert.equal(
    browser,
    original
      .replace('"@noble/hashes/blake2.js"', '"./vendor/blake2.js"')
      .replace('"@noble/hashes/utils.js"', '"./vendor/utils.js"'),
  );
  for (const name of [
    "blake2.js",
    "_blake.js",
    "_md.js",
    "_u64.js",
    "utils.js",
  ])
    assert.equal(
      await readFile(
        new URL(`../dist/vault/vendor/${name}`, import.meta.url),
        "utf8",
      ),
      await readFile(
        new URL(`../../../node_modules/@noble/hashes/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const server = await readFile(
    new URL("../src/vault-server.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    server,
    /from.*(?:local-vault|secrets|claim-commitment|protocol|db\/|admin|wallet)/,
  );
});

test("SEC01/02/06/07: static local routes have strict CSP; no participant mutation or private API", async () => {
  const server = createVaultServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + "/");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-security-policy"),
      /connect-src 'none'/,
    );
    assert.match(
      response.headers.get("content-security-policy"),
      /script-src 'self'/,
    );
    assert.doesNotMatch(
      response.headers.get("content-security-policy"),
      /unsafe-inline|unsafe-eval/,
    );
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const html = await response.text();
    assert.match(html, /permanent loss/);
    assert.match(html, /server cannot recover/);
    assert.match(html, /Individual ticket backup and restore/);
    assert.match(html, /attempts cannot be exported/);
    assert.doesNotMatch(html, /<(?:form|input|iframe)\b|https?:\/\//);
    for (const path of [
      "/api/market",
      "/api/tickets",
      "/tickets",
      "/predict",
      "/claim",
      "/refund",
      "/portfolio",
      "/admin",
      "/export",
      "/import",
      "/test",
      "/vendor/argon2.js",
      "/../package.json",
      "/vault.html",
    ])
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
        assert.equal((await fetch(base + path, { method })).status, 404);
    for (const path of ["/", "/local-vault.mjs", "/vault.css"])
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        assert.equal((await fetch(base + path, { method })).status, 405);
    assert.equal((await fetch(base + "/?claim_secret=synthetic")).status, 400);
    assert.equal(
      await (await fetch(base + "/", { method: "HEAD" })).text(),
      "",
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("SEC01: Phase 5 public responses remain exact and vault routes unavailable on public origin", async () => {
  const server = createPublicServer({ readMarket: async () => [market] });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(base + "/api/market")).json(), {
      market,
    });
    for (const path of [
      "/local-vault.mjs",
      "/vault-ui.mjs",
      "/my-predictions",
      "/api/vault",
    ])
      assert.equal((await fetch(base + path)).status, 404);
    assert.doesNotMatch(
      await (await fetch(base + "/")).text(),
      /<script|claim_secret|ticket_id|claim_commitment/,
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("SEC03: actual static-vault process logs startup only across HTTP success/failure paths", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/vault-cli.mjs", import.meta.url))],
    {
      env: { ...process.env, ZCASH_NETWORK: "testnet", VAULT_PORT: "0" },
      windowsHide: true,
    },
  );
  const closed = new Promise((done) => child.once("close", done));
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const port = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Vault startup timed out")),
        10000,
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Vault startup failed"));
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const match = /127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal(
      (await fetch(base + "/?claim_secret=SYNTHETIC_PRIVATE_LOG_SENTINEL"))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/tickets", {
          method: "POST",
          body: "SYNTHETIC_PRIVATE_LOG_SENTINEL",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/", {
          method: "POST",
          body: "SYNTHETIC_PRIVATE_LOG_SENTINEL",
        })
      ).status,
      405,
    );
  } finally {
    child.kill();
    await closed;
  }
  assert.equal(stderr, "");
  assert.match(stdout, /^Local vault listening on 127\.0\.0\.1:\d+\r?\n$/);
});

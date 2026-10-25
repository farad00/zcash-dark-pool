import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { MARKET_STATUSES } from "../../../packages/protocol/dist/domain.js";
import { createPublicServer } from "../src/public-server.mjs";
import {
  projectPublicMarket,
  publicMarketKeys,
  renderMarket,
} from "../src/public-market.mjs";
import {
  publicConnectionEnvironment,
  publicMarketQuery,
} from "../../../db/public-read.mjs";
import { market, privateFields, forbiddenFields } from "./public-fixtures.mjs";
import { auditPublicClosure } from "./public-capability-graph.mjs";

async function withServer(readMarket, run) {
  const server = createPublicServer({ readMarket });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
function raw(base, path, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path, method, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
function noPrivate(body) {
  for (const value of Object.values(privateFields))
    assert.ok(!body.includes(value));
  for (const key of forbiddenFields) assert.ok(!body.includes(`"${key}"`));
}

test("FR-01 / SEC01: normal DRAFT page, exact public API, UTC and security headers", async () => {
  await withServer(
    async () => [market],
    async (base) => {
      const page = await fetch(base + "/"),
        html = await page.text();
      assert.equal(page.status, 200);
      for (const value of [
        market.question,
        market.yes_definition,
        market.no_definition,
        market.resolution_rule,
        ...market.resolution_sources,
        ...market.void_conditions,
        "DRAFT",
        "not accepting predictions",
        "rules may change",
        "UTC",
      ])
        assert.ok(html.includes(value));
      assert.ok(html.includes(market.opens_at));
      assert.ok(html.includes(market.closes_at));
      assert.match(page.headers.get("content-type"), /^text\/html/);
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.equal(page.headers.get("referrer-policy"), "no-referrer");
      assert.equal(page.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        page.headers.get("content-security-policy"),
        /form-action 'none'/,
      );
      assert.match(
        page.headers.get("content-security-policy"),
        /default-src 'none'/,
      );
      assert.equal(page.headers.get("set-cookie"), null);
      const api = await fetch(base + "/api/market");
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), { market });
      assert.deepEqual(
        Object.keys(projectPublicMarket([market])).sort(),
        [...publicMarketKeys].sort(),
      );
      assert.equal((await fetch(base + "/", { method: "HEAD" })).status, 200);
      assert.equal(
        await (await fetch(base + "/api/market", { method: "HEAD" })).text(),
        "",
      );
      assert.equal((await fetch(base + "/market.css")).status, 200);
    },
  );
});

test("SEC01: private field contamination never reaches API or renderer", async () => {
  const contaminated = {
    ...market,
    ...privateFields,
    nested_private: privateFields,
  };
  assert.deepEqual(projectPublicMarket([contaminated]), market);
  noPrivate(renderMarket([contaminated]));
  await withServer(
    async () => [contaminated],
    async (base) => {
      for (const path of ["/", "/api/market"]) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200);
        const body = await response.text();
        noPrivate(body);
        assert.ok(!body.includes("nested_private"));
      }
    },
  );
});

test("SEC01 / lifecycle boundary: display only the nine stored statuses; no time inference", () => {
  for (const status of MARKET_STATUSES) {
    const row = {
      ...market,
      status,
      opens_at: "2000-01-01T00:00:00.000000Z",
      closes_at: "2000-01-02T00:00:00.000000Z",
    };
    assert.equal(projectPublicMarket([row]).status, status);
    assert.ok(renderMarket([row]).includes(`<strong>${status}</strong>`));
  }
  assert.throws(() =>
    projectPublicMarket([{ ...market, status: "LOCK_FINALIZING" }]),
  );
  assert.throws(() =>
    projectPublicMarket([{ ...market, status: "NO_WINNER_REFUND" }]),
  );
});

test("SEC06: every public text field is escaped; sources remain text with no external requests", async () => {
  const attack = '<script src="https://attacker.invalid">alert(1)</script>&\'"';
  const row = {
    ...market,
    market_id: attack,
    question: attack,
    yes_definition: attack,
    no_definition: attack + "NO",
    resolution_rule: attack,
    resolution_sources: [attack, "javascript:alert(1)"],
    void_conditions: [attack],
  };
  const html = renderMarket([row]);
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes(attack));
  assert.ok(html.includes("&lt;script"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&#39;"));
  assert.ok(html.includes("&quot;"));
  assert.deepEqual(
    [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ["/market.css"],
  );
  assert.doesNotMatch(html, /<(form|input|button|iframe|script)\b/i);
  const css = await readFile(
    new URL("../src/market.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(css, /@import|url\(/i);
});

test("Malformed, missing and invalid market data fail safely without partial fields", async () => {
  const cases = [
    null,
    {},
    [null],
    [market, market],
    [{ ...market, version: 2 }],
    [{ ...market, network: "mainnet" }],
    [{ ...market, question: " " }],
    [{ ...market, yes_definition: market.no_definition }],
    [{ ...market, resolution_sources: [] }],
    [{ ...market, resolution_sources: [null] }],
    [{ ...market, void_conditions: "void" }],
    [{ ...market, question: "x".repeat(8193) }],
    [{ ...market, question: "\ud800" }],
    [{ ...market, question: "\u0000" }],
    [{ ...market, closes_at: market.opens_at }],
    [{ ...market, opens_at: "2026-02-30T00:00:00.000000Z" }],
    [{ ...market, closes_at: "infinity" }],
  ];
  for (const key of publicMarketKeys) {
    const row = { ...market };
    delete row[key];
    cases.push([row]);
  }
  for (const rows of cases) {
    await withServer(
      async () => rows,
      async (base) => {
        for (const path of ["/", "/api/market"]) {
          const response = await fetch(base + path);
          assert.equal(response.status, 503);
          const body = await response.text();
          assert.ok(body.includes("Market unavailable"));
          assert.ok(!body.includes(market.question));
          noPrivate(body);
        }
      },
    );
  }
});

test("Market not found and database failure sanitization", async () => {
  for (const [reader, status, error] of [
    [async () => [], 404, "Market not found"],
    [
      async () => {
        throw new Error(
          "SQL darkpool_private tickets postgres://secret C:\\private\\wallet stack PRIVATE_SENTINEL_0_NEVER_PUBLIC",
        );
      },
      503,
      "Market unavailable",
    ],
  ]) {
    await withServer(reader, async (base) => {
      for (const path of ["/", "/api/market"]) {
        const response = await fetch(base + path);
        assert.equal(response.status, status);
        const body = await response.text();
        assert.ok(body.includes(error));
        assert.doesNotMatch(
          body,
          /SQL|darkpool_private|postgres:\/\/|C:\\private|stack|PRIVATE_SENTINEL/,
        );
      }
    });
  }
});

test("SEC07/09: malformed requests, body rejection and mutation routes do not call database", async () => {
  let calls = 0;
  await withServer(
    async () => {
      calls++;
      return [market];
    },
    async (base) => {
      for (const path of [
        "/?side=YES",
        "/api/market?fields=*",
        "/api/market?ticket_id=private",
        "/%zz",
        "//api/market",
        "/api/market#fragment",
        "/" + "x".repeat(2049),
      ]) {
        const result = await raw(base, path);
        assert.equal(result.status, 400);
        assert.deepEqual(JSON.parse(result.body), { error: "Invalid request" });
      }
      assert.equal(
        (await raw(base, "/", "GET", { "Content-Length": "1" })).status,
        400,
      );
      for (const path of ["/", "/api/market", "/market.css"]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
          const response = await fetch(base + path, { method });
          assert.equal(response.status, 405);
          assert.equal(response.headers.get("allow"), "GET, HEAD");
        }
      }
      for (const path of [
        "/predict",
        "/api/predict",
        "/tickets",
        "/api/tickets",
        "/claim",
        "/api/claim",
        "/refund",
        "/api/refund",
        "/wallet",
        "/api/wallet",
        "/portfolio",
        "/api/portfolio",
        "/admin",
        "/admin/open",
        "/api/admin",
        "/market/YES",
        "/market/NO",
        "/market/id/predict",
        "/api/market/predict",
        "/api/market/tickets",
      ]) {
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
          assert.equal((await fetch(base + path, { method })).status, 404);
      }
      assert.equal(calls, 0);
    },
  );
});

test("SEC04/12: narrow environment and read SQL cannot import wallet/admin authority", () => {
  const env = {
    ZCASH_NETWORK: "testnet",
    PGHOST: "127.0.0.1",
    PGPORT: "55432",
    PGUSER: "reader",
    PGDATABASE: "product",
    SEED: "private",
    UFVK: "private",
    FROST_SHARE: "private",
  };
  const clean = publicConnectionEnvironment(env);
  for (const key of ["SEED", "UFVK", "FROST_SHARE"])
    assert.equal(clean[key], undefined);
  for (const [key, value] of [
    ["PGUSER", ""],
    ["PGDATABASE", "postgres://secret"],
    ["PGPORT", "0"],
    ["PGPORT", "65536"],
    ["PGHOST", "remote"],
    ["ZCASH_NETWORK", "mainnet"],
    ["PGOPTIONS", "-c role=owner"],
    ["PGSERVICE", "owner"],
    ["PGSERVICEFILE", "private"],
    ["DATABASE_URL", "private"],
    ["DARKPOOL_ADMIN_INTERNAL", "1"],
    ["WALLET_DB_PATH", "private"],
  ])
    assert.throws(() => publicConnectionEnvironment({ ...env, [key]: value }), {
      message: "Market unavailable",
    });
  assert.doesNotMatch(
    publicMarketQuery,
    /darkpool_private|darkpool_admin|SELECT\s+\*/i,
  );
  assert.match(publicMarketQuery, /FROM darkpool_public.markets LIMIT 2/);
});

test("SEC09: bounded concurrent reads fail closed and recover", async () => {
  let release,
    started = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withServer(
    async () => {
      started++;
      await gate;
      return [market];
    },
    async (base) => {
      const pending = Array.from({ length: 4 }, () =>
        fetch(base + "/api/market"),
      );
      while (started < 4)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await fetch(base + "/api/market")).status, 503);
      release();
      for (const response of await Promise.all(pending))
        assert.equal(response.status, 200);
      assert.equal((await fetch(base + "/api/market")).status, 200);
    },
  );
});

test("SEC02/03/04: recursively bounded public capability closure, no TEST/destructive/admin/issuer/watcher/wallet authority", async () => {
  assert.equal((await auditPublicClosure()).length, 8);
});

test("SEC02/04: boundary assertion catches forbidden transitive imports and re-exports", async () => {
  const path = "db/environment-identity.mjs";
  const source = await readFile(
    new URL("../../../" + path, import.meta.url),
    "utf8",
  );
  for (const module of [
    "environment.mjs",
    "environment-test.mjs",
    "test-fixtures.mjs",
    "migrate.mjs",
    "issuance-runtime.mjs",
    "../services/watcher/db.mjs",
    "../apps/web/src/admin.mjs",
    "../services/watcher/wallet.mjs",
  ]) {
    await assert.rejects(
      auditPublicClosure(
        new Map([
          [
            path,
            source +
              `\nexport * from '${module.startsWith(".") ? module : "./" + module}';\n`,
          ],
        ]),
      ),
      /forbidden capability module/,
    );
  }
});

test("SEC02/04: boundary assertion rejects dynamic loaders and TEST authority inside approved modules", async () => {
  const path = "db/public-reader-runtime.mjs";
  const source = await readFile(
    new URL("../../../" + path, import.meta.url),
    "utf8",
  );
  for (const addition of [
    "await import('./environment.mjs');",
    "require('./environment.mjs');",
    "process.env.DARKPOOL_TEST_ONLY;",
    "const testDatabase = () => true;",
  ])
    await assert.rejects(
      auditPublicClosure(new Map([[path, source + "\n" + addition]])),
    );
});

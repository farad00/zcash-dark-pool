// Recursively inspect executable imports, including re-exports and dynamic loaders.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../../../", import.meta.url);
const modules = {
  "apps/web/src/server.mjs": ["node:process"],
  "apps/web/src/public-server.mjs": ["node:http", "node:fs"],
  "apps/web/src/public-market.mjs": [],
  "packages/protocol/dist/domain.js": [],
  "db/public-read.mjs": ["node:child_process"],
  "db/public-reader-runtime.mjs": ["node:fs/promises", "node:path"],
  "db/environment-identity.mjs": ["node:fs/promises", "node:path"],
  "db/target-identities.json": [],
};
const forbidden =
  /DARKPOOL_TEST_ONLY|TEST_ONLY|assertFixtureSql|testDatabase|testRole|validateTestTarget|environmentLayout|loadEnvironmentGuard|target-registry|configuredTarget|approvedTarget|initializerPlan|generateClaimSecret|deriveClaimCommitment|localStorage|indexedDB|zip321|node:sqlite|admin-cli|admin-provision|console\./;

export async function auditPublicClosure(overrides = new Map()) {
  const visited = new Map();
  async function visit(url) {
    const path = url.href.slice(root.href.length);
    assert.ok(
      Object.hasOwn(modules, path),
      `forbidden capability module: ${path}`,
    );
    if (visited.has(path)) return;
    const source = overrides.get(path) ?? (await readFile(url, "utf8"));
    assert.doesNotMatch(source, forbidden, `forbidden capability in ${path}`);
    visited.set(path, source);
    if (path.endsWith(".json")) {
      const data = JSON.parse(source);
      assert.deepEqual(Object.keys(data).sort(), ["LIVE_EVIDENCE", "TEST"]);
      return;
    }
    const parsed = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.equal(
      parsed.parseDiagnostics.length,
      0,
      `unparsed closure module: ${path}`,
    );
    const edges = [];
    function inspect(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          assert.ok(ts.isStringLiteral(node.moduleSpecifier));
          edges.push(node.moduleSpecifier.text);
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression.getText(parsed);
        assert.ok(
          ![
            "import",
            "require",
            "eval",
            "Function",
            "module.require",
            "createRequire",
            "process.getBuiltinModule",
          ].includes(callee),
          `dynamic capability loader: ${path}`,
        );
        if (callee === "readMarket")
          assert.equal(
            node.arguments.length,
            0,
            "HTTP must not pass target/SQL arguments",
          );
        if (/^(spawn|exec|execFile|fork)(Sync)?$/.test(callee)) {
          assert.equal(
            path,
            "db/public-read.mjs",
            "only the approved query adapter may spawn a DB client",
          );
          assert.equal(callee, "spawn");
        }
      }
      if (
        node.getText(parsed) === "process.env" &&
        ts.isPropertyAccessExpression(node)
      )
        assert.ok(
          ["apps/web/src/server.mjs", "db/public-read.mjs"].includes(path),
          `ambient target read: ${path}`,
        );
      ts.forEachChild(node, inspect);
    }
    inspect(parsed);
    for (const edge of edges) {
      if (edge.startsWith("node:"))
        assert.ok(
          modules[path].includes(edge),
          `unexpected builtin authority ${path}: ${edge}`,
        );
      else {
        assert.ok(
          edge.startsWith("."),
          `unreviewed package authority: ${edge}`,
        );
        await visit(new URL(edge, url));
      }
    }
  }
  await visit(new URL("apps/web/src/server.mjs", root));
  assert.deepEqual([...visited.keys()].sort(), Object.keys(modules).sort());
  // The HTTP layer owns only a no-argument reader. Target/config/SQL binding is startup-only.
  const http = visited.get("apps/web/src/public-server.mjs");
  assert.doesNotMatch(
    http,
    /process\.env|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|guardedSql|createPublicReader|\bspawn\b/,
  );
  const adapter = visited.get("db/public-read.mjs");
  assert.match(adapter, /export async function createPublicReader/);
  assert.doesNotMatch(
    adapter,
    /export (?:async )?function (?:query|execute|psql|readPublicMarketRows)\b/,
  );
  assert.match(adapter, /guardedSql\(target,/);
  assert.match(adapter, /await target\.verify\(\)/);
  assert.match(adapter, /BEGIN READ ONLY/);
  assert.match(adapter, /Object\.freeze\(read\)/);
  return [...visited.keys()].sort();
}

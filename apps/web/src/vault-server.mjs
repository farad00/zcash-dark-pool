// Separate static local origin. Never import or execute the secret-handling modules here.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const files = [
  "vault.css",
  "vault-ui.mjs",
  "local-vault.mjs",
  "ticket-backup.mjs",
  "backup-ui.mjs",
  "secrets.js",
  "claim-commitment.js",
  "vendor/blake2.js",
  "vendor/_blake.js",
  "vendor/_md.js",
  "vendor/_u64.js",
  "vendor/utils.js",
];
export function createVaultServer({ connectToSelf = false } = {}) {
  const assets = new Map(
    files.map((name) => [
      "/" + name,
      {
        body: readFileSync(new URL(`../dist/vault/${name}`, import.meta.url)),
        type: name.endsWith(".css") ? "text/css" : "text/javascript",
      },
    ]),
  );
  assets.set("/", {
    body: readFileSync(new URL("../dist/vault/vault.html", import.meta.url)),
    type: "text/html",
  });
  assets.set("/backup", {
    body: readFileSync(new URL("../dist/vault/backup.html", import.meta.url)),
    type: "text/html",
  });
  return createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${connectToSelf ? "'self'" : "'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
      );
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      const send = (status, body, type = "application/json") => {
        response.writeHead(status, {
          "Content-Type": `${type}; charset=utf-8`,
        });
        response.end(request.method === "HEAD" ? undefined : body);
      };
      const target = request.url;
      if (
        typeof target !== "string" ||
        target.length > 2048 ||
        !target.startsWith("/") ||
        target.startsWith("//") ||
        /[?#\\\s%]/u.test(target)
      ) {
        send(400, '{"error":"Invalid request"}');
        return;
      }
      const asset = assets.get(target);
      if (!asset) {
        send(404, '{"error":"Not found"}');
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Allow", "GET, HEAD");
        send(405, '{"error":"Method not allowed"}');
        return;
      }
      if (
        request.headers["transfer-encoding"] ||
        (request.headers["content-length"] &&
          request.headers["content-length"] !== "0")
      ) {
        send(400, '{"error":"Invalid request"}');
        return;
      }
      send(200, asset.body, asset.type);
    },
  );
}

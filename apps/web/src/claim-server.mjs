// Loopback development transport. Trusted startup dependencies never come from HTTP.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createVaultServer } from "./vault-server.mjs";
import { projectPublicMarket } from "./public-market.mjs";
import { validateDestination } from "../../../services/claims/primitives.mjs";
import {
  CLAIM_MAX_BYTES,
  parseClaimJson,
  payoutText,
  validateClaimPacket,
} from "./claim-wire.mjs";

export const NOT_CONFIRMED = Object.freeze({
  status: "NOT_CONFIRMED",
  recovery: "RETRY_SAME_REQUEST",
});
export function createClaimServer({
  claims,
  readMarket = async () => [],
} = {}) {
  const fallback = createVaultServer({ connectToSelf: true });
  const assets = new Map(
    ["claim.html", "claim-ui.mjs", "claim-client.mjs", "claim-wire.mjs"].map(
      (n) => [
        n === "claim.html" ? "/claim" : "/" + n,
        readFileSync(new URL(`../dist/vault/${n}`, import.meta.url)),
      ],
    ),
  );
  let credits = 60,
    refill = Date.now(),
    active = 0;
  return createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (req, res) => {
      const origin = `http://127.0.0.1:${req.socket.localPort}`;
      const headers = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
      };
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      const send = (code, value, type = "application/json") => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` });
        res.end(
          req.method === "HEAD"
            ? undefined
            : typeof value === "object" && !Buffer.isBuffer(value)
              ? JSON.stringify(value)
              : value,
        );
      };
      const url = req.url;
      if (
        typeof url !== "string" ||
        url.length > 2048 ||
        !url.startsWith("/") ||
        url.startsWith("//") ||
        /[?#\\\s%]/u.test(url) ||
        req.headers.host !== origin.slice(7)
      ) {
        send(400, NOT_CONFIRMED);
        return;
      }
      const asset = assets.get(url),
        api = [
          "/api/claim-market",
          "/api/claim-address",
          "/api/claim",
        ].includes(url);
      if (!asset && !api) {
        fallback.emit("request", req, res);
        return;
      }
      if (asset || url === "/api/claim-market") {
        if (!["GET", "HEAD"].includes(req.method)) {
          send(405, NOT_CONFIRMED);
          return;
        }
        if (
          req.headers["transfer-encoding"] ||
          (req.headers["content-length"] &&
            req.headers["content-length"] !== "0")
        ) {
          send(400, NOT_CONFIRMED);
          return;
        }
        if (asset) {
          send(200, asset, url === "/claim" ? "text/html" : "text/javascript");
          return;
        }
      } else if (req.method !== "POST") {
        send(405, NOT_CONFIRMED);
        return;
      }
      if (Date.now() - refill >= 60000) {
        credits = 60;
        refill = Date.now();
      }
      if (credits-- <= 0 || active >= 4) {
        credits = Math.max(credits, 0);
        send(429, NOT_CONFIRMED);
        return;
      }
      if (
        url !== "/api/claim-market" &&
        (req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json" ||
          ![undefined, "same-origin"].includes(req.headers["sec-fetch-site"]) ||
          req.headers["content-encoding"])
      ) {
        send(403, NOT_CONFIRMED);
        return;
      }
      active++;
      let bytes;
      const chunks = [];
      try {
        if (url === "/api/claim-market") {
          const m = projectPublicMarket(await readMarket());
          send(200, {
            market: m
              ? {
                  market_id: m.market_id,
                  question: m.question,
                  state: m.status,
                }
              : null,
            claims: claims ? "CHECKED_ON_SUBMISSION" : "UNAVAILABLE",
            environment: claims?.mode ?? "UNAVAILABLE",
          });
          return;
        }
        let size = 0;
        for await (const chunk of req) {
          chunks.push(chunk);
          size += chunk.length;
          if (size > CLAIM_MAX_BYTES) {
            send(413, NOT_CONFIRMED);
            return;
          }
        }
        bytes = Buffer.concat(chunks);
        const packet = parseClaimJson(bytes);
        if (url === "/api/claim-address") {
          if (!packet || Object.keys(packet).join() !== "payout_ua")
            throw new Error();
          await validateDestination(payoutText(packet.payout_ua));
          send(200, { valid: true });
          return;
        }
        validateClaimPacket(packet);
        if (!claims) throw new Error();
        const result = await claims.reserve(packet);
        // Output allowlist; a private service object can never be serialized by accident.
        if (
          !["RESERVED", "PREPARED"].includes(result.status) ||
          result.payment !== "NOT_SENT" ||
          !["EXTERNAL_REQUIRED", "SYNTHETIC_TEST_ONLY"].includes(
            result.environment,
          )
        )
          throw new Error();
        send(200, {
          status: result.status,
          payment: "NOT_SENT",
          environment: result.environment,
        });
      } catch {
        send(409, NOT_CONFIRMED);
      } finally {
        bytes?.fill(0);
        chunks.forEach((c) => c.fill(0));
        active--;
      }
    },
  );
}

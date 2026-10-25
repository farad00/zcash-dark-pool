import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  projectPublicMarket,
  renderMarket,
  renderError,
} from "./public-market.mjs";

const stylesheet = readFileSync(
  new URL("./market.css", import.meta.url),
  "utf8",
);
export function createPublicServer({ readMarket, participationHref }) {
  if (typeof readMarket !== "function") throw new Error("Market unavailable");
  let activeReads = 0;
  return createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      const send = (status, body, type = "application/json; charset=utf-8") => {
        response.writeHead(status, { "Content-Type": type });
        response.end(request.method === "HEAD" ? undefined : body);
      };
      const jsonError = (status, error) =>
        send(status, JSON.stringify({ error }));
      const target = request.url;
      if (
        typeof target !== "string" ||
        target.length > 2048 ||
        !target.startsWith("/") ||
        target.startsWith("//") ||
        /[?#\\\s]/u.test(target) ||
        /%(?![\da-f]{2})/iu.test(target)
      ) {
        jsonError(400, "Invalid request");
        return;
      }
      if (target === "/health" && request.method === "GET") {
        send(
          200,
          JSON.stringify({
            service: "web",
            status: "scaffold",
            network: "testnet",
          }),
        );
        return;
      }
      if (!["/", "/api/market", "/market.css"].includes(target)) {
        jsonError(404, "Not found");
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Allow", "GET, HEAD");
        jsonError(405, "Method not allowed");
        return;
      }
      if (
        request.headers["transfer-encoding"] ||
        (request.headers["content-length"] &&
          request.headers["content-length"] !== "0")
      ) {
        jsonError(400, "Invalid request");
        return;
      }
      if (target === "/market.css") {
        send(200, stylesheet, "text/css; charset=utf-8");
        return;
      }
      const failure = (status, title, message) =>
        target === "/"
          ? send(
              status,
              renderError(title, message),
              "text/html; charset=utf-8",
            )
          : jsonError(status, title);
      if (activeReads >= 4) {
        failure(503, "Market unavailable", "Please try again later.");
        return;
      }
      activeReads++;
      try {
        const market = projectPublicMarket(await readMarket());
        if (!market) {
          failure(404, "Market not found", "No market is currently available.");
          return;
        }
        if (target === "/api/market") send(200, JSON.stringify({ market }));
        else
          send(
            200,
            renderMarket([market], { participationHref }),
            "text/html; charset=utf-8",
          );
      } catch {
        failure(503, "Market unavailable", "Please try again later.");
      } finally {
        activeReads--;
      }
    },
  );
}

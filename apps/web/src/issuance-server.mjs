import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createVaultServer } from "./vault-server.mjs";
import { createIssuer } from "./issuance.mjs";
import {
  paymentStatusPacket,
  paymentStatusResult,
  statusUnavailable,
} from "./payment-status-wire.mjs";
import {
  formatPaymentRequest,
  parsePaymentRequest,
  participantPaymentResult,
} from "./payment-request.mjs";

function participantResult(value) {
  const keys = [
    "issuance_profile_version",
    "network",
    "market_id",
    "ticket_id",
    "closes_at",
    "status",
  ];
  if (value?.status === "ISSUED") keys.push("receiving_ua");
  if (
    !value ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    value.issuance_profile_version !== 1 ||
    value.network !== "testnet" ||
    !["RESERVED", "ISSUED"].includes(value.status) ||
    typeof value.market_id !== "string" ||
    !value.market_id.length ||
    typeof value.ticket_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.ticket_id) ||
    typeof value.closes_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.closes_at) ||
    (value.status === "ISSUED" &&
      (typeof value.receiving_ua !== "string" ||
        value.receiving_ua.length > 1024 ||
        !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(
          value.receiving_ua,
        )))
  )
    throw new Error("ISSUANCE_UNAVAILABLE");
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function createIssuanceServer({
  issue = createIssuer(),
  preparePayment = formatPaymentRequest,
  paymentStatus = statusUnavailable,
  unfundedOnly = false,
} = {}) {
  if (typeof unfundedOnly !== "boolean")
    throw new Error("ISSUANCE_UNAVAILABLE");
  const staticServer = createVaultServer({ connectToSelf: true });
  const assets = new Map(
    [
      "issuance.html",
      "issuance-ui.mjs",
      "issuance-client.mjs",
      "payment-ui.mjs",
      "money.js",
      "payment-status-wire.mjs",
    ].map((name) => [
      name,
      readFileSync(new URL(`../dist/vault/${name}`, import.meta.url)),
    ]),
  );
  if (unfundedOnly) {
    const page = assets.get("issuance.html").toString("utf8");
    if (!/<body[^>]*>/i.test(page)) throw new Error("ISSUANCE_UNAVAILABLE");
    assets.set(
      "issuance.html",
      Buffer.from(
        page.replace(
          /<body[^>]*>/i,
          '$&<p role="alert">UNFUNDED RECEIVER REHEARSAL: DO NOT PAY. Payment acceptance, claims and payouts are disabled.</p>',
        ),
      ),
    );
  }
  let active = 0,
    credits = 120,
    windowStart = Date.now();
  return createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (req, res) => {
      const headers = () => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
        );
      };
      const send = (status, value) => {
        if (res.destroyed) return;
        headers();
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(value));
      };
      if (
        typeof req.url !== "string" ||
        req.url.length > 2048 ||
        /[?#\\\s%]/u.test(req.url) ||
        !req.url.startsWith("/") ||
        req.url.startsWith("//")
      ) {
        send(400, { error: "INVALID_REQUEST" });
        return;
      }
      const isPayment = req.url === "/api/payment-request";
      const isStatus = req.url === "/api/payment-status";
      if (req.url !== "/api/issuance" && !isPayment && !isStatus) {
        const name = req.url === "/" ? "issuance.html" : req.url.slice(1);
        if (assets.has(name)) {
          if (!["GET", "HEAD"].includes(req.method)) {
            send(405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          if (
            req.headers["transfer-encoding"] ||
            +(req.headers["content-length"] ?? 0) !== 0
          ) {
            send(400, { error: "INVALID_REQUEST" });
            return;
          }
          headers();
          res.writeHead(200, {
            "Content-Type": name.endsWith(".html")
              ? "text/html; charset=utf-8"
              : "text/javascript; charset=utf-8",
          });
          res.end(req.method === "HEAD" ? undefined : assets.get(name));
          return;
        }
        staticServer.emit("request", req, res);
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const origin = `http://127.0.0.1:${res.socket.localPort}`;
      if (
        req.headers.origin !== origin ||
        req.headers.host !== new URL(origin).host ||
        req.headers["content-type"] !== "application/json" ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        send(403, { error: "ORIGIN_REJECTED" });
        return;
      }
      if (Date.now() - windowStart >= 60000) {
        credits = 120;
        windowStart = Date.now();
      }
      if (active >= 4 || credits-- <= 0) {
        send(429, { error: "ISSUANCE_BUSY" });
        return;
      }
      active++;
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) {
            send(413, { error: "INVALID_REQUEST" });
            return;
          }
          chunks.push(chunk);
        }
        let request;
        try {
          const raw = new globalThis.TextDecoder("utf-8", {
            fatal: true,
          }).decode(Buffer.concat(chunks));
          request = JSON.parse(raw);
          if (isStatus && JSON.stringify(request) !== raw) throw new Error();
        } catch {
          send(400, { error: "INVALID_REQUEST" });
          return;
        }
        const result = isStatus
          ? paymentStatusResult(
              await paymentStatus(paymentStatusPacket(request)),
            )
          : isPayment
            ? participantPaymentResult(
                await preparePayment(parsePaymentRequest(request)),
              )
            : participantResult(await issue(request));
        send(200, result);
      } catch (error) {
        if (isStatus) {
          send(503, { error: "PAYMENT_STATUS_UNAVAILABLE" });
          return;
        }
        const code = [
          "INVALID_REQUEST",
          "ISSUANCE_CONFLICT",
          "ISSUANCE_RECONCILE_REQUIRED",
        ].includes(error?.message)
          ? error.message
          : "ISSUANCE_UNAVAILABLE";
        send(
          code === "INVALID_REQUEST"
            ? 400
            : code === "ISSUANCE_CONFLICT"
              ? 409
              : 503,
          { error: code },
        );
      } finally {
        active--;
      }
    },
  );
}

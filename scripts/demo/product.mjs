// Disposable TEST composition only. No production environment/session override.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createIssuanceServer } from "../../apps/web/src/issuance-server.mjs";
import { createClaimServer } from "../../apps/web/src/claim-server.mjs";
import { createPublicServer } from "../../apps/web/src/public-server.mjs";
import { createPublicReader } from "../../db/public-read.mjs";
import {
  assertSyntheticLifecycle,
  resources,
} from "../../db/test/lifecycle-fixtures.mjs";
import { provisionBridgeStatus } from "../../db/test/bridge-provision.mjs";
import { createTestPaymentStatus } from "../../services/test-bridge/payment-status.mjs";
import { finalizeLock } from "../../services/lock/finalize.mts";
import { persistPublication } from "../../services/publication/persist.mjs";
import {
  executable,
  syntheticRetrieval,
} from "../../services/publication/test/fixtures.mjs";
import { approveResolution } from "../../services/resolution/approve.mjs";
import { finalizeResolution } from "../../services/resolution/prepare.mjs";
import { createParticipantClaims } from "../../services/claims/participant.mjs";
import { prepareDurablePayout } from "../../services/claims/reserve.mjs";
import { planPayoutIntent } from "../../services/payout/plan.mjs";

export async function createProductDemo(f, authority, addresses, stop) {
  assertSyntheticLifecycle();
  const made = await f.admin("create", {
    request_key: "demo_create",
    expected_revision: null,
    configuration: f.configuration,
  });
  if (made.result !== "APPLIED") throw Error("DEMO_UNAVAILABLE");
  await f.register();
  const opened = await f.admin("open", {
    request_key: "demo_open",
    expected_revision: "1",
  });
  if (opened.result !== "APPLIED") throw Error("DEMO_UNAVAILABLE");
  await provisionBridgeStatus(f);
  const paymentStatus = createTestPaymentStatus({
    ...f.env("other"),
    DARKPOOL_BRIDGE_TEST_ONLY: "1",
  });
  const readMarket = await createPublicReader(f.env("read"));
  const participant = await createParticipantClaims({
    env: f.env("claim"),
    syntheticTest: true,
  });
  const pending = new Map();
  let locked = null,
    resolved = null,
    publicationEvidence = null,
    paymentSnapshot = null,
    selectedOutcome = null,
    simulated = false,
    busy = false;
  const issuer = createIssuanceServer({
    paymentStatus,
    issue: async (packet) => {
      let answer;
      try {
        answer = await f.issue(packet);
      } catch (error) {
        // Fixed, redacted diagnostics only. No request body, bearer capability,
        // ticket ID, side, amount, receiver, credentials or raw SQL diagnostics.
        let condition = "UNAVAILABLE";
        try {
          const clock = JSON.parse(
            await f.sql(
              "SELECT jsonb_build_object('closed',clock_timestamp()>=closes_at,'state',status) FROM darkpool_private.markets;",
            ),
          );
          condition =
            packet.operation === "reserve" && packet.market_id !== f.mid
              ? "MARKET_MISMATCH"
              : clock.closed
                ? "MARKET_CLOSED"
                : clock.state !== "OPEN"
                  ? "MARKET_NOT_OPEN"
                  : "OPEN";
        } catch {
          /* Diagnostic failure cannot turn issuance into success. */
        }
        console.log(
          JSON.stringify({
            scope: "SYNTHETIC_TEST_ONLY",
            stage:
              packet.operation === "reserve"
                ? "ISSUANCE_RESERVE"
                : "ISSUANCE_COMPLETE",
            status: "NOT_CONFIRMED",
            market_condition: condition,
            sqlstate: /^[0-9A-Z]{5}$/.test(error?.sqlstate ?? "")
              ? error.sqlstate
              : null,
          }),
        );
        throw error;
      }
      if (packet.operation === "reserve")
        pending.set(packet.issuance_token, packet);
      if (
        packet.operation === "complete" &&
        !f.tickets.some((t) => t.id === answer.ticket_id)
      ) {
        const reserve = pending.get(packet.issuance_token);
        if (!reserve) throw Error("ISSUANCE_UNAVAILABLE");
        f.tickets.push({
          id: answer.ticket_id,
          amount: reserve.requested_amount_zat,
          side: reserve.side,
          complete: packet,
          issued: answer,
          secret: new Uint8Array(32),
          index: f.tickets.length,
        });
        pending.delete(packet.issuance_token);
      }
      return answer;
    },
  });
  const claims = createClaimServer({
    readMarket,
    claims: {
      mode: "SYNTHETIC_TEST_ONLY",
      async reserve(packet) {
        // Existing private credential/lifecycle checks run first. Never retain the
        // submitted secret; preparation and planning use the same verified claim.
        await participant.reserve(packet);
        const secret = new Uint8Array(Buffer.from(packet.claim_secret, "hex"));
        try {
          const prepared = await prepareDurablePayout(
            { ...packet, claim_secret: secret },
            f.env("claim"),
          );
          const intent = await planPayoutIntent(
            prepared.reservation_id,
            f.env("planner"),
          );
          if (
            intent.spending_authorized !== false ||
            intent.submission_enabled !== false
          )
            throw Error("DEMO_UNAVAILABLE");
          return {
            status: "PREPARED",
            payment: "NOT_SENT",
            environment: "SYNTHETIC_TEST_ONLY",
          };
        } finally {
          secret.fill(0);
        }
      },
    },
  });
  const market = createPublicServer({ readMarket, participationHref: "/" });
  const assets = new Map(
    [
      ["/demo", ["text/html", "index.html"]],
      ["/demo-ui.mjs", ["text/javascript", "ui.mjs"]],
      ["/demo-context.mjs", ["text/javascript", "context.mjs"]],
      ["/demo.css", ["text/css", "style.css"]],
    ].map(([url, [type, file]]) => [
      url,
      { type, bytes: readFileSync(new URL(file, import.meta.url)) },
    ]),
  );
  const state = async () => ({
    scope: "SYNTHETIC_TEST_ONLY",
    financial_authorization: "NOT_GRANTED",
    production_trust: "UNAVAILABLE",
    genuine_payments: false,
    spending_enabled: false,
    market_id: f.mid,
    closes_at: f.configuration.closes_at,
    state: (await readMarket())[0]?.status ?? "UNAVAILABLE",
    simulated_deposit: simulated,
    commitment: locked?.commitment ?? null,
    publication: resolved ? "SYNTHETIC_FIXTURE_ONLY" : "PENDING",
    resolution: resolved ? "SYNTHETIC_SETTLEMENT_PREPARED" : "PENDING",
  });
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (req, res) => {
      const base = `http://127.0.0.1:${req.socket.localPort}`;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      const end = res.end.bind(res);
      res.end = (chunk, ...args) => {
        if (
          chunk &&
          String(res.getHeader("Content-Type")).startsWith("text/html")
        ) {
          const contextScript = ["/", "/claim"].includes(req.url)
            ? '<script type="module" src="/demo-context.mjs"></script>'
            : "";
          chunk = Buffer.from(
            String(chunk).replace(
              "<body>",
              `<body><div class="synthetic-banner" role="note"><strong>SYNTHETIC TEST ONLY — NEVER FUND THESE REQUESTS.</strong> No real payments, publication or payouts. <a href="/demo">Demo controls</a></div><aside><p id="demo-context" role="status">Predeclared close: ${f.configuration.closes_at}. Keep saved attempts unchanged.</p></aside>${contextScript}`,
            ),
          );
        }
        return end(chunk, ...args);
      };
      const send = (code, data, type = "application/json") => {
        res.writeHead(code, { "Content-Type": type + "; charset=utf-8" });
        res.end(
          req.method === "HEAD"
            ? undefined
            : Buffer.isBuffer(data)
              ? data
              : JSON.stringify(data),
        );
      };
      if (
        req.headers.host !== new URL(base).host ||
        typeof req.url !== "string" ||
        /[?#%\\\s]/u.test(req.url)
      )
        return send(400, { error: "DEMO_UNAVAILABLE" });
      const asset = assets.get(req.url);
      if (asset) {
        if (!["GET", "HEAD"].includes(req.method))
          return send(405, { error: "DEMO_UNAVAILABLE" });
        return send(200, asset.bytes, asset.type);
      }
      if (req.url === "/api/demo-status" && req.method === "GET") {
        try {
          return send(200, await state());
        } catch {
          return send(503, { error: "DEMO_UNAVAILABLE" });
        }
      }
      if (req.url === "/api/demo-action") {
        if (req.method !== "POST")
          return send(405, { error: "DEMO_UNAVAILABLE" });
        if (
          req.headers.origin !== base ||
          req.headers["content-type"] !== "application/json" ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return send(403, { error: "DEMO_UNAVAILABLE" });
        if (busy) return send(409, { error: "DEMO_BUSY" });
        busy = true;
        try {
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 256) return send(413, { error: "DEMO_UNAVAILABLE" });
            chunks.push(chunk);
          }
          const body = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
          if (
            !body ||
            Object.keys(body).join() !== "action" ||
            typeof body.action !== "string"
          )
            throw Error();
          if (body.action === "stop") {
            send(200, { status: "STOPPING" });
            setImmediate(stop);
            return;
          }
          if (body.action === "destination")
            return send(200, {
              scope: "PUBLIC_SYNTHETIC_ADDRESS_FIXTURE",
              payout_ua: addresses[3],
            });
          if (body.action === "simulate") {
            if (
              f.tickets.length < 1 ||
              f.tickets.length > 3 ||
              Date.now() <= f.close * 1000 ||
              locked
            )
              throw Error();
            if (!paymentSnapshot) {
              paymentSnapshot = f.payment();
              // This synthetic scan is observed NOW, after the declared close,
              // not at fixture startup. Retain the entire first observation
              // unchanged for retries; never refresh an ambiguous request.
              paymentSnapshot.chain.verified_at = new Date().toISOString();
            }
            await f.watcher.reconcile(0, paymentSnapshot);
            simulated = true;
          } else if (body.action === "lock") {
            if (!simulated) throw Error();
            locked = await finalizeLock(
              f.lockRequest,
              resources,
              f.env("lock"),
            );
          } else if (["YES", "NO", "VOID"].includes(body.action)) {
            if (!locked) throw Error();
            if (selectedOutcome && selectedOutcome !== body.action)
              throw Error();
            selectedOutcome = body.action;
            if (resolved) {
              if (resolved.demo_outcome !== body.action) throw Error();
            } else {
              // Reuse the existing isolated cryptographic fixture. No GitHub,
              // witness, FreeTSA or production trust is contacted/configured.
              await new Promise((r) =>
                setTimeout(
                  r,
                  Math.max(
                    0,
                    Date.parse(locked.commitment.locked_at) + 1100 - Date.now(),
                  ),
                ),
              );
              publicationEvidence ??= await authority.evidence(
                locked.commitment,
              );
              const evidence = publicationEvidence;
              await persistPublication(
                f.mid,
                evidence,
                authority.trust,
                executable,
                f.env("publication"),
                syntheticRetrieval(evidence),
              );
              const request = {
                request_key: "demo_resolution",
                market_id: f.mid,
                expected_revision: locked.revision,
                expected_root: locked.commitment.merkle_root,
                resolution_id: "synthetic_resolution_v1",
                outcome: body.action,
                evidence: ["synthetic-source:objective-observation"],
                rule_version: f.rule.rule_version,
                review: {
                  decision: body.action === "VOID" ? "AMBIGUOUS" : "DEFENSIBLE",
                  source_ref: "synthetic-source",
                  observation_at: f.observation,
                  rationale: "Synthetic objective manual review",
                },
                authorize_entitlements: true,
              };
              await approveResolution(request, f.env("oracle"));
              resolved = {
                ...(await finalizeResolution(
                  request.request_key,
                  f.env("coordinator"),
                )),
                demo_outcome: body.action,
              };
            }
          } else throw Error();
          return send(200, await state());
        } catch {
          return send(409, { error: "DEMO_NOT_CONFIRMED" });
        } finally {
          busy = false;
        }
      }
      if (
        req.url === "/market" ||
        req.url === "/api/market" ||
        req.url === "/market.css"
      ) {
        if (req.url === "/market") req.url = "/";
        return market.emit("request", req, res);
      }
      if (
        req.url === "/claim" ||
        req.url.startsWith("/api/claim") ||
        ["/claim-ui.mjs", "/claim-client.mjs", "/claim-wire.mjs"].includes(
          req.url,
        )
      )
        return claims.emit("request", req, res);
      return issuer.emit("request", req, res);
    },
  );
  return { server, state, paymentStatus };
}

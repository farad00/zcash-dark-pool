// Small internal composition seam, no HTTP-selected callbacks or signing capability.
import {
  createIssuer,
  allocateInternal,
} from "../../apps/web/src/issuance.mjs";
import { createIssuanceServer } from "../../apps/web/src/issuance-server.mjs";
import { createPublicServer } from "../../apps/web/src/public-server.mjs";
import { createCoordinator, createWalletProcess } from "../watcher/main.mjs";
import { createWatcherDb } from "../watcher/db.mjs";
import { createParticipantStatus } from "./status.mjs";
import { createGenuineQuery, publicMarketQuery } from "./query.mjs";
import {
  proposedTarget,
  validateTarget,
  nativeEnvironment,
  assertNativeActivation,
  reject,
} from "./target.mjs";
import { win32 } from "node:path";
import { createServer } from "node:http";

// Internal dependency capabilities supplied by trusted startup, never request JSON.
export function composeDeposit({
  issueQuery,
  allocate,
  db,
  wallet,
  stopFile,
  statusQuery,
  readMarket,
  environment,
}) {
  if (
    !["DISPOSABLE_TEST", "TESTNET_OBSERVATION"].includes(environment) ||
    ![issueQuery, allocate, statusQuery, readMarket].every(
      (v) => typeof v === "function",
    )
  )
    reject();
  const issue = createIssuer({ query: issueQuery, allocate });
  const paymentStatus = createParticipantStatus(statusQuery, environment);
  const coordinator = createCoordinator({ db, wallet, stopFile });
  const issuer = createIssuanceServer({ issue, paymentStatus });
  const market = createPublicServer({ readMarket, participationHref: "/" });
  // Same origin; reuse each router's guards and never expose operator controls.
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    (req, res) => {
      if (
        req.url === "/market" ||
        req.url === "/api/market" ||
        req.url === "/market.css"
      ) {
        if (req.url === "/market") req.url = "/";
        return market.emit("request", req, res);
      }
      return issuer.emit("request", req, res);
    },
  );
  let cycling = false,
    closed = false;
  return Object.freeze({
    server,
    issue,
    paymentStatus,
    async cycle() {
      if (cycling || closed) reject();
      cycling = true;
      try {
        return await coordinator.cycle();
      } finally {
        cycling = false;
      }
    },
    spending_enabled: false,
    financial_authorization: "NOT_GRANTED",
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      if (server.listening) await new Promise((r) => server.close(r));
      await wallet.close?.();
    },
  });
}

export async function openGenuineDeposit({
  target = proposedTarget(),
  connections,
  allocator,
}) {
  validateTarget(target);
  // No genuine profile, credential or wallet is read until separately approved.
  // This still fails closed under the existing persistent/native launch policy.
  assertNativeActivation(target);
  const issueQuery = createGenuineQuery(connections.issue, "issue");
  const watchQuery = createGenuineQuery(connections.watch, "watch");
  const statusQuery = createGenuineQuery(connections.status, "status");
  const readQuery = createGenuineQuery(connections.read, "read");
  const db = createWatcherDb({}, (statement) => watchQuery(statement));
  await db.context();
  const native = nativeEnvironment(target, "allocation", allocator);
  // Allocator is an explicitly started private native process. This adapter
  // never starts it, imports a key, or runs wallet initialization.
  const os = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key),
    ),
  );
  const source = createWalletProcess({
    ...os,
    ...nativeEnvironment(target, "scan"),
  });
  try {
    return composeDeposit({
      issueQuery,
      allocate: (c) => allocateInternal(c, native),
      db,
      wallet: source,
      stopFile: win32.join(target.root, "evidence", "watcher-stop.json"),
      statusQuery,
      readMarket: () => readQuery(publicMarketQuery),
      environment: "TESTNET_OBSERVATION",
    });
  } catch {
    await source.close();
    reject();
  }
}

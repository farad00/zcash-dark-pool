// Issuer-only composition: deliberately no watcher/coordinator/signer imports.
import { createServer } from "node:http";
import { win32 } from "node:path";
import {
  createIssuer,
  allocateInternal,
} from "../../apps/web/src/issuance.mjs";
import { createIssuanceServer } from "../../apps/web/src/issuance-server.mjs";
import { createPublicServer } from "../../apps/web/src/public-server.mjs";
import { createParticipantStatus } from "./status.mjs";
import { createGenuineQuery, publicMarketQuery } from "./query.mjs";
import { nativeEnvironment, proposedTarget, reject } from "./target.mjs";
import { layout, readJson, assertUnfundedLaunch, sha256 } from "./unfunded.mjs";
import {
  readClusterProfile,
  validateIdentityProfile,
} from "../../db/environment-identity.mjs";
import { resolveUnfundedTool } from "./unfunded-tools.mjs";

export function assertReadyMarket(markets, binding, now = Date.now()) {
  if (
    !Array.isArray(markets) ||
    markets.length !== 1 ||
    markets[0].market_id !== binding.market_id ||
    markets[0].status !== "OPEN" ||
    !Number.isFinite(Date.parse(markets[0].closes_at)) ||
    Date.parse(markets[0].closes_at) <= now
  )
    reject();
}

export function composeUnfundedIssuer({
  issueQuery,
  allocate,
  statusQuery,
  readMarket,
  verify,
  environment,
}) {
  if (
    ![issueQuery, allocate, statusQuery, readMarket, verify].every(
      (v) => typeof v === "function",
    ) ||
    !["DISPOSABLE_TEST", "TESTNET_OBSERVATION"].includes(environment)
  )
    reject();
  let closed = false;
  const check = async () => {
    if (closed) reject();
    await verify();
  };
  const underlying = createIssuer({ query: issueQuery, allocate });
  const issue = async (r) => {
    await check();
    return underlying(r);
  };
  const status = createParticipantStatus(statusQuery, environment);
  const paymentStatus = async (r) => {
    await check();
    return status(r);
  };
  const issuer = createIssuanceServer({
    issue,
    paymentStatus,
    unfundedOnly: true,
  });
  const market = createPublicServer({
    readMarket: async () => {
      await check();
      return readMarket();
    },
    participationHref: "/",
  });
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    (req, res) => {
      if (["/market", "/api/market", "/market.css"].includes(req.url)) {
        if (req.url === "/market") req.url = "/";
        return market.emit("request", req, res);
      }
      // No demo/admin/claim endpoint is mounted by this router.
      return issuer.emit("request", req, res);
    },
  );
  return Object.freeze({
    server,
    issue,
    paymentStatus,
    acceptance_enabled: false,
    spending_enabled: false,
    financial_authorization: "NOT_GRANTED",
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      if (server.listening) await new Promise((r) => server.close(r));
    },
  });
}

export async function openUnfundedIssuer({ connections, allocator, actorSid }) {
  // No caller-supplied filesystem paths or alternative native activation flag.
  const paths = layout();
  const verify = async () => {
    const approval = await readJson(paths.approval);
    const profile = await readClusterProfile(paths, (p) => {
      validateIdentityProfile(p, paths, "TESTNET_OBSERVATION");
    });
    const receipt = await readJson(paths.receipt);
    const completion = await readJson(
      win32.join(paths.root, "bootstrap-completed.json"),
    );
    assertUnfundedLaunch({
      approval,
      profile,
      receipt,
      completion,
      actorSid,
      purpose: "issuer",
    });
    const market = await readJson(win32.join(paths.root, "market-opened.json"));
    if (
      market.scope !== approval.scope ||
      market.marker !== receipt.marker ||
      market.approval_sha256 !== sha256(JSON.stringify(approval)) ||
      market.market_id !== allocator.ALLOCATION_MARKET_ID ||
      market.vault_context_ref !== allocator.ALLOCATION_VAULT_CONTEXT
    )
      reject();
    return market;
  };
  const binding = await verify(); // Before reading connection credentials or contacting allocator.
  if (
    Object.keys(connections).sort().join() !==
    ["issue", "status", "read"].sort().join()
  )
    reject();
  const issueQuery = createGenuineQuery(
    connections.issue,
    "issue",
    resolveUnfundedTool,
  );
  const statusQuery = createGenuineQuery(
    connections.status,
    "status",
    resolveUnfundedTool,
  );
  const readQuery = createGenuineQuery(
    connections.read,
    "read",
    resolveUnfundedTool,
  );
  const native = nativeEnvironment(proposedTarget(), "allocation", allocator);
  // Startup proves all three purpose sessions before advertising readiness.
  // These probes allocate/reserve nothing and cannot accept a payment.
  assertReadyMarket(await readQuery(publicMarketQuery), binding);
  for (const query of [issueQuery, statusQuery]) {
    const r = await query("SELECT json_build_object('ready',true);");
    if (r?.ready !== true) reject();
  }
  await verify();
  // No wallet child, scanner, cycle(), reconciliation, financial sessions or imports.
  return composeUnfundedIssuer({
    issueQuery,
    statusQuery,
    verify,
    allocate: (c) => allocateInternal(c, native),
    readMarket: () => readQuery(publicMarketQuery),
    environment: "TESTNET_OBSERVATION",
  });
}

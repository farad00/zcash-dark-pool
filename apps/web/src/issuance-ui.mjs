import { openLocalVault } from "./local-vault.mjs";
import { openIssuanceClient } from "./issuance-client.mjs";
import { paymentStatusText } from "./payment-status-wire.mjs";
import {
  createPaymentPanel,
  paymentContext,
  preparePaymentRequest,
} from "./payment-ui.mjs";
const document = globalThis.document;
const message = document.getElementById("message"),
  list = document.getElementById("records");
const panel = createPaymentPanel(document.getElementById("payment"));
const statuses = new Map(); // Display only; never persisted as acceptance evidence.
const statusErrors = new Set();
const newDrafts = new Set();
let activePayment;
globalThis.addEventListener("pagehide", () => panel.clear());
async function present(payment, localId) {
  activePayment = localId;
  panel.clear();
  // Never keep the chosen side or identifiers in hidden controls during payment.
  for (const id of ["side", "market", "amount"])
    document.getElementById(id).value = "";
  document.getElementById("selection").hidden = true;
  try {
    panel.show(await preparePaymentRequest(payment));
    message.textContent =
      "Issuance saved. Payment request prepared; payment status is not checked.";
  } catch {
    panel.show({ ...paymentContext(payment), uri: undefined }, () =>
      work(() => present(payment, localId)),
    );
    message.textContent = "Issuance saved. Payment preparation can be retried.";
  }
  if (statuses.has(localId)) panel.updateStatus(statuses.get(localId));
}
let vault,
  client,
  publishedMarket,
  busy = false,
  renderGeneration = 0;
async function work(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  try {
    await action();
    await render();
  } catch (error) {
    message.textContent =
      error.message === "ISSUANCE_CONFLICT"
        ? "Issuance conflict. Keep this draft and its pending attempt; immutable choices cannot change."
        : "Issuance or local storage could not complete safely. Keep this browser data and retry the same attempt. Payment status is not checked.";
    // A direct issuance failure must expose its preserved draft/retry control.
    try {
      await render();
    } catch {
      /* Preserve invalid storage for review. */
    }
  } finally {
    busy = false;
    for (const button of document.querySelectorAll("button"))
      button.disabled = false;
  }
}
async function render() {
  const generation = ++renderGeneration;
  const records = await vault.list();
  const fragment = document.createDocumentFragment(),
    saved = document.createDocumentFragment();
  for (const record of records) {
    const attempt = await client.savedSelection(record.local_id);
    const marketId = record.market_id ?? attempt?.market_id;
    const current = publishedMarket && marketId === publishedMarket.market_id;
    const older =
      publishedMarket && !current && !newDrafts.has(record.local_id);
    const item = document.createElement("li"),
      text = document.createElement("p");
    item.dataset.localId = String(record.local_id);
    item.dataset.marketScope = older ? "saved" : current ? "current" : "draft";
    text.textContent =
      record.state === "DRAFT"
        ? `${marketId ? (current ? "Current-market saved attempt" : "Saved attempt for another market") : "Unassigned local draft"}. No completed ticket; preserve its original credential.`
        : `${current ? "Current-market ticket" : "Saved ticket"} ${record.ticket_id.slice(0, 12)}… · ${record.market_id}.`;
    item.append(text);
    const issue = document.createElement("button");
    issue.type = "button";
    issue.textContent =
      record.state === "DRAFT"
        ? attempt
          ? "Retry saved attempt"
          : "Issue this draft"
        : "Recover same issuance";
    issue.addEventListener("click", () =>
      work(async () => {
        panel.clear();
        const result = await client.issue(
          record.local_id,
          record.state === "DRAFT" && !attempt
            ? {
                market_id: document.getElementById("market").value,
                side: document.getElementById("side").value,
                requested_amount_zat: document.getElementById("amount").value,
              }
            : undefined,
        );
        await present(result.payment, record.local_id);
      }),
    );
    item.append(issue);
    if (record.state !== "DRAFT") {
      const status = document.createElement("p");
      status.dataset.ticketStatus = String(record.local_id);
      status.setAttribute("role", "status");
      status.textContent = statusErrors.has(record.local_id)
        ? "Payment status unavailable. Acceptance must not be assumed; retry the private check."
        : statuses.has(record.local_id)
          ? `Payment status: ${statuses.get(record.local_id).status}. ${paymentStatusText(statuses.get(record.local_id))}`
          : "Payment status not checked. Refresh privately using this issuing browser.";
      status.dataset.paymentStatus = statusErrors.has(record.local_id)
        ? "UNAVAILABLE"
        : (statuses.get(record.local_id)?.status ?? "UNCHECKED");
      item.append(status);
      const check = document.createElement("button");
      check.type = "button";
      check.textContent = "Check private payment status";
      check.dataset.action = "payment-status";
      check.addEventListener("click", () =>
        work(async () => {
          try {
            const result = await client.paymentStatus(record.local_id);
            statusErrors.delete(record.local_id);
            statuses.set(record.local_id, result);
            message.textContent = `Payment status: ${result.status}. ${paymentStatusText(result)}`;
            if (activePayment === record.local_id) panel.updateStatus(result);
          } catch {
            message.textContent =
              "Private payment status unavailable. Use the original issuing browser; do not assume acceptance or claim eligibility.";
            statusErrors.add(record.local_id);
            statuses.delete(record.local_id);
            if (activePayment === record.local_id) panel.markUnavailable();
          }
        }),
      );
      item.append(check);
    }
    if (record.state === "DRAFT" && !attempt) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry saved attempt";
      retry.addEventListener("click", () =>
        work(async () => {
          panel.clear();
          const result = await client.issue(record.local_id);
          await present(result.payment, record.local_id);
        }),
      );
      item.append(retry);
    }
    (older ? saved : fragment).append(item);
  }
  // Keep existing recovery controls until the full replacement is ready.
  if (generation !== renderGeneration) return;
  for (const fragmentRoot of [fragment, saved])
    for (const button of fragmentRoot.querySelectorAll("button"))
      button.disabled = busy;
  list.replaceChildren(fragment);
  document.getElementById("saved-records").replaceChildren(saved);
  document.getElementById("saved-records-context").hidden =
    !document.getElementById("saved-records").children.length;
}
try {
  vault = await openLocalVault();
  client = await openIssuanceClient(vault);
  await render();
  const create = document.getElementById("create");
  create.disabled = false;
  create.addEventListener("click", () =>
    work(async () => {
      newDrafts.add(await vault.createDraft());
      panel.clear();
      document.getElementById("selection").hidden = false;
      message.textContent =
        "Original secret saved locally. Choose a side and intended stake for this independent ticket.";
    }),
  );
  const participate = document.getElementById("participate");
  participate.disabled = false;
  participate.addEventListener("click", () =>
    work(async () => {
      const selection = {
        market_id: document.getElementById("market").value,
        side: document.getElementById("side").value,
        requested_amount_zat: document.getElementById("amount").value,
      };
      if (
        !selection.market_id ||
        !["YES", "NO"].includes(selection.side) ||
        !/^[1-9][0-9]{0,15}$/.test(selection.requested_amount_zat)
      )
        throw Error();
      const id = await vault.createDraft();
      newDrafts.add(id);
      const result = await client.issue(id, selection);
      await present(result.payment, id);
    }),
  );
  const next = document.getElementById("new-prediction");
  next.disabled = false;
  next.addEventListener("click", () =>
    work(async () => {
      panel.clear();
      document.getElementById("selection").hidden = false;
      document.getElementById("side").value = "";
      document.getElementById("amount").value = "";
      if (publishedMarket && !document.getElementById("market").value) {
        document.getElementById("market").value = publishedMarket.market_id;
        document.getElementById("market").readOnly = true;
      }
      message.textContent =
        "Choose a side and stake, then Issue prediction. No new draft has been created yet.";
    }),
  );
  // Public market fields only. No ticket/secret/portfolio is uploaded for discovery.
  void fetch("/api/market", {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  })
    .then(async (r) => {
      if (!r.ok) return;
      const { market } = await r.json();
      if (
        !market ||
        market.network !== "testnet" ||
        typeof market.market_id !== "string" ||
        typeof market.question !== "string" ||
        typeof market.closes_at !== "string"
      )
        return;
      publishedMarket = market;
      const input = document.getElementById("market");
      if (!input.value && !document.getElementById("selection").hidden) {
        input.value = market.market_id;
        input.readOnly = true;
      }
      document.getElementById("market-context").textContent =
        `${market.question} — ${market.status}. Predeclared close: ${market.closes_at}. Server rules determine issuance eligibility.`;
      await render();
    })
    .catch(() => {});
  message.textContent =
    "Local vault ready. Only one issuance attempt is sent at a time; claim secrets stay on this browser.";
} catch {
  message.textContent =
    "Local storage is unavailable or invalid. Existing data has not been reset. Keep this browser data.";
}

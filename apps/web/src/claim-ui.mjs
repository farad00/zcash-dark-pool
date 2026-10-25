import { openLocalVault } from "./local-vault.mjs";
import { BACKUP_MAX_BYTES } from "./ticket-backup.mjs";
import { privatePost, submitTicket } from "./claim-client.mjs";
import { payoutText } from "./claim-wire.mjs";

export async function mountClaim(document) {
  const el = (id) => document.getElementById(id),
    message = el("message"),
    select = el("ticket"),
    address = el("address");
  let vault,
    busy = false,
    reviewed = null,
    market = null;
  const invalidate = () => {
    reviewed = null;
    el("review").hidden = true;
    el("submit").disabled = true;
  };
  const eligibility = () => {
    const option = select.selectedOptions[0];
    el("eligibility").textContent =
      !market || !["PAYING", "REFUNDING"].includes(market.state)
        ? "Claims pending or unavailable. A valid lock, verified publication and authorized resolution are required."
        : !select.value
          ? "Select your ticket. Individual eligibility is checked privately on submission."
          : option?.dataset.marketId !== market.market_id
            ? "This saved ticket belongs to another market. It cannot be claimed in the current market."
            : "Market ready for private claims. This does not yet verify your ticket's entitlement.";
  };
  const work = async (fn) => {
    if (busy) return;
    busy = true;
    for (const id of [
      "import",
      "check",
      "submit",
      "ticket",
      "address",
      "backup",
      "refresh-market",
    ])
      el(id).disabled = true;
    try {
      await fn();
    } catch {
      message.textContent =
        "Request not confirmed. Eligibility or destination could not be verified. If you submitted, retain the same ticket and address for retry; no payment is confirmed.";
    } finally {
      busy = false;
      for (const id of [
        "import",
        "check",
        "ticket",
        "address",
        "backup",
        "refresh-market",
      ])
        el(id).disabled = false;
      el("submit").disabled = !reviewed;
    }
  };
  async function tickets() {
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a saved ticket";
    select.append(placeholder);
    for (const record of await vault.list())
      if (
        record.state === "FINALIZED" &&
        (await vault.canExport(record.local_id))
      ) {
        const option = document.createElement("option");
        option.value = String(record.local_id);
        option.dataset.marketId = record.market_id;
        option.textContent = `${record.market_id} · ticket ${record.ticket_id.slice(0, 12)}…`;
        select.append(option);
      }
    invalidate();
    eligibility();
  }
  async function refreshMarket() {
    invalidate();
    market = null;
    try {
      const r = await fetch("/api/claim-market", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (!r.ok) throw new Error();
      const status = await r.json();
      const candidate = status.market;
      if (
        candidate &&
        typeof candidate.market_id === "string" &&
        typeof candidate.question === "string" &&
        typeof candidate.state === "string"
      ) {
        el("market-status").textContent =
          `${candidate.question} — ${candidate.state}. ${["PAYING", "REFUNDING"].includes(candidate.state) ? "Individual eligibility is checked privately on submission." : "Claims pending or unavailable."} ${status.environment}.`;
        if (status.claims === "CHECKED_ON_SUBMISSION") market = candidate;
      } else
        el("market-status").textContent =
          "Market unavailable; claims unavailable.";
    } catch {
      el("market-status").textContent =
        "Market unavailable; claims unavailable.";
    }
    eligibility();
  }
  try {
    vault = await openLocalVault();
    await tickets();
    select.addEventListener("change", () => {
      invalidate();
      el("claim-result").hidden = true;
      eligibility();
    });
    address.addEventListener("input", invalidate);
    el("import").addEventListener("click", () =>
      work(async () => {
        let bytes;
        try {
          const file = el("backup").files?.[0];
          if (!file || file.size > BACKUP_MAX_BYTES) throw new Error();
          bytes = new Uint8Array(await file.arrayBuffer());
          await vault.importBackup(bytes);
          await tickets();
          message.textContent =
            "Ticket imported locally. Import does not prove claim eligibility.";
        } finally {
          bytes?.fill(0);
          el("backup").value = "";
        }
      }),
    );
    el("check").addEventListener("click", () =>
      work(async () => {
        invalidate();
        await refreshMarket();
        const localId = Number(select.value),
          ua = payoutText(address.value);
        const ticket = (await vault.list()).find(
          (t) => t.local_id === localId && t.state === "FINALIZED",
        );
        if (
          !ticket ||
          !market ||
          market.market_id !== ticket.market_id ||
          !["PAYING", "REFUNDING"].includes(market.state)
        )
          throw new Error();
        if (
          (await privatePost("/api/claim-address", { payout_ua: ua })).valid !==
          true
        )
          throw new Error();
        reviewed = { localId, ua };
        el("review-text").textContent =
          `Market: ${ticket.market_id}. Ticket: ${ticket.ticket_id}. Send the claim credential privately to this operator and reserve payment to: ${ua}. Eligibility is checked by the server. This does not send a payment.`;
        el("review").hidden = false;
        message.textContent =
          "Review the full destination before confirming. Use the same address for retries.";
      }),
    );
    el("submit").addEventListener("click", () =>
      work(async () => {
        const request = reviewed;
        invalidate();
        if (!request) throw new Error();
        const result = await submitTicket(vault, request.localId, request.ua);
        message.textContent = `${result.environment === "SYNTHETIC_TEST_ONLY" ? "SYNTHETIC TEST ONLY. " : ""}Claim ${result.status.toLowerCase()}. Payment has NOT been sent or confirmed.`;
        el("claim-result").hidden = false;
        el("claim-result").dataset.claimStatus = result.status;
        el("claim-result").textContent =
          result.status === "PREPARED"
            ? "PREPARED · An unsent payout instruction is retained. No transaction has been signed, broadcast or paid. Keep this ticket and use the same destination for any retry."
            : "RESERVED · Your claim is retained for preparation. No payment has been sent or confirmed. Use the same destination for retries.";
      }),
    );
    el("refresh-market").addEventListener("click", () => work(refreshMarket));
    await refreshMarket();
    message.textContent =
      "Select a saved ticket or import its original backup. Your secret is sent only when you confirm the claim.";
    for (const id of [
      "import",
      "check",
      "ticket",
      "address",
      "backup",
      "refresh-market",
    ])
      el(id).disabled = false;
    globalThis.addEventListener?.("pagehide", () => vault.close(), {
      once: true,
    });
    return vault;
  } catch {
    vault?.close();
    message.textContent =
      "Local ticket storage unavailable. Existing data has not been reset.";
  }
}
if (globalThis.document) void mountClaim(globalThis.document);

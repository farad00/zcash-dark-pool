// Participant-only presentation. No credential imports or persistence.
import { formatZatoshi } from "./money.js";
import {
  paymentStatusResult,
  paymentStatusText,
} from "./payment-status-wire.mjs";
const unavailable = () => {
  throw new Error("PAYMENT_REQUEST_UNAVAILABLE");
};
const max = 2100000000000000n;

export function paymentContext(value) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "closes_at,receiving_ua,requested_amount_zat" ||
    typeof value.receiving_ua !== "string" ||
    value.receiving_ua.length > 1024 ||
    !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(value.receiving_ua) ||
    typeof value.requested_amount_zat !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(value.requested_amount_zat) ||
    BigInt(value.requested_amount_zat) > max ||
    typeof value.closes_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.closes_at)
  )
    unavailable();
  const ms = value.closes_at.slice(0, 23) + "Z",
    time = Date.parse(ms);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== ms)
    unavailable();
  const amount = formatZatoshi(BigInt(value.requested_amount_zat));
  const decimal = amount.replace(/0+$/, "").replace(/\.$/, "");
  return Object.freeze({
    ...value,
    amount,
    // Date.now has millisecond precision. Use the first browser tick at/after
    // the exact published microsecond instant; this is presentation only.
    close_time_ms: time + (value.closes_at.slice(23, 26) === "000" ? 0 : 1),
    uri: `zcash:${value.receiving_ua}?amount=${decimal}`,
  });
}

export async function preparePaymentRequest(value) {
  const context = paymentContext(value);
  try {
    const response = await globalThis.fetch("/api/payment-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({
        receiving_ua: context.receiving_ua,
        requested_amount_zat: context.requested_amount_zat,
      }),
    });
    if (!response.ok) unavailable();
    const result = await response.json();
    if (
      !result ||
      Object.keys(result).sort().join(",") !==
        "network,payment_request_profile_version,payment_uri" ||
      result.network !== "testnet" ||
      result.payment_request_profile_version !== 1 ||
      result.payment_uri !== context.uri
    )
      unavailable();
    return context;
  } catch {
    unavailable();
  }
}

export function createPaymentPanel(root) {
  const document = root.ownerDocument;
  let timer,
    generation = 0,
    heading,
    verification,
    activity;
  function clear() {
    generation++;
    globalThis.clearInterval(timer);
    root.replaceChildren();
    root.hidden = true;
    delete root.dataset.paymentStatus;
    heading = verification = activity = null;
  }
  const text = (tag, content) => {
    const node = document.createElement(tag);
    node.textContent = content;
    return node;
  };
  function show(context, retry) {
    clear();
    root.hidden = false;
    heading = text("h2", "Ticket issued — payment status not checked");
    root.append(heading);
    root.append(
      text(
        "p",
        `Published close: ${context.closes_at.replace("T", " ").replace("Z", " UTC")}`,
      ),
    );
    activity = document.createElement("div");
    verification = text("p", "Awaiting payment verification");
    verification.setAttribute("role", "status");
    const status = text("p", "");
    status.setAttribute("role", "status");
    root.append(
      activity,
      verification,
      text(
        "p",
        "Use Check private payment status on your saved ticket for the latest available watcher result. A wallet send alone does not establish acceptance. Keep the original browser and ticket backup.",
      ),
      status,
    );
    const expired = () => Date.now() >= context.close_time_ms;
    const expire = () => {
      activity.replaceChildren(
        text(
          "p",
          "The published closing time has passed. Your credential remains stored. Check private payment status below; the deadline alone does not establish acceptance.",
        ),
      );
      status.textContent = "";
      globalThis.clearInterval(timer);
    };
    if (expired()) {
      expire();
      return;
    }
    if (!context.uri) {
      activity.append(
        text(
          "p",
          "Payment preparation could not complete. Your issued credential remains stored. Retry payment preparation; keep this browser data.",
        ),
      );
      const button = text("button", "Retry payment preparation");
      button.type = "button";
      button.addEventListener("click", retry);
      activity.append(button);
    } else {
      activity.append(
        text(
          "p",
          `Send exactly ${context.amount} ZEC on Zcash testnet to the displayed destination. Use shielded funds. Leave the memo empty. Wallet fees are additional.`,
        ),
      );
      activity.append(
        text("h3", "Receiving destination"),
        text("p", context.receiving_ua),
        text("h3", "Payment request"),
      );
      const request = text("p", context.uri);
      request.className = "payment-request";
      activity.append(
        request,
        text(
          "p",
          "Preserve your individual ticket backup before sending. The clipboard contains the requested amount and receiving destination; clipboard history or synchronization may expose them.",
        ),
      );
      const button = text("button", "Copy payment request");
      button.type = "button";
      button.addEventListener("click", async () => {
        if (expired()) {
          expire();
          return;
        }
        const current = generation;
        button.disabled = true;
        try {
          await globalThis.navigator.clipboard.writeText(context.uri);
          if (current === generation && !expired())
            status.textContent = "Payment request copied.";
        } catch {
          if (current === generation && !expired())
            status.textContent =
              "Clipboard unavailable. Select and copy the payment request text.";
        } finally {
          if (current === generation) {
            if (expired()) expire();
            else button.disabled = false;
          }
        }
      });
      activity.append(button);
    }
    timer = globalThis.setInterval(() => {
      if (expired()) expire();
    }, 250);
  }
  function updateStatus(value) {
    const result = paymentStatusResult(value);
    if (!heading || root.hidden) return;
    heading.textContent = `Payment status: ${result.status}`;
    verification.textContent = paymentStatusText(result);
    if (result.status === "CONFIRMED") {
      globalThis.clearInterval(timer);
      activity.replaceChildren(
        text(
          "p",
          "Accepted. Do not send another payment. Keep your ticket backup; claim eligibility is checked separately after resolution.",
        ),
      );
    } else if (root.dataset.paymentStatus === "CONFIRMED") {
      activity.replaceChildren(
        text(
          "p",
          "Acceptance is no longer confirmed by the latest check. Keep your credential and wait for verification; do not send another payment.",
        ),
      );
    }
    root.dataset.paymentStatus = result.status;
  }
  function markUnavailable() {
    if (!heading || root.hidden) return;
    heading.textContent = "Payment status unavailable";
    verification.textContent =
      "The latest private check failed. Acceptance must not be assumed. Preserve your ticket and retry the status check.";
    globalThis.clearInterval(timer);
    activity.replaceChildren();
    root.dataset.paymentStatus = "UNAVAILABLE";
  }
  return Object.freeze({ clear, show, updateStatus, markUnavailable });
}

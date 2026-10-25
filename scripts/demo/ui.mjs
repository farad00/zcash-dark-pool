let current;
const el = (id) => document.getElementById(id);
let busy = false,
  stopped = false;
function controls() {
  const closed = current && Date.now() > Date.parse(current.closes_at);
  const readyToClaim =
    current && ["PAYING", "REFUNDING"].includes(current.state);
  const reasons = {
    simulate: !current
      ? "Wait for demo status."
      : current.commitment
        ? "Ledger already locked; deposits cannot change."
        : !closed
          ? "Wait for the original close, after issuing one to three tickets."
          : "Simulate deposits for one to three already-issued tickets.",
    lock:
      !current?.simulated_deposit && !current?.commitment
        ? "Simulate accepted deposits first."
        : current.commitment
          ? "Retry verifies the same immutable commitment."
          : "Seal the accepted ledger; no later additions.",
    YES: "Lock the accepted ledger first.",
    NO: "Lock the accepted ledger first.",
    VOID: "Lock the accepted ledger first.",
  };
  const allowed = {
    simulate: current && closed && !current.commitment,
    lock: current?.simulated_deposit || current?.commitment,
    YES: current?.commitment && current.resolution === "PENDING",
    NO: current?.commitment && current.resolution === "PENDING",
    VOID: current?.commitment && current.resolution === "PENDING",
    destination: !!current,
    stop: true,
  };
  document.querySelectorAll("button[data-action]").forEach((b) => {
    const action = b.dataset.action;
    b.disabled = busy || stopped || !allowed[action];
    b.title =
      ["YES", "NO", "VOID"].includes(action) && current?.commitment
        ? readyToClaim
          ? "Resolution is already retained; it cannot be changed."
          : "Choose the frozen oracle outcome once."
        : (reasons[action] ?? "");
  });
  el("next-action").textContent = !current
    ? "Wait for the demo connection."
    : readyToClaim
      ? "Next: open Private claim, refresh eligibility, select your ticket and prepare an unsent payout intent."
      : current.commitment
        ? "Next: resolve YES, NO or VOID using the synthetic oracle evidence. The first outcome is immutable."
        : current.simulated_deposit
          ? "Next: check private ticket status, then Lock accepted ledger."
          : closed
            ? "Next: simulate deposits for your already-issued tickets. If none were issued, start a fresh demo; do not reopen this market."
            : "Next: open My predictions, choose YES/NO and stake, then Issue prediction. Return after the predeclared close to simulate deposits.";
  el("simulate-help").textContent = reasons.simulate;
  el("lock-help").textContent = reasons.lock;
}
async function refresh() {
  const response = await fetch("/api/demo-status", {
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) throw Error();
  current = await response.json();
  el("connection").textContent = "Connected to disposable TEST demo.";
  el("market").value = current.market_id;
  el("close").textContent = current.closes_at;
  el("countdown").textContent =
    `${Math.max(0, Math.ceil((Date.parse(current.closes_at) - Date.now()) / 1000))} seconds remaining.`;
  el("root").textContent = current.commitment
    ? JSON.stringify(current.commitment, null, 2)
    : "Not locked";
  el("summary").textContent =
    `${current.state}\nPublication: ${current.publication}\nResolution: ${current.resolution}\nFinancial authorization: ${current.financial_authorization}\nSpending: DISABLED`;
  controls();
}
const actions = new Set([
  "simulate",
  "lock",
  "YES",
  "NO",
  "VOID",
  "destination",
  "stop",
]);
// Delegate from the document so refreshed/replaced button nodes retain dispatch.
document.addEventListener("click", async (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("button[data-action]")
      : null;
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (!actions.has(action)) return;
  event.preventDefault();
  busy = true;
  controls();
  el("status").dataset.lastAction = action;
  el("status").dataset.actionState = "SENDING";
  el("status").textContent = `Sending ${action}. Wait for confirmation.`;
  let httpStatus;
  try {
    const response = await fetch("/api/demo-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ action }),
    });
    httpStatus = response.status;
    if (!response.ok) throw Error();
    const result = await response.json();
    if (action === "stop") {
      el("status").dataset.actionState = "COMPLETE";
      stopped = true;
      el("status").textContent =
        "Stopping. Verify cleanup PASS in the terminal.";
      clearInterval(timer);
      return;
    }
    if (action === "destination") el("destination").value = result.payout_ua;
    const messages = {
      simulate:
        "Simulated deposits accepted. Check CONFIRMED on each private ticket, then lock the ledger.",
      lock: "Immutable ledger locked. The accepted count and root are shown below; next choose the oracle outcome.",
      YES: "YES resolution retained. Eligible tickets can now prepare claims; no payout is sent.",
      NO: "NO resolution retained. Eligible tickets can now prepare claims or no-winner refunds; no payout is sent.",
      VOID: "VOID resolution retained. Eligible accepted tickets can prepare refunds; no payout is sent.",
      destination:
        "Public synthetic destination shown. Use it only in this synthetic claim demonstration.",
    };
    el("status").textContent =
      `SYNTHETIC TEST ONLY. ${messages[action]} No real payment sent.`;
    await refresh();
    el("status").dataset.actionState = "COMPLETE";
  } catch {
    el("status").dataset.actionState = "NOT_CONFIRMED";
    el("status").textContent =
      `${action} not confirmed${httpStatus ? ` (HTTP ${httpStatus})` : ""}. Check that one to three tickets were issued, the original close has passed, and lifecycle steps are in order. Do not assume success or change an outcome.`;
  } finally {
    busy = false;
    controls();
  }
});
const timer = setInterval(
  () =>
    void refresh().catch(() => {
      current = null;
      controls();
      el("connection").textContent =
        "Demo unavailable. Check the terminal; no action result is assumed.";
    }),
  3000,
);
void refresh()
  .then(() => {
    el("status").textContent = "Ready. Follow the numbered steps.";
    el("connection").textContent = "Connected to disposable TEST demo.";
  })
  .catch(() => (el("status").textContent = "Demo unavailable."));
controls();
globalThis.addEventListener("pagehide", () => clearInterval(timer), {
  once: true,
});

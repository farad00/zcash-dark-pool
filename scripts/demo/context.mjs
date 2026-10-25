// Demo-only public context. Never reads or edits the vault or pending attempts.
let state;
function show() {
  const note = document.getElementById("demo-context");
  if (!note || !state) return;
  const remaining = Math.max(
    0,
    Math.ceil((Date.parse(state.closes_at) - Date.now()) / 1000),
  );
  note.textContent = `Market ${state.market_id}. Predeclared close: ${state.closes_at}. ${remaining > 0 && state.state === "OPEN" ? `${remaining} seconds remaining for new issuance.` : "New issuance is CLOSED. Do not change the old market or saved attempt. Only already-completed issuance can be recovered after close."} This countdown is a display; the server enforces eligibility.`;
  const market = document.getElementById("market");
  const selection = document.getElementById("selection");
  // The existing payment UI deliberately clears/hides identifiers. Do not
  // repopulate its hidden controls or overwrite a participant's existing input.
  if (market && selection && !selection.hidden && market.value === "") {
    market.value = state.market_id;
    market.readOnly = true;
  }
}
async function refresh() {
  try {
    const r = await fetch("/api/demo-status", {
      cache: "no-store",
      credentials: "omit",
    });
    if (!r.ok) throw Error();
    const value = await r.json();
    if (
      value.scope !== "SYNTHETIC_TEST_ONLY" ||
      value.financial_authorization !== "NOT_GRANTED"
    )
      throw Error();
    state = value;
    show();
  } catch {
    const note = document.getElementById("demo-context");
    if (note)
      note.textContent =
        "Demo unavailable. Keep existing browser data; do not assume issuance succeeded.";
  }
}
const selection = document.getElementById("selection");
if (selection)
  new MutationObserver(show).observe(selection, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
const timer = setInterval(() => void refresh(), 2000);
addEventListener("pagehide", () => clearInterval(timer), { once: true });
void refresh();

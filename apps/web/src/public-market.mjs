import { MARKET_STATUSES } from "../../../packages/protocol/dist/domain.js";

export const publicMarketKeys = Object.freeze([
  "market_id",
  "version",
  "network",
  "question",
  "yes_definition",
  "no_definition",
  "opens_at",
  "closes_at",
  "resolution_rule",
  "resolution_sources",
  "void_conditions",
  "status",
]);
const invalid = () => {
  throw new Error("Market unavailable");
};
function text(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !value.trim() ||
    Buffer.byteLength(value) > 8192 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    invalid();
  return value;
}
function list(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid();
  return Object.freeze(value.map(text));
}
function instant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
  )
    invalid();
  const milliseconds = value.slice(0, 23) + "Z",
    date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== milliseconds)
    invalid();
  return value;
}
export function projectPublicMarket(rows) {
  if (!Array.isArray(rows)) invalid();
  if (rows.length === 0) return null;
  if (rows.length !== 1) invalid();
  const row = rows[0];
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    publicMarketKeys.some((key) => !Object.hasOwn(row, key))
  )
    invalid();
  if (
    row.version !== 1 ||
    row.network !== "testnet" ||
    !MARKET_STATUSES.includes(row.status)
  )
    invalid();
  const opens = instant(row.opens_at),
    closes = instant(row.closes_at);
  if (opens >= closes || row.yes_definition === row.no_definition) invalid();
  // Never spread or serialize the input. Unknown fields cannot cross this boundary.
  return Object.freeze({
    market_id: text(row.market_id),
    version: 1,
    network: "testnet",
    question: text(row.question),
    yes_definition: text(row.yes_definition),
    no_definition: text(row.no_definition),
    opens_at: opens,
    closes_at: closes,
    resolution_rule: text(row.resolution_rule),
    resolution_sources: list(row.resolution_sources),
    void_conditions: list(row.void_conditions),
    status: row.status,
  });
}
const escape = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
const shell = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VEIL · Private prediction pool</title><link rel="stylesheet" href="/market.css"></head>
<body><main><header><span class="brand">VEIL</span><span class="network">Zcash · Testnet</span></header>
${body}<footer>Read-only MVP preview · No participation controls are available.</footer></main></body></html>`;
export function renderMarket(rows, { participationHref } = {}) {
  if (participationHref !== undefined && participationHref !== "/") invalid();
  const market = projectPublicMarket(rows);
  if (!market)
    return renderError("Market not found", "No market is currently available.");
  const items = (values) =>
    values.map((value) => `<li>${escape(value)}</li>`).join("");
  const time = (value) =>
    `<time datetime="${escape(value)}">${escape(value.replace("T", " ").replace("Z", " UTC"))}</time>`;
  return shell(`<section class="intro"><p class="eyebrow">A private book. Public rules.</p>
<p class="status">Market status: <strong>${escape(market.status)}</strong></p><h1>${escape(market.question)}</h1>
${market.status === "DRAFT" ? '<p class="notice">Draft market — rules may change. This market is not accepting predictions.</p>' : ""}
${participationHref && market.status === "OPEN" && Date.now() < Date.parse(market.closes_at) ? '<p><a href="/">Make a private prediction</a></p>' : ""}
</section><section aria-labelledby="outcomes"><h2 id="outcomes">What YES and NO mean</h2>
<div class="definitions"><article><h3>YES</h3><p>${escape(market.yes_definition)}</p></article>
<article><h3>NO</h3><p>${escape(market.no_definition)}</p></article></div></section>
<section aria-labelledby="schedule"><h2 id="schedule">Published schedule</h2><dl>
<div><dt>Opening time (UTC)</dt><dd>${time(market.opens_at)}</dd></div>
<div><dt>Closing time (UTC)</dt><dd>${time(market.closes_at)}</dd></div></dl></section>
<section aria-labelledby="resolution"><h2 id="resolution">How the event is resolved</h2>
<p>${escape(market.resolution_rule)}</p><h3>Resolution sources</h3><ol>${items(market.resolution_sources)}</ol>
<h3>Void conditions</h3><ul>${items(market.void_conditions)}</ul></section>
<aside aria-labelledby="privacy"><h2 id="privacy">The public book stays dark</h2>
<p>The public page shows market rules and status. Positions, stake sizes, pool totals, odds and activity are not published.</p>
<p>Privacy model for the MVP: Positions, stake sizes and payouts are hidden from the public blockchain and other market participants. The market operator has the viewing/application access required for settlement.</p>
<p>Zcash does not automatically hide website, IP, browser or timing metadata. Resolution follows a manual, rule-bound oracle.</p></aside>`).replace(
    "Read-only MVP preview · No participation controls are available.",
    participationHref
      ? "Zcash testnet · Read the frozen rules before participating."
      : "Read-only MVP preview · No participation controls are available.",
  );
}
export function renderError(title, message) {
  return shell(
    `<section class="intro"><p class="eyebrow">Public market</p><h1>${escape(title)}</h1><p>${escape(message)}</p></section>`,
  );
}

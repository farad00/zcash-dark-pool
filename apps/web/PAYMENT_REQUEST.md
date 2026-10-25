# Phase 8 private ZIP-321 payment presentation

This is payment-request presentation only. It does not detect transactions or
establish payment, acceptance, confirmation or eligibility. Phase 9 has not begun.
This guide supersedes the Phase 7 guide's historical statements that destination
display and payment requests are unavailable. Backup behavior remains exactly as
described in [TICKET_BACKUP.md](TICKET_BACKUP.md).

Build the existing pinned Rust binary and browser assets with the repository tools
activated:

```powershell
cargo build --workspace --bins --examples --locked --offline
npm.cmd run build:web
```

Start the existing private issuance host using [ISSUANCE.md](ISSUANCE.md). Keep the
same exact loopback origin and browser profile, normally http://127.0.0.1:3001.
The Phase 5 public host remains separate and read-only. The formatter uses the
repository's `target/debug/darkpool-zcash` executable (`.exe` on Windows); no new
wallet, chain or participant database configuration is required by formatting.
Do not expose this development host publicly or through a proxy without separately
reviewing origin, transport and logging safeguards. The admin OPEN guard remains
unchanged; this phase does not authorize opening a market with unresolved rules.

## Participant flow

Choose a side and integer-zatoshi stake for an independent local draft. The
existing reservation and completion handshake commits the credential and local
completion marker before making a payment context available. The original secret
is retained. The chosen side is cleared from the controls when the payment panel
opens. The panel displays the exact requested ZEC amount, issued receiving UA,
published UTC close and validated payment request.

The headings are **Ticket issued — payment status not checked** and **Awaiting
payment verification**. Use shielded testnet funds, leave the memo empty and send
the exact recipient amount. Wallet transaction fees are additional. The app does
not launch a wallet or provide an “I paid” button. Wallet activity cannot update
this screen or establish acceptance.

**Copy payment request** writes only the URI after an explicit gesture. Success
appears only after the browser clipboard write resolves. Denied/unavailable writes
leave selectable text. Clipboard history/synchronization and screenshots can leak
the requested amount and destination. The payment panel contains no ticket ID,
side, claim secret, issuance token or commitment. No network anonymity is claimed.

At/after the published close the browser removes payment text/copy controls and
shows a conservative warning. The first observable millisecond at/after the
published microsecond instant is used; clipboard invocation checks the time again.
An open panel also checks periodically. This does not classify a payment as late,
invalid or expired and does not alter product state. Current market availability
is not checked here. Navigation clears the ephemeral payment panel.

## Request and private boundary

Exactly:

```text
zcash:<unchanged-issued-testnet-UA>?amount=<canonical-decimal-ZEC>
```

One recipient and one `amount` parameter. No memo, label, message, invoice
reference, asset parameter, market/ticket ID, side, secret, token, commitment or
identity. Fresh diversified receiver allocation remains the routing mechanism.

`POST /api/payment-request` receives exactly `receiving_ua` and
`requested_amount_zat` in JSON. It uses the same loopback, exact Origin/Host,
body/concurrency/rate limits, query rejection, no-store/no-referrer and CSP guards
as issuance. The route is unavailable on both the public and static backup hosts.
The response has exactly `payment_request_profile_version: 1`,
`network: "testnet"`, and `payment_uri`. This is a validation/serialization result,
not proof of issuance or a payment receipt.

Node sends two bounded length-framed UTF-8 values over stdin to the existing Rust
binary's `format-payment-request` operation, with EOF after the second value. Rust
returns one framed URI on stdout; malformed inputs return failure with no parser
diagnostics. No sensitive value is placed in arguments. The child environment is
allowlisted to testnet and required OS temporary/system directory variables. It
receives no PostgreSQL, allocation authentication, wallet/viewing/spending or chain
environment. The operation opens no database or wallet and makes no network call.

The pinned `zcash_keys` decoder verifies network, UA encoding and receiver bytes.
The existing Orchard-only policy rejects absent Orchard, Sapling or transparent
alternatives. Re-encoding must equal the supplied UA exactly. The existing
`zip321` helper renders one payment without memo/label/message/extra parameters.
The browser independently compares the response against the expected exact
destination and integer amount before presentation.

Amounts are canonical positive decimal integer-zatoshi strings, at most
2,100,000,000,000,000 zat. No signs, leading zeros, fractions, exponents, grouping,
whitespace, zero, negative values, rounding or clamping. URI decimal ZEC uses
integer quotient/remainder by 100,000,000 and trims fractional trailing zeros;
whole values have no decimal point. Display uses the unchanged eight-place
`formatZatoshi` utility. Market min/max remain authoritative in reservation; no
new stake bounds or economic policy are selected.

## Failure, recovery and preservation

Payment preparation is separate from issuance. Failure retains the credential
and offers **Retry payment preparation** using the same in-memory context; that
retry sends no issuance request and allocates no ticket, secret or receiver.
Reload loses the presentation; deliberate same-attempt issuance recovery retrieves
the original UA. Every recovery first repeats the existing idempotent reservation
to revalidate saved immutable market/side/amount. Changed selection conflicts.

An imported backup or generic local finalized record does not independently
enable a payment screen. It has no original pending issuance capability or payment
context supplied by the backup. An identical import does not erase a pre-existing
same-attempt capability; any deliberate recovery still revalidates that attempt.
Backup imports remain entirely local and do not query server status.
The credential, pending-store schema, nine-field backup, claim commitment,
issuance response, database schema and privileges remain unchanged. No payment URI
is persisted or exported. The existing pending store still retains the original
Phase 7 selection for recovery; this is not a new backup field.

## QR and compatibility limits

QR is **DEFERRED by explicit user approval** for this Phase 8 implementation,
an exception to IMPLEMENTATION_PLAN section 13. No QR dependency or external QR
service is included and no QR test coverage is claimed.

The supported format is the ZEC-only subset of current
[ZIP-321](https://zips.z.cash/zip-0321). Automated tests exercise the pinned Rust
parser/renderer, HTTP and browser. They are not live wallet payment evidence.
[SPIKE_RESULTS.md](../../docs/SPIKE_RESULTS.md) records prior real `zcash-devtool`
testnet payment evidence; this phase adds no new wallet/manual-payment result.
No universal or mobile-wallet compatibility claim is made. An Orchard receiver
does not promise the legacy Orchard value pool; current compatible wallets may
use Ironwood after NU6.3. This phase constructs no transaction.

Verification and precise coverage: [PHASE8_RESULTS.md](../../docs/PHASE8_RESULTS.md).

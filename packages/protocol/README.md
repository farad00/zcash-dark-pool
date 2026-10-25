# Shared protocol — Phase 2

Source: frozen `docs/SPEC.md`, `IMPLEMENTATION_PLAN.md` §7 and `TEST_PLAN.md`
§§3–5. This package contains TypeScript V1 **in-memory** logical domain types,
integer-zatoshi utilities, a client-only claim-secret primitive and the approved
V1 claim commitment. It introduces
no database schema, endpoints, watcher, frontend, Merkle builder, settlement
calculator or wallet authorization. No FROST or wallet dependency changes.

## Money

`parseZecToZatoshi(text, { min, max })` accepts strict ASCII decimals: one whole
part (`0` or nonzero digit followed by digits), optional decimal point and 1–8
fractional digits. It rejects signs, whitespace, leading zeros, exponents, locale
separators, non-string input, extra fractional digits and values outside supplied
bounds. No rounding/truncation. Zero is permitted only when the supplied minimum
allows it. No demo stake limits or global monetary cap are selected.

`formatZatoshi(value)` returns an exact string with eight fractional digits.
`checkedAdd(left, right, max)` and `checkedMultiply(left, right, max)` require
nonnegative `bigint` operands within an explicit caller-supplied bound, and reject
overflow. Multiplication intermediates need a sufficiently wide bound. The
synthetic 128-bit test bound is not a frozen storage, stake or economic limit.

## Types and privacy

All requested domain entities are versioned. All monetary fields use `bigint`.
Public market states are exactly the nine states in SPEC §7; NO_WINNER_REFUND is
an economic refund reason. Payment and claim vocabularies follow SPEC's suggested
states and do not choose transition/classification policy.

`Ticket`, `Claim`, `LedgerRecord`, `SettlementPlan`, `SettlementItem` and `Refund`
are confidential records. `LocalTicket` alone carries a client bearer secret;
it is not a wire export format or a server creation request. No identity graph,
UFVK, spending keys, side pots, payment memos or portfolio-upload API is defined.
`TicketReceiver` requires receiver/diversifier references within the market's
vault context; later wallet allocation must ensure freshness for every ticket.
`ShieldedUa` is a branded adapter result, never a prefix-based address validator.
Maintained wallet validation and shielded-only receiver selection remain required.

`PublicMarket` exposes only allowed metadata. `LedgerCommitment` matches the
public lock object. TypeScript structural typing is not a serialization firewall:
later routes must select permitted fields explicitly, never spread private data.
No runtime serializers or JSON bigint convention are chosen here.

Readonly types guard accidental edits, not hostile input, runtime immutability,
database concurrency, secret redaction or signing authority. References have
distinct brands but no identifier representation is silently frozen. Issuance
must establish ticket entropy with a CSPRNG; mere casts do not establish entropy.

`PolicyRef` preserves unpinned choices as `UNPINNED` issue references; a PINNED
reference denotes a separately reviewed profile. It supplies no default policy.
`ticket_state` is represented this way because SPEC does not enumerate a separate
ticket-state vocabulary. This is not an invented new state machine.

## Secrets and approved claim commitment

`generateClaimSecret()` calls platform `crypto.getRandomValues` on a new 32-byte
array each time. Missing/failed secure randomness prevents creation; no fallback.
This is a client primitive. No secret is sent during creation or put into server
records/audits. Actual browser use, local storage and export occur in later phases.

The user approved the original claim encoding proposal exactly as written.
[Implementation note](../../docs/CLAIM_ENCODING_V1_IMPLEMENTATION.md) records
that approval and its limits. `deriveClaimCommitment({ version: 1, market_id,
ticket_id, claim_secret })` implements native BLAKE2b-256 with ASCII
`DARKPOOL_CLAIM_V1`, each ID framed as `0x01 || u32 big-endian UTF-8 byte length
|| exact UTF-8 bytes`, followed by the raw 32-byte secret. No normalization or
case folding; ill-formed Unicode, wrong versions and wrong secret lengths fail.
`encodeClaimId` exposes the approved ID frame. The commitment result is lowercase
hexadecimal for the in-memory type. No secret-bearing preimage API is exported.
The function requires final IDs; creation handshake/production ID issuance remain
unresolved. Hash dependency: exactly pinned `@noble/hashes` 2.4.0.

Other TEST_PLAN §3 items remain open: ledger/blinding/tree bytes; close mapping;
partial-note references/order, overshoot and exceptions; refund/one-sided fee
allocation; claimable states; pause, terminal/expiry and zero-output policy;
status privacy; export encoding; DB isolation; optional count/batching. These
types are not resolutions of those questions.

## Checks

Run from the repository root with local tools activated:

```powershell
npm.cmd run format:protocol
npm.cmd run format:check:protocol
npm.cmd run lint:protocol
npm.cmd run build:protocol
npm.cmd run test:protocol
```

Tests cover U01–U06 and V01–V02's Phase 2 commitment portion, the binary-side
portion of U07, suggested vocabularies and compile-time privacy/money constraints.
Saved golden bytes/digests come from an independent Rust implementation, with
reproduction documented in `test-vectors/README.md`. Mutation tests cover every
secret bit, both IDs, ambiguous boundaries, key order, Unicode, versions and
secret lengths. Seeded utility tests preserve their seed. These checks do not pass
later market OPEN validation, wallet, claim authentication/concurrency, settlement
or public-route privacy gates.

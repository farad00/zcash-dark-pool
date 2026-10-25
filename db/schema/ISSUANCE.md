# Phase 7 private issuance boundary

Migration `0004_ticket_issuance.sql` implements the user's approved reserve-ID,
then-issue contract. It does not change the frozen source documents or enable
the blocked Phase 4 OPEN operation.

## Product state and privileges

`darkpool_private.issuance_attempts` stores only the SHA-256 token hash, server
ticket ID, market/vault context, private side, positive requested integer
zatoshis, optional approved commitment and RESERVED / COMPLETING / ISSUED state.
Bindings are immutable. There is no participant identity, raw token, claim secret
or wallet key. There is no expiration or cleanup operation.

Reservation durably establishes the identity without inserting a payable ticket.
Completion binds the commitment before contacting the allocator. Finish inserts
the existing private ticket with the actual Orchard-only UA in `receiver_ref`,
`external:<22 lowercase hex diversifier-index bytes>` in `diversifier_ref`, and
the existing market/vault/side/amount/commitment fields. These receiver references
are private, not public API fields. Future matching must decode/compare the
Orchard receiver or scoped diversifier, rather than compare complete UA strings.

`deadline_ref = market-close:<market ID>` references the published issuance close;
it does not choose payment classification or confirmations. The private policy
reference `phase7-issued-unpaid-v1` identifies this approved issuance-only state.
Accepted amount stays zero, accepted receipt/time stay NULL, and payment state
starts AWAITING_PAYMENT. These fields are not evidence of a payment.

Provision an existing dedicated LOGIN with no ownership, role memberships or
table privileges using `node db/issuance-provision.mjs <role>` under maintenance
credentials. It grants only schema USAGE and EXECUTE on:

- `darkpool_issuance.reserve(bytea,text,text,text,text)`
- `darkpool_issuance.begin_completion(bytea,text,bytea)`
- `darkpool_issuance.finish(bytea,text,bytea,text,text)`

All helpers are revoked from PUBLIC. Each runtime transaction checks its actual
authenticated login and all application privileges. The Phase 5 reader gains no
issuance privilege and rejects accidental issuance-schema grants. The browser
has no database access. Owner credentials are used only for migration,
provisioning and disposable test fixtures.

## Allocation and reconciliation

The separate Rust process uses an existing testnet SQLite wallet with exactly one
imported ViewOnly account. The maintained `get_next_available_address` API with
`UnifiedAddressRequest::ORCHARD` returns an Orchard-only UA. No seed or spending
authority is required by this process or provided to Node.

`ext_darkpool_context` binds market, vault reference and wallet account UUID.
`ext_darkpool_allocations` binds ticket, commitment, UA and diversifier index.
The wallet's address exposure and the allocation journal insertion commit in
one `transactionally_with_extension` SQLite transaction. The extension API
controls application writes; the code never writes wallet-owned tables directly.
The journal contains no side, requested amount, issuance token/hash or claim secret.

Node contacts a loopback-only, authenticated length-framed internal operation.
Its deployment capability is separate from every browser issuance token. The
internal result contains UA and diversifier index; only the UA can appear in an
issued participant response. Protect the wallet file, SQLite journals, service
environment and deployment capability using the existing restricted wallet
boundary. No UFVK is published or returned.

Recovery always replays the same ticket/commitment against the journal. A durable
row returns the original allocation. With the same intact wallet, absence of a
row means the atomic wallet/journal transaction did not commit; a new allocation
for that previously unallocated attempt is then safe. Conflicting context or
commitment fails closed. Connection loss, SQLite BUSY, timeout or malformed
internal replies return a reconcile-required failure; they never authorize a
replacement allocation. Product finish failure leaves COMPLETING recoverable.

Keep the same configured wallet and journal across restarts. Missing wallets are
rejected. A restored/stale wallet or product backup must be reconciled by the
operator before restarting issuance: an old snapshot cannot establish whether a
later allocation happened. Do not delete a journal row, create a replacement
wallet, rewind exposure state or treat restoration as an ordinary retry. Backup
restore automation is not implemented in Phase 7.

New reservation, unfinished completion and finish require the single market to
be OPEN and `opens_at <= PostgreSQL clock_timestamp() < closes_at`. Finish locks
the market; deferred transaction-end checks reject new reservation/issuance that
crosses close. A receiver allocated before a rejected finish remains private in
the journal and is never returned as a successful payable destination. No new
issuance right is created after close. Already-issued recovery bypasses opening
checks and returns the same durable result, including after close. It never
changes economic state.

## Development commands

Use protected configuration outside the repository and synced directories.
Allocator environment: `ZCASH_NETWORK=testnet`, `WALLET_DB_PATH`,
`ALLOCATION_MARKET_ID`, `ALLOCATION_VAULT_CONTEXT`, `ALLOCATION_PORT`, and a fresh
deployment `ALLOCATION_AUTH` (32 random bytes as 64 lowercase hex characters).
Start `target/debug/darkpool-zcash serve-allocation` after the maintained wallet
has been provisioned with its real testnet account, birthday and chain tip.

Build prerequisites: `cargo build --workspace --bins --examples --locked --offline`
and `npm run build:web`. With maintenance PostgreSQL test credentials, run
`npm run test:phase7`, or the local protected-credential helper:
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/product-db.ps1 test-issuance`.
Tests create and remove their own databases, roles, unfunded synthetic viewing
wallet and isolated browser profile. The synthetic fixture executable requires
`DARKPOOL_SYNTHETIC_TEST=1`; it is not live wallet provisioning.

# Environment isolation supersedes legacy setup

See [ENVIRONMENTS.md](ENVIRONMENTS.md). HISTORICAL is retired. All PostgreSQL tests require TEST (55433); operational SQL requires an explicit LIVE_EVIDENCE profile (55434). The old implicit product database helper is disabled.

# Product database

PostgreSQL product state is separate from Zcash wallet SQLite. Phase 3 implements
storage and constraints only; it does not implement market administration, APIs,
issuance, matching, ledger hashing, entitlement calculation, wallet operations or
authorization. Authority: frozen docs and approved claim-only V1 profile.
Phase 4 adds a restricted control-function boundary described in [ADMIN.md](ADMIN.md);
the inherited Phase 3 economic/storage guards remain unchanged.
Phase 5 uses the existing public view through a restricted read-only adapter;
provisioning and runtime separation are described in [PUBLIC.md](PUBLIC.md).

## Migrations and local checks

`db/migrate.mjs` uses existing `psql`/libpq and Node built-ins; no new dependency.
It applies ordered `NNNN_name.sql` files in one transaction under an advisory
transaction lock, with a SHA-256 journal in `darkpool_migrations.applied`.
Reapply verifies history and skips applied files. Changed history fails closed.
Use a new forward migration to change the schema; there is no destructive down
migration. Failed DDL rolls back both DDL and journal. Tests prove these behaviors
on fresh disposable databases, including simultaneous migration runners.

On the configured Windows development environment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev/postgres.ps1 start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev/product-db.ps1 migrate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev/product-db.ps1 test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev/product-db.ps1 verify
```

The helper restores libpq environment values, reads the existing DPAPI credential
without printing it, and targets `darkpool_product_dev` on 127.0.0.1:55434.
Tests create only randomly named `darkpool_phase3_<16 hex>` databases and a NOLOGIN
test reader, then remove those exact test-owned resources. They do not reset the
development database or inspect wallet data. Running these commands writes to the
existing PostgreSQL data directory outside the workspace.

For another environment, configure `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` and
protected libpq authentication, then run `npm run migrate:db` / `npm run test:db`.
The test connection needs CREATE DATABASE/ROLE privileges; never give them to an
application connection. Migrations require a separate schema owner. Diagnostics
expose SQLSTATE only, because error DETAIL can expose private row data. Do not
place passwords in URLs/arguments or commit populated configuration.

## Records and privacy

All base tables are in `darkpool_private`; every schema/table/function revokes
PUBLIC access. `darkpool_public.markets` is an explicit security-barrier allowlist
matching protocol `PublicMarket`. No optional prediction count, ledger publication
view, aggregate book, activity feed, vault mapping or post-resolution statistics
is exposed. No roles, passwords or grants to application accounts are created.
Provision a public reader with only USAGE on `darkpool_public` and SELECT on its
market view; grant no private-schema usage. Do not use the owner/superuser for
application traffic. Deploy least-privilege service grants in later integration.

| Record                                                | Storage and invariant                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy_refs`, `market_policy_refs`                   | Immutable UNPINNED issue or PINNED reviewed-profile reference; no embedded JSON payload/default policy. Per-market named profile slots remain extensible.                                                                                                                                        |
| `markets`                                             | Public definitions, nine statuses, UTC instants, explicit stake bounds, one private vault context; original rules freeze once opened. Thresholds nullable without defaults.                                                                                                                      |
| `tickets`                                             | Independent private YES/NO records; positive request, accepted stake zero or exactly request; scoped unique receiver/diversifier; final ID/context/commitment immutable. No user/profile graph.                                                                                                  |
| `payment_receipts`                                    | Stable unique testnet txid/value-pool/output-index plus scoped wallet reference; multiple notes per TX allowed. Receiver+ticket+market FK prevents cross-matching; unmatched receipts persist with null ticket. Height/hash may clear for pre-finality reorg handling.                           |
| `accepted_payments`, `accepted_payment_receipts`      | Logical acceptance-group reference and receipt membership; one receipt cannot enter two groups; ticket/market links match. No ordering/allocation/hash convention.                                                                                                                               |
| `payment_liabilities`                                 | One unresolved liability record per observed receipt, nullable principal; observed amount remains in receipt. Never default liability to zero or erase it on market closure.                                                                                                                     |
| `ledger_sets`, `ledger_records`, `ledger_commitments` | Private confirmed-ticket snapshots and persisted opaque blinding bytes; explicit freeze serializes membership changes and requires reviewed profiles/nonempty stored blindings. Frozen membership/root cannot mutate; count matches membership. No Merkle algorithm or public blinding exposure. |
| `resolutions`                                         | Single market resolution with evidence/rule/actor; immutable once settlement records exist.                                                                                                                                                                                                      |
| `entitlements`                                        | One accepted-stake entitlement per ticket; separately associated exception liability with explicit policy. Amount may remain unknown. Kind/context cannot mutate to defeat replay protection.                                                                                                    |
| `claims`, private `refunds` view                      | Payout/refund share one reservation constraint for the accepted-stake entitlement. Exception entitlements remain distinct. Bound destination, entitlement and idempotency context are immutable.                                                                                                 |
| `settlements`, `settlement_items`                     | Private plan/hash/profile/root/resolution/totals/fee/allocated funds/tx identity; output must match bound claim. Populating plan_hash seals reconciled outputs under an explicit reviewed profile; sealed plan/items cannot change. Outputs+fees cannot exceed declared allocation.              |
| `audit_events`                                        | Narrow event envelope with source, trigger, UTC time, paired prior/new states and optional chain ref; no payload/secrets/sides/amounts/address/IP fields. UPDATE/DELETE/TRUNCATE rejected.                                                                                                       |

Monetary columns use unconstrained exact `numeric` with a domain that rejects
fractions, negatives, NaN and infinities, rather than `numeric(p,0)` coercion that
could round input. This selects storage, not a stake/economic maximum. Driver code
must serialize decimal integer strings/bigint, never JS Number or SQL float casts.
Caller-supplied bounds and resource limits remain required. PostgreSQL implementation
limits still apply. Reference columns use exact UTF-8 text with C equality and no
UUID, normalization, lowercase conversion or ID generator. This is an internal
storage representation, not a production ID format or ledger sort convention.
PostgreSQL text excludes NUL; production ID validation remains unresolved.

The scale-coercion distinction was checked against PostgreSQL's official
[numeric type documentation](https://www.postgresql.org/docs/18/datatype-numeric.html).
Relation/uniqueness and privilege behavior follow its
[constraint documentation](https://www.postgresql.org/docs/18/ddl-constraints.html)
and [GRANT documentation](https://www.postgresql.org/docs/18/sql-grant.html), and
were exercised on the actual local PostgreSQL 18.6 server.

Claim commitment stores the raw 32-byte digest, explicitly tagged
`DARKPOOL_CLAIM_V1_ID_FRAME_1`. This changes no approved preimage bytes: adapters
must decode protocol lowercase hex to bytes and return the identical hex. Ledger
roots, blindings and plan hashes remain opaque bytea with separate profile refs;
no claim encoding is reused to define them. Draft plan/root/blinding data may be
incomplete; this schema does not certify that an UNPINNED object is executable.

Indexes include primary/composite foreign-key targets, receiver/diversifier and
note uniqueness, market status/close, ticket market/payment state, receipt ticket
and height, accepted ticket entitlements, active claim entitlement, idempotency
scope+key, claims ticket/state/settlement, transaction lookup and audit market/time.
No side-based public statistics or materialized aggregates.

## Reservation contract and decisions left open

Suggested payment/claim vocabularies match `@darkpool/protocol`; ticket, receipt,
settlement and liability operational states are explicit profile references.
Ticket claim state is read from the accepted entitlement/claim, not duplicated in
an independently writable ticket column. Refund is a claim discriminator/view,
so winner/refund mutual exclusion crosses both paths. `NO_WINNER_REFUND` stays an
economic reason, not a tenth market status.

Atomic reservation can use a transaction to insert a RESERVED claim or update an
UNCLAIMED candidate. A partial unique index covers every non-UNCLAIMED state,
including both failure states. The entitlement row lock serializes amount changes
and reservations. Same-key duplicates are detected by explicit scope+key; later
API code must compare immutable request fields and return the existing request or
conflict. Scope is caller-supplied with a policy reference; no global/ticket scope
is chosen. Eight real competing PostgreSQL processes and competing candidate
updates test this substrate only;
they do not authenticate or pay a claim.

There is no automatic release/reset/delete/expiry path. Failed/uncertain attempts
retain their reservation and known tx reference; normal retries reuse that claim.
Replacement transaction association and safe reservation release require a reviewed
reconciliation design in later phases. Retention is a guard against accidental
replay, not a terminal-consumption or forfeiture policy. Distinct exception returns
require separately reviewed eligibility/accounting; unknown amounts and UNPINNED
exception policies cannot reserve refunds. One logical liability per receipt can
later gain reviewed component/allocation tables if needed; no split/principal rule
is implied by this envelope.

Still open: close mapping/equality/finality thresholds, partial aggregation/order/
overshoot/reference encoding, exception principal/authentication, refund/one-sided
fees and fee drift, claimable states, pause authority/pending payments, expiry/
terminal/zero-output rules, public counts/batching, canonical ledger/blinding/tree
conventions, plan hashing, issuance/creation handshake, ID entropy and format,
status-read authorization, export format and full reservation/reconciliation
transaction strategy. No default resolves these. No seed, UFVK, spending key,
FROST share, claim secret or wallet SQLite state is stored here. FROST stays
DEFERRED; isolated signer + PCZT remains the demonstrated authorization path.

## Limits

This database is trusted private bookkeeping, not an authentication service,
wallet/address validator, chain-finality oracle or solvency proof. A nonempty
destination/validation reference cannot prove shielded testnet validity or freshness;
maintained wallet validation is mandatory before reservation in Phase 15. An
allocation amount cannot prove available wallet funds or reserves for other
liabilities. Ledger hash/profile correctness, full receipt sums, high-entropy
blindings and preauthorization plan reconciliation remain later gates.

DB owner/superuser can bypass triggers/grants, alter schemas or put secret strings
in arbitrary text/bytea fields. A narrow audit envelope prevents ordinary payload
dumping, not deliberate secret exfiltration. Never grant application DDL, TRUNCATE,
trigger disabling or ownership. Server statement/error logging, encrypted storage,
backup encryption, non-synced storage, service isolation and retention need
deployment configuration; client SQLSTATE redaction alone does not secure server
logs. Product DB compromise reveals the accepted operator-visible private book.
Tests use synthetic fixtures only and are not a privacy/security audit or a
working lifecycle claim. Phase 4 control tooling does not implement those deferred policies/workers.

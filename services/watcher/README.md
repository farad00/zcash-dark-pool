# Private official-testnet watcher

Automated implementation is separate from manual evidence. **Do not run the
manual steps below until separately authorized.** No new manual official-testnet
payment evidence has been collected. The reviewed no-payment retry persisted 600
blocks and then failed with its underlying error lost. Phase 9 remains incomplete;
live operation is stopped pending review.

Run from the repository root on Windows with the existing activated tooling.
Node 24 coordinates the maintained Rust view-only wallet and restricted
PostgreSQL capability. There is no HTTP listener or payment-status UI. The
runtime files are `main.mjs`, `db.mjs`, `diagnostics.mjs` and Rust `watcher.rs`.

## Automated commands

```powershell
. ./scripts/dev/activate.ps1
cargo fmt --all -- --check
cargo build --workspace --bins --examples --locked --offline
cargo test --workspace --locked --offline
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
npm.cmd run check:watcher
./scripts/dev/phase9-tests.ps1 -Action watcher
./scripts/dev/phase9-tests.ps1 -Action regressions
npm.cmd run test:protocol
npm.cmd run test:web
```

The test helper reads the existing DPAPI-protected local PostgreSQL credential
and uses `postgres` solely as a maintenance database. Tests create/drop their
own randomized disposable databases and roles. The wallet fixtures are
unfunded synthetic encrypted notes, scanned and rewound by the pinned maintained
wallet API. Node's injected recovery fixtures are explicitly separate evidence.
No automated command opens a live market, requests funds, or migrates/adopts
`darkpool_product_dev`.

## Protected failure diagnostics

Diagnostics are disabled by default. After separate authorization for a live run,
an operator may set `WATCHER_DIAGNOSTIC_PATH` to a new file under
`%LOCALAPPDATA%\ZcashDarkPoolDev\phase9\<protected-run>`. The parent must have a
protected Windows DACL owned by the current user, with only that user, SYSTEM and
Administrators allowed and owner full control. Broad/inherited ACLs, symlinks,
paths outside that root and existing files are refused. This option does not
authorize a live run. Do not use the existing stopped run's files for test output.

The single-use file is created exclusively and receives at most one bounded,
fsynced JSON failure record. No raw error strings, stderr, RPC payloads, wallet
rows, keys, receivers or payment fields are included. Runtime stderr remains
`Private testnet watcher unavailable`. Node validates closed class/stage enums,
and explicit closed `guard`/`phase` enums. Guard identity is assigned at the local
validation site, independently of the last RPC stage; unassigned or unrecognized
values remain `OTHER`. These fields retain no comparison values or error text.
Node also validates
numeric gRPC/SQLite codes, last inserted public batch range, encoded cache
occupancy, child code/signal, timeout/kill and valid-frame flags. The last cached
range is absent for `HISTORY_LIMIT`; with `CLOSE_HISTORY` stage the counters
describe the existing bounded close-history collection instead. The last cached
range is **not** a claim about the next failed download request. Maintained sync
does not expose that request's full range through its interceptor.

Only a validated diagnostic sink enables the child's diagnostic IPC flag; it
receives no diagnostic file path or PostgreSQL credentials. A valid failure frame
waits for natural child close within the existing request deadline, preserving
Windows exit status. Malformed frames and Node timeouts kill the child and record
that distinction. Stderr is discarded. Startup failures before IPC remain child
exit/signal evidence without an invented Rust class. Some maintained nested
errors lack typed causes; these retain their closed fallback and stage rather
than guessing a numeric code. The measured cache catch-up failure and unapplied
cache-only proposal are recorded in `docs/PHASE9_RESULTS.md`.

## Credentials and operation

Configure the watcher in its own protected shell:

```text
APP_ENV=development
DARKPOOL_WATCHER_INTERNAL=1
ZCASH_NETWORK=testnet
PGHOST=127.0.0.1
PGPORT=55434
PGDATABASE=darkpool_phase9_evidence_<reviewed_run_name>
PGUSER=<dedicated_restricted_watcher_login>
PGPASSFILE=<protected_absolute_passfile>
WALLET_DB_PATH=<protected_non_synced_view_only_wallet_sqlite>
CHAIN_ENDPOINT=<reviewed_https_lightwalletd_endpoint>
WATCHER_STOP_PATH=<protected_non_synced_directory>/pending-stop.json
```

Unset DATABASE_URL, PGOPTIONS, PGSERVICE/PGSERVICEFILE and admin flags. Never use
maintenance credentials for runtime. No wallet key/seed or signer configuration
is a runtime argument. The Rust child inherits only approved OS/testnet/wallet/
endpoint settings and the optional explicit rescan review flag; PostgreSQL and
allocation credentials stay out of that child. Passwords stay out of argv/SQL.
Protect the wallet, passfile and stop-marker parent directory using the same
non-synced local-storage/ACL practice as the existing private wallet evidence.

After separately reviewed provisioning:

```powershell
node services/watcher/main.mjs --once
# Continuous private operation, once the same manual run is authorized:
node services/watcher/main.mjs
```

Each cycle reads context, acknowledges missing observations in PostgreSQL before
sync, runs maintained sync, verifies canonical hash-linked endpoint data and
contiguous fully-scanned tip, then atomically reconciles. No independent scanner,
rewind, restore or allocator reset may run concurrently against this wallet.
SQLite writes use maintained APIs, FULL durability and busy timeouts. The
Windows kernel lock prevents two watcher writers and releases on process exit.
Allocation writes retain their existing SQLite transaction serialization.

A detected safety stop first writes/fsyncs a small local marker so DB outage
cannot erase the intention. On restart it is submitted to PostgreSQL before
another sync and removed only after the durable hold acknowledges. Do not remove
markers or clear a hold to get a passing demonstration. Accepted history stays
immutable; review any hold offline. Logs contain fixed operational lines only.

MVP bounds are 4 MiB private frames/messages, 4,096 received identities, 8,192
cached scan blocks, 64 MiB encoded compact-block data per cache/witness/inclusion
collection, 30-second fresh snapshot, 5-second SQL
statement timeout, 10-second DB/observation process timeout and the existing 30-minute sync
deadline. Exceeding a bound fails closed; no chunked partial acceptance or
automatic reset is supplied. The maintained sync API itself downloads each
suggested range before handing it to the cache, so its transient allocation is
not a hard process-RSS guarantee. Choose a fresh birthday and short demo close.
Unsupported maintained rewind checkpoints stop for review. The runtime uses TLS
and one bound testnet endpoint, without independent full-node or multi-endpoint
consensus proof. It does not enhance full transactions, prove whole-transaction
transparency, provide operator anonymity or spending authority.

### Bounded private close proof V2

Design D replaces the production full-span close-history array with a read-only
cursor over maintained blocks, covered by Scanned queue intervals and the checked
fully-scanned H. Discovery retains at most thirteen headers, uses exactly eleven
predecessor timestamps and takes O(H-A) local CPU work. Fresh linked witness
headers are compared with wallet hash/time metadata. Missing pre-birthday seed
records (at most ten) can be recovered; an internal scanned gap fails closed.
This does not add full-node consensus verification or protection against a
malicious same-user wallet writer.

Private chain.close_proof has version 2, the unchanged economic profile,
FOUND/NO_CROSSING_BY_H status, nullable boundary height, eleven anchor headers,
thirteen crossing headers (or twelve terminal headers; none when H=anchor) and
a target header. Each header contains height/hash/prev_hash/time. The separate
inclusion_blocks array has at most one header per required output height, bounded
by 4,096 outputs. Rust fetches real containing blocks and validates txid, actual
transaction index and pool output/action index. No whole-transaction transparent
component gate is introduced; transparent receiving fallback remains rejected.

Forward migration 0006 adds a private checker and replaces the reconciliation
validator; exactly context/reconcile remain runtime capabilities. The legacy V1
reference validator retains its original 16,384 cap. V2 does not require that
representation or raise existing limits. SQL recomputes both MTP medians, checks
the strict crossing bracket, witness links/overlaps/H and containing headers, and
preserves matching, confirmations, idempotency and sticky accepted-history holds.

The proof remains private IPC/SQL evidence, never a public API/browser/backup/log
field. Apply 0006 to preserved evidence only under separate explicit maintenance
authorization; this offline task applies it only to disposable fixtures. A live
watcher run also requires separate authorization.

## Exact manual official-testnet procedure — NOT RUN

1. Obtain separate authorization for a new named evidence run, its draft event,
   future UTC deadline, small/valueless requested amounts, protected paths,
   endpoint, account and explicit OPEN/provisioning. Keep all six baseline docs
   and old evidence unchanged. Do not reuse/migrate `darkpool_product_dev`.
2. In a maintenance-only shell, create a **new** database named
   `darkpool_phase9_evidence_<run_name>` with template0/UTF8. Point PGDATABASE at
   that exact new name and run `node db/migrate.mjs`. Verify the checksum journal
   has 0001–0007. Create separate non-superuser, non-owner, no-membership SCRAM
   logins for watcher, issuance and public reader. Place credentials in protected
   passfiles. Run `node db/watcher-provision.mjs <watcher_role>`,
   `node db/issuance-provision.mjs <issuer_role>` and
   `node db/public-provision.mjs <public_role>` with maintenance credentials.
   Provisioning never binds a wallet or opens the market.
3. Provision a fresh UFVK-only imported ViewOnly wallet using the previously
   demonstrated Phase 1 transfer (`scripts/dev/phase1-view-import.rs`, without
   `--constructor`), its recorded protected tooling and a real maintained tree
   state/birthday. Use a fresh view-only database with the same account/UFVK
   throughout this run. Keep signer storage separate. Do not use synthetic
   `issuance-fixture`/empty synthetic tree states on the real network. Verify
   one imported ViewOnly account, no seed/identity/spending-key material, and
   preserved birthday/account UUID privately.
4. Configure the single DRAFT event through normal admin tooling with explicit
   Phase 9 labels from db/schema/ADMIN.md: approved close/payment, zero platform
   fee, Orchard receiving, bounded V2 proof, payout deferred, deposit confirmations
   3 and payout confirmations null. No payout number is inferred. Record a real
   pre-OPEN canonical endpoint anchor and preceding 11 timestamps, verify their
   median < the immutable published close C, and bind state using the following
   **private reviewed SQL file**, not public output or shell history:

   ```sql
   BEGIN;
   INSERT INTO darkpool_private.watcher_state
     (market_id,profile_ref,account_ref,endpoint_ref,anchor_height,anchor_hash,
      bound_closes_at,revision,checkpoint_ref,hold_ref,created_at)
   SELECT id,'phase9-exact-chainclock-3-v1',:'account_uuid',:'endpoint',
     :'anchor_height'::bigint,decode(:'anchor_hash_raw_hex','hex'),
     closes_at,0,NULL,NULL,clock_timestamp()
   FROM darkpool_private.markets WHERE id=:'market_id' AND status='DRAFT';
   COMMIT;
   ```

   Anchor hash is raw maintained/RPC byte order. User-facing display hash/txid
   conventions reverse these bytes; do not reverse internal comparisons twice.
   Recheck immutable event rules, validate the persisted configuration, then use
   the normal restricted admin OPEN command with a fresh request key and current
   revision. Migration 0007 validates and audits that ordinary transition; do not
   update status directly in maintenance SQL. OPEN permits qualifying deposits,
   not settlement/claim/refund/payout readiness. Platform/operator fee and rake
   are zero; network fees remain external costs outside requested/accepted stake.
   REOPEN remains blocked. This live setup still requires separate authorization
   and a new evidence database; preserve the successful old database unchanged.

5. Start the existing private view-only allocator on this same wallet/account/
   market/vault binding and the Phase 8 issuance host using its dedicated role
   and the existing browser origin. Issue a fresh YES ticket and fresh NO ticket;
   save each independent bearer backup privately. Verify immutable requested
   values and distinct Orchard-only receiving UAs through the maintained parser.
   Do not print claim secrets, UFVKs, addresses, amounts, sides or mappings in
   public logs. First allocation creates the intact allocation-context journal.
6. Start the watcher with its restricted credentials using `--once`. From a
   compatible external official-testnet wallet, send **one exact genuine
   shielded output** to each real issued receiver before C. Record containing
   block height/hash/raw timestamp and actual pool privately. The current pool
   may be Ironwood despite an Orchard receiver; never relabel it. Whole-transaction
   transparency need not be established for acceptance, and must not be claimed
   without separate evidence. Run watcher cycles through h+2 for each note.
   Confirm that cycles at 1/2 confirmations leave stake unaccepted; at 3 the
   correct YES and NO tickets each become CONFIRMED with exact requested stake.
7. Issue an additional fresh ticket before C and send **one underpayment OR one
   overpayment**, according to the approved run amount. Sync/reconcile it and
   inspect the entire receipt principal and unresolved liability. It must remain
   outside accepted membership/stake with no refund entitlement or execution.
8. Using a maintenance read in protected evidence storage, inspect receipts,
   accepted groups, singleton membership, tickets, liabilities, ACCEPTANCE/
   INCLUSION/RECONCILIATION evidence, audit and watcher checkpoint. For each
   accepted ticket verify exact amount, immutable issuance/journal match, stable
   output identity, timestamp < C, canonical containing hash, h+2 verified tip,
   DB accepted_at and one TICKET_CONFIRMED event. Inspect public page/API/network
   traffic and all runtime logs for absence of private payment/book data. Query
   as public reader and prove table and watcher-function access are denied.
9. Stop and restart the watcher and repeat `--once`. Compare protected counts
   and accepted decision evidence before/after: no additional receipt/group/
   membership/stake/audit for the same output. No ledger publication or settlement
   is part of this inspection.
10. Perform the separately authorized **controlled rescan** through the same
    preflight path. Stop continuous operation, preserve consistent private
    backups, select a maintained rewindable checkpoint R at/after the frozen
    anchor and below a paid containing block (no wallet reset). Run:

    ```powershell
    $env:DARKPOOL_WATCHER_RESCAN_REVIEW = '1'
    node services/watcher/main.mjs --once --review-rescan-height=<R>
    Remove-Item Env:DARKPOOL_WATCHER_RESCAN_REVIEW
    ```

    Replace R with the privately reviewed numeric checkpoint. The maintenance
    flag is explicit, bounded and runs once. It acknowledges unretained notes
    before maintained truncation/rescan. An unavailable checkpoint stops; do not
    reset/restore keys or erase the allocation journal to bypass it. After a
    successful canonical rescan, confirm identical accepted evidence and no
    duplicated stake. A real chain contradiction must produce a sticky hold,
    not be edited away.

11. Retain real evidence privately and add only a redacted PASS/FAIL record to
    PHASE9_RESULTS after review. Real chain reorg induction is unnecessary;
    synthetic maintained-wallet/DB reorg fixtures remain separately labelled.
    If any required real payment/mapping/3-confirmation/restart/rescan/privacy
    check is missing or fails, Phase 9 remains incomplete. Stop without Phase 10,
    claims, payouts, refunds, publication, signing or a commit.

## PostgreSQL target isolation

Use the explicit protected LIVE_EVIDENCE profile on port 55434 for separately authorized operations; tests use TEST on 55433. HISTORICAL is retired and must not be connected. See the [environment guide](../../db/schema/ENVIRONMENTS.md). Existing runtime privilege checks remain mandatory.

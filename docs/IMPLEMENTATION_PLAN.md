# IMPLEMENTATION_PLAN.md --- MVP Build Plan

## Zcash-Native Dark Prediction Pool

**Status:** Implementation Baseline\
**Version:** 1.0\
**Date:** 2 October 2026\
**Depends on:** `PRD.md`, `ARCHITECTURE.md`, `SPEC.md`,
`THREAT_MODEL.md`

## 1. Objective

Build a working Zecathon MVP that demonstrates the complete lifecycle:

``` text
create market
    ↓
open market
    ↓
create private YES/NO ticket
    ↓
generate fresh shielded receiver + ZIP-321 request
    ↓
receive shielded ZEC
    ↓
detect and match payment
    ↓
lock market deterministically
    ↓
commit accepted ledger
    ↓
resolve YES/NO
    ↓
calculate parimutuel settlement
    ↓
claim with bearer secret + fresh UA
    ↓
construct/authorize shielded payout
    ↓
confirm payout
```

A complete, reliable market with simpler signing is more important than
an incomplete market with ambitious FROST integration.

------------------------------------------------------------------------

## 2. Build Strategy

Implementation follows this order:

1.  prove Zcash primitives independently;
2.  build market/ticket product logic;
3.  connect shielded deposits;
4.  implement lock and ledger commitment;
5.  implement deterministic resolution/settlement;
6.  implement claims/refunds;
7.  complete shielded payout;
8.  add PCZT separation;
9.  add FROST only after the complete lifecycle works;
10. harden, test, and prepare demo.

Do not start with FROST or custom ZK.

------------------------------------------------------------------------

## 3. Recommended Repository Structure

``` text
dark-prediction-pool/
│
├── apps/
│   └── web/                     # Next.js/React UI + product API
│
├── services/
│   └── zcash/                   # Rust Zcash wallet service
│       ├── src/
│       └── Cargo.toml
│
├── packages/
│   └── protocol/                # shared types / canonical rules
│
├── db/
│   ├── migrations/
│   └── schema/
│
├── scripts/
│   ├── dev/
│   └── demo/
│
├── test-vectors/
│
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── SPEC.md
│   ├── THREAT_MODEL.md
│   ├── IMPLEMENTATION_PLAN.md
│   └── TEST_PLAN.md
│
├── .env.example
├── README.md
└── docker-compose.yml           # optional local services
```

The exact monorepo tooling is flexible. Do not introduce a complex
workspace framework unless it saves real implementation time.

------------------------------------------------------------------------

## 4. Technology Baseline

### Web

Recommended:

-   Next.js;
-   React;
-   TypeScript;
-   native Web Crypto API for claim-secret generation;
-   QR library for ZIP-321 display.

### Product database

Recommended:

-   PostgreSQL;
-   migration tool compatible with chosen TypeScript stack.

### Zcash service

Recommended:

-   Rust;
-   maintained compatible Zcash wallet crates;
-   wallet SQLite database separate from product PostgreSQL.

Candidate crate families to validate and pin during the first spike:

-   `zcash_client_backend`;
-   `zcash_client_sqlite`;
-   `zcash_keys`;
-   ZIP-321 support;
-   Orchard-related maintained dependencies;
-   PCZT support.

Do not pin versions by guess. Pin the versions that successfully compile
and pass the spike.

### Chain source

Use a current testnet-compatible lightwalletd/Zaino endpoint or locally
controlled equivalent supported by the selected wallet stack.

------------------------------------------------------------------------

## 5. Phase 0 --- Repository and Environment

### Tasks

-   initialize repository;
-   create web application;
-   create Rust Zcash service;
-   configure PostgreSQL;
-   establish wallet SQLite path;
-   add `.env.example`;
-   add network configuration;
-   add formatting/linting;
-   add basic CI;
-   place approved documents under `/docs`;
-   commit dependency lockfiles.

### Required environment variables

Conceptually:

``` text
APP_ENV
ZCASH_NETWORK
DATABASE_URL
WALLET_DB_PATH
CHAIN_ENDPOINT
MARKET_CONFIG
LOG_LEVEL
```

Secret signing material MUST NOT be placed in `.env.example`.

### Exit criteria

``` text
web app starts
Rust service starts
PostgreSQL reachable
wallet DB initializes
CI runs
```

------------------------------------------------------------------------

## 6. Phase 1 --- Zcash Technical Spike

This phase must happen before building significant UI.

### Spike A --- Fresh diversified receiver

Prove that the selected wallet stack can:

1.  initialize/restore the market wallet;
2.  derive or request the next fresh diversified receiver;
3.  persist enough information to map that receiver back to wallet
    state;
4.  restart and retain the mapping.

### Spike B --- ZIP-321

Prove:

``` text
fresh receiver + amount
        ↓
ZIP-321 URI
        ↓
compatible wallet can parse/pay
```

No YES/NO metadata is required.

### Spike C --- View-only scanning

Create:

``` text
spending wallet
        ↓ export viewing capability
view-only watcher
        ↓ sync
detect incoming shielded payment
```

Verify the watcher does not possess spending authority.

### Spike D --- Ticket matching

Persist:

``` text
receiver_ref -> ticket_id
```

Send testnet funds and prove the received note can be matched
deterministically.

### Spike E --- Shielded payout

Using a simple signer first:

``` text
market wallet
    ↓
fresh winner UA
    ↓
shielded testnet payout
```

### Spike F --- PCZT

Prove current compatible tooling can:

1.  construct;
2.  prove where required;
3.  transfer the partially constructed transaction across the
    authorization boundary;
4.  sign;
5.  finalize;
6.  broadcast.

### Spike G --- FROST feasibility

Only after A-F pass:

-   test actual compatible FROST workflow;
-   prove a real 2-of-3 shielded testnet spend if feasible;
-   document dependency/version issues.

### Deliverable

Create:

``` text
docs/SPIKE_RESULTS.md
```

recording exact versions, commands, successful transaction references,
and unresolved limitations.

### Exit criteria

A-E are mandatory PASS.

F is strongly preferred PASS.

G may be PASS or documented DEFERRED.

------------------------------------------------------------------------

## 7. Phase 2 --- Protocol Types and Shared Logic

Implement protocol primitives before UI polish.

### Types

Create versioned types for:

``` text
Market
Ticket
PaymentStatus
MarketStatus
Claim
Resolution
LedgerRecord
LedgerCommitment
SettlementPlan
SettlementItem
Refund
AuditEvent
```

### Monetary utility

Implement:

``` text
parseZecToZatoshi()
formatZatoshi()
checkedAdd()
checkedMultiply()
```

Never use JavaScript floating point for settlement.

For TypeScript, use `bigint` for zatoshi arithmetic.

### Claim secret

Browser/client:

``` text
crypto.getRandomValues(new Uint8Array(32))
```

Implement domain-separated claim commitment using the frozen
hash/encoding choice.

### Test first

Before moving on, test:

-   deterministic commitment;
-   changed secret changes commitment;
-   changed ticket/market changes commitment;
-   malformed amount rejected.

------------------------------------------------------------------------

## 8. Phase 3 --- Database Schema

Create product DB migrations.

Minimum logical tables:

### markets

Fields include:

``` text
id
question
yes_definition
no_definition
opens_at
closes_at
resolution_rule
resolution_sources
void_conditions
min_stake_zat
max_stake_zat
fee_policy
status
created_at
updated_at
```

### tickets

``` text
id
market_id
side
requested_amount_zat
accepted_amount_zat
receiver_ref
claim_commitment
payment_state
ticket_state
created_at
accepted_at
```

No required bettor `user_id`.

### payment_receipts

``` text
id
ticket_id
wallet_receipt_ref
amount_zat
block_height
status
created_at
```

Unique constraint on wallet receipt identity.

### ledger_commitments

``` text
market_id
version
accepted_ticket_count
merkle_root
locked_at
```

### resolutions

``` text
market_id
outcome
evidence
resolved_at
actor
```

### claims

``` text
id
ticket_id
idempotency_key
payout_address
entitlement_zat
state
settlement_id
tx_ref
created_at
updated_at
```

Unique successful/reserved claim constraint per ticket.

### settlements

Store plan hash, totals, fee, state, and transaction reference.

### audit_events

Append-only logical event records.

### Exit criteria

-   migrations run from clean DB;
-   constraints enforce duplicate receipt and duplicate claim
    protection;
-   no plaintext claim-secret column exists.

------------------------------------------------------------------------

## 9. Phase 4 --- Market Administration

Build minimal operator tooling.

### Required actions

-   create market;
-   edit while DRAFT;
-   validate configuration;
-   open market;
-   inspect private operational status;
-   pause with reason;
-   reopen when allowed;
-   observe/finalize lock;
-   resolve YES/NO/VOID with evidence.

### Guardrails

Once OPEN, prevent edits to:

-   proposition semantics;
-   YES/NO definition;
-   close rule;
-   resolution rule;
-   fee policy;
-   payment policy.

Do not spend time building a polished admin dashboard. A protected
functional interface is enough.

------------------------------------------------------------------------

## 10. Phase 5 --- Public Market Page

Build the primary bettor experience.

Display:

-   question;
-   short description;
-   YES/NO definitions;
-   close time;
-   resolution source/rule;
-   market status;
-   optional total confirmed ticket count.

Do not display:

-   YES count;
-   NO count;
-   pool totals;
-   odds;
-   recent direction;
-   largest stake.

### Prediction form

Inputs:

``` text
YES | NO
stake amount
```

On submit:

1.  generate claim secret client-side;
2.  derive claim commitment;
3.  send side, requested amount, commitment to API;
4.  API allocates fresh receiver;
5.  create ticket;
6.  return ticket ID + ZIP-321 request;
7.  store bearer ticket locally.

------------------------------------------------------------------------

## 11. Phase 6 --- Local Ticket Vault

Implement local ticket storage.

Minimum UX:

``` text
My Predictions
```

showing locally known tickets and statuses.

### Required

-   save ticket immediately after creation;
-   preserve claim secret locally;
-   export individual ticket;
-   import/restore ticket;
-   status refresh using ticket ID without exposing secret;
-   warning: ticket secret controls claim.

### Security

-   no third-party analytics on pages handling secrets;
-   do not log claim secret;
-   apply CSP;
-   avoid unsafe HTML;
-   do not transmit local portfolio as a server-side account.

------------------------------------------------------------------------

## 12. Phase 7 --- Zcash Address Allocation API

Expose a narrow internal Rust service operation:

``` text
allocate_receiver(ticket_context)
    -> receiver
    -> internal receiver_ref
```

The web/API layer should not need spending keys.

Persist mapping so restart does not lose:

``` text
receiver_ref <-> ticket
```

Test that 100+ sequential ticket allocations produce fresh receivers and
retain correct mappings.

------------------------------------------------------------------------

## 13. Phase 8 --- ZIP-321 Payment UX

Generate exact-payment request.

Display:

-   QR;
-   copyable payment request;
-   requested ZEC amount;
-   payment state;
-   close/deadline warning.

Do not put YES/NO into the memo.

### Status polling

UI states:

``` text
Awaiting payment
Payment detected
Confirming
Confirmed
Payment issue
```

Do not call a detected but unconfirmed payment accepted.

------------------------------------------------------------------------

## 14. Phase 9 --- Watcher

Build a long-running Rust worker or wallet-service task.

Responsibilities:

1.  synchronize wallet;
2.  detect received notes;
3.  normalize receipt event;
4.  submit/process event idempotently;
5.  update confirmation state;
6.  handle re-scan safely.

### Observability

Log:

``` text
wallet sync height
lag
receipt internal ref
processing result
```

Do not log unnecessary side/claim/address data.

### Exit criteria

A real testnet shielded payment updates the correct ticket automatically
after required confirmations.

------------------------------------------------------------------------

## 15. Phase 10 --- Payment Matcher

Implement SPEC rules.

### Exact payment

``` text
sum(qualifying receipts) == requested
    -> CONFIRMED
```

### Partial payment

Aggregate only qualifying payments before deadline.

### Excess

Never increase economic stake.

### Late

Mark according to chain-based close classification.

### Duplicate

Database uniqueness + idempotent handler.

### Reorg

Pre-finality state may roll back.

### Exit criteria

Automated tests pass for exact, under, over, partial, duplicate, late,
and reorg simulation cases.

------------------------------------------------------------------------

## 16. Phase 11 --- Automatic Close and Lock Finalization

Implement scheduler/state worker.

At close:

``` text
stop ticket issuance
    ↓
LOCK_FINALIZING (internal operational phase)
    ↓
scan/classify potentially timely payments
    ↓
wait configured confirmation threshold
    ↓
freeze accepted tickets
    ↓
commit ledger
    ↓
LOCKED
```

`LOCK_FINALIZING` may be an internal phase rather than public market
state.

Operator cannot manually insert accepted tickets after freeze.

------------------------------------------------------------------------

## 17. Phase 12 --- Ledger Commitment

Implement canonical record encoding.

For every accepted ticket:

1.  generate/store high-entropy record blinding;
2.  encode ledger record canonically;
3.  compute domain-separated leaf;
4.  sort by ticket ID;
5.  construct Merkle tree;
6.  persist root;
7.  publish market root/count.

### Required tests

-   same frozen ledger -\> same root;
-   changed side -\> different root;
-   changed amount -\> different root;
-   changed ticket membership -\> different root;
-   different blinding -\> different leaf;
-   odd-leaf behavior deterministic.

Do not publish record blindings.

------------------------------------------------------------------------

## 18. Phase 13 --- Resolution

Operator enters:

``` text
YES | NO | VOID
evidence URLs/text
```

Backend validates market is eligible for resolution.

Resolution is immutable once settlement begins.

If ambiguous under the market's published rule:

``` text
VOID
```

not discretionary YES/NO.

------------------------------------------------------------------------

## 19. Phase 14 --- Settlement Engine

Implement settlement as a pure/testable module before connecting wallet
spends.

Inputs:

``` text
locked ledger
resolution
fee mode
```

Outputs:

``` text
SettlementPlan
SettlementItems
reconciliation summary
```

### Cases

-   normal YES winner;
-   normal NO winner;
-   zero tickets;
-   one-sided winning market;
-   winning side has zero stake -\> NO_WINNER_REFUND;
-   fee subsidy;
-   pool-funded fee;
-   residual allocation;
-   large integer amounts.

### Invariant

``` text
sum(outputs) + pool_funded_fee <= available settlement funds
```

Fail closed on unexplained mismatch.

------------------------------------------------------------------------

## 20. Phase 15 --- Claim API

Implement:

``` text
POST /claim
```

or equivalent generic route.

Input:

``` text
market_id
ticket_id
claim_secret
payout_ua
idempotency_key
```

### Verification

Follow SPEC order exactly.

### Atomicity

Use database transaction/locking so only one request can move:

``` text
UNCLAIMED -> RESERVED
```

### Privacy

Return generic errors where detailed ticket information would leak.

------------------------------------------------------------------------

## 21. Phase 16 --- Refund API

Reuse the claim authentication path.

Support:

-   VOID refund;
-   NO_WINNER_REFUND;
-   defined excess/payment exception refunds.

A successful winner claim and successful refund MUST be mutually
exclusive.

------------------------------------------------------------------------

## 22. Phase 17 --- Simple Shielded Settlement First

Before PCZT/FROST integration, prove the entire application with the
simplest safe development signer.

Flow:

``` text
claim reserved
    ↓
settlement item
    ↓
construct shielded transaction
    ↓
sign
    ↓
broadcast
    ↓
confirm
    ↓
claim CONFIRMED
```

This is the first complete MVP milestone.

Do not wait for FROST to reach it.

------------------------------------------------------------------------

## 23. Phase 18 --- PCZT Separation

Once end-to-end payout works:

1.  produce immutable settlement plan;
2.  compute plan hash;
3.  construct/prove PCZT;
4.  move PCZT to signer boundary;
5.  signer verifies summary;
6.  sign;
7.  combine/finalize;
8.  broadcast;
9.  reconcile.

Test that changing destination or amount after plan creation
invalidates/requires a new plan.

------------------------------------------------------------------------

## 24. Phase 19 --- FROST 2-of-3

Only begin after PCZT path is stable.

### Tasks

-   initialize test signer shares using official/current tooling;
-   isolate three signer roles;
-   complete real 2-of-3 testnet spend;
-   integrate signing session behind existing signer interface;
-   test one unavailable signer;
-   test invalid share/session failure;
-   document recovery procedure.

### Stop condition

If FROST dependency/API friction threatens the complete demo, freeze it
as:

``` text
DEFERRED — integration validated separately / not active in MVP settlement
```

Do not destabilize the working product.

------------------------------------------------------------------------

## 25. Phase 20 --- Broadcast Reconciliation

Implement:

``` text
TX_PREPARING
AWAITING_SIGNATURE
BROADCAST
CONFIRMED
RETRYABLE_FAILURE
```

On timeout:

-   persist transaction reference if known;
-   query/reconcile status;
-   do not immediately construct replacement;
-   retry only when safe.

------------------------------------------------------------------------

## 26. Phase 21 --- Security Hardening

Before demo:

### Web

-   CSP;
-   no third-party scripts on ticket/claim pages;
-   output escaping;
-   CSRF protection for operator mutations;
-   operator authentication;
-   rate limiting;
-   request size limits;
-   secure headers.

### Secrets

-   no secrets in repository;
-   no claim secrets in logs;
-   no spending keys on web service;
-   signer secrets isolated;
-   backup handling documented.

### Database

-   least-privilege credentials;
-   uniqueness constraints;
-   backups;
-   sensitive access restricted.

### Privacy

-   generic prediction routes;
-   no side in URL;
-   no public market book;
-   minimize IP/access-log retention;
-   verify analytics disabled on sensitive flows.

------------------------------------------------------------------------

## 27. Phase 22 --- Failure Recovery

Document and test:

-   watcher restart;
-   API restart;
-   product DB restart;
-   wallet rescan;
-   chain endpoint outage;
-   failed broadcast;
-   signer unavailable;
-   browser loses ordinary local state but user imports ticket export;
-   PAUSE;
-   VOID/refund.

Recovery must not require changing economic rules after market opening.

------------------------------------------------------------------------

## 28. Phase 23 --- Demo Market

Prepare two market modes.

### A. Realistic primary market

A Zcash-relevant YES/NO question with:

-   objective wording;
-   clear close;
-   authoritative resolution source;
-   visible privacy story.

### B. Accelerated demo market

A controlled/already-resolvable event allowing judges to see:

``` text
OPEN -> payment -> LOCK -> resolution -> payout
```

without waiting days.

The accelerated market must use the same code path, not mocked
settlement.

------------------------------------------------------------------------

## 29. Required Demo Script

Target demo:

``` text
1. Show market OPEN.
2. Create 0.01 ZEC YES ticket.
3. Show fresh ZIP-321 request.
4. Pay shielded.
5. Watch ticket become CONFIRMED.
6. Create/pay a 0.02 ZEC NO ticket.
7. Show public page does not reveal sides/stakes.
8. Reach predefined close.
9. Show LOCKED + ledger root.
10. Resolve YES with evidence.
11. Show deterministic settlement.
12. Import/use winner bearer ticket.
13. Supply fresh shielded UA.
14. Prepare settlement transaction.
15. Authorize through actual implemented signer path.
16. Broadcast.
17. Show winner receives shielded payout.
18. Explain what the public chain cannot reveal.
```

If FROST works, show threshold authorization.

If it does not, state the active signer architecture accurately.

------------------------------------------------------------------------

## 30. Demo Failure Contingency

Prepare reproducible testnet state so a transient chain endpoint or
confirmation delay does not destroy the presentation.

Have:

-   a pre-funded wallet;
-   known testnet faucet/funding path;
-   pre-created accelerated market;
-   two compatible bettor wallets;
-   exported test tickets;
-   screenshots/log references only as backup evidence, not as a
    substitute for a working product;
-   one already completed end-to-end transaction to prove prior success
    if live network conditions fail.

------------------------------------------------------------------------

## 31. Milestones

### M0 --- Environment

Repo, web, Rust service, databases operational.

### M1 --- Zcash primitives

Fresh receiver, ZIP-321, view-only detection, matching, shielded payout
PASS.

### M2 --- Ticket MVP

Create ticket, local secret, payment request, local portfolio.

### M3 --- Deposit MVP

Real shielded payment automatically confirms correct ticket.

### M4 --- Market integrity

Automatic close, finalization, frozen ledger, Merkle root.

### M5 --- Economic MVP

Resolution + deterministic parimutuel settlement + refund logic.

### M6 --- Full lifecycle

Winner claims to fresh UA and receives shielded payout.

**At M6 the core hackathon product exists.**

### M7 --- PCZT

Construction/authorization separation works.

### M8 --- FROST

Real 2-of-3 threshold spend works, if feasible.

### M9 --- Hardened demo

Threat-model critical items pass and demo is rehearsed.

------------------------------------------------------------------------

## 32. Priority Classification

### P0 --- Cannot submit without it

-   one working market;
-   YES/NO variable stake;
-   fresh receiver;
-   ZIP-321;
-   shielded deposit;
-   watcher/matcher;
-   local bearer ticket;
-   deterministic close;
-   ledger commitment;
-   resolution;
-   settlement;
-   claim;
-   fresh shielded payout;
-   void/refund;
-   end-to-end demo.

### P1 --- Strongly desired

-   PCZT separation;
-   robust ticket export/import;
-   operator audit trail;
-   polished privacy explanation;
-   failure recovery;
-   strong web hardening.

### P2 --- Stretch

-   2-of-3 FROST;
-   payout batching;
-   encrypted ticket export;
-   additional post-resolution stats;
-   more than one simultaneous market.

### Explicitly out of scope

-   custom ZK;
-   AMM;
-   order book;
-   tradable shares;
-   decentralized oracle;
-   cross-chain;
-   fiat;
-   mobile wallet;
-   production compliance system.

------------------------------------------------------------------------

## 33. Suggested Work Sequence

A practical implementation sequence is:

``` text
Day/Block 1:
environment + wallet spike

Day/Block 2:
fresh receivers + ZIP-321 + view-only scan

Day/Block 3:
ticket DB + local ticket vault + payment matching

Day/Block 4:
market state + close + ledger commitment

Day/Block 5:
resolution + pure settlement engine

Day/Block 6:
claim/refund + simple shielded payout

Day/Block 7:
end-to-end fixes + test vectors

Day/Block 8:
PCZT separation

Day/Block 9:
FROST attempt if core is stable

Final block:
security hardening + demo rehearsal + submission assets
```

These are implementation blocks, not promises about calendar duration.
If a block slips, preserve P0 functionality first.

------------------------------------------------------------------------

## 34. Definition of Done for Core MVP

The core MVP is done only when all of the following work in one
integrated environment:

-   [ ] market can be configured and opened;
-   [ ] bettor can choose YES/NO and amount;
-   [ ] client creates 256-bit claim secret;
-   [ ] server stores only commitment;
-   [ ] fresh diversified receiver is issued;
-   [ ] ZIP-321 request works in compatible wallet;
-   [ ] shielded payment is detected;
-   [ ] correct ticket becomes confirmed;
-   [ ] public UI reveals no live side/stake book;
-   [ ] close prevents new ticket issuance;
-   [ ] potentially timely payments are finalized deterministically;
-   [ ] accepted ledger is frozen;
-   [ ] blinded Merkle root is produced;
-   [ ] market resolves YES/NO/VOID;
-   [ ] integer settlement reconciles;
-   [ ] winner can authenticate with bearer secret;
-   [ ] double claim fails;
-   [ ] fresh payout UA is accepted;
-   [ ] shielded payout broadcasts and confirms;
-   [ ] VOID refund works;
-   [ ] web service has no spending key;
-   [ ] ordinary logs contain no claim secrets;
-   [ ] demo can be repeated from a clean/reproducible state.

------------------------------------------------------------------------

## 35. Documentation Produced During Build

In addition to existing design documents, implementation should produce:

``` text
README.md
docs/SPIKE_RESULTS.md
docs/TEST_PLAN.md
docs/DEMO_SCRIPT.md
docs/KNOWN_LIMITATIONS.md
.env.example
test-vectors/*
```

`KNOWN_LIMITATIONS.md` is particularly important if FROST or another
desired feature is not completed.

------------------------------------------------------------------------

## 36. Stop-Building Rules

To prevent hackathon scope creep:

If the core lifecycle is not yet complete, do **not** spend time on:

-   custom ZK;
-   fancy charts;
-   multiple markets;
-   mobile responsiveness beyond basic usability;
-   elaborate operator dashboard;
-   payout batching;
-   encrypted ticket backups;
-   FROST debugging beyond a reasonable spike window;
-   post-resolution analytics.

The next engineering task should always be the earliest broken link in:

`ticket -> shielded deposit -> lock -> resolve -> claim -> shielded payout`

------------------------------------------------------------------------

## 37. Final Implementation Principle

The project should be judged by what actually works, not by how
ambitious the architecture diagram looks.

The implementation target is therefore:

> A repeatable end-to-end shielded prediction pool in which a bettor can
> create an accountless bearer ticket, fund it through a fresh Zcash
> receiver, remain absent from a public order book, pass through a
> deterministic market close and settlement, and claim the correct
> payout to a fresh shielded destination.

PCZT and FROST strengthen that core. They do not replace it.

## 38. Authorized disposable-TEST operational bridge — 24 October 2026

Implemented synthetically: actual browser vault/issuance -> synthetic allocation
interface -> native ZIP-321 -> unchanged watcher reconciliation -> authenticated
private status -> existing atomic lock/retained-blinding root verification.
See [DISPOSABLE_TEST_OPERATIONAL_BRIDGE.md](DISPOSABLE_TEST_OPERATIONAL_BRIDGE.md)
for commands, boundaries and attributable evidence.

Validation: 6 status/unit, 10 PostgreSQL/browser demo, 14 existing issuance/ZIP-321
browser and 113 focused frozen-protocol regression tests passed. Final runs have
zero failures/skips/cancellations; earlier failed development evidence is retained.
The demo excludes late/wrong-receiver payments, enforces confirmations and roles,
and proves rollback/replay/concurrent-lock safety. Publication stays PENDING;
no resolutions, claims or payouts result.

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev/operational-bridge-tests.ps1 -Action demo`
from the repository root as the normal TEST operator. Only new OID-bound disposable
fixtures on already-running TEST/55433 are mutated; DEV V2/55435 remains status-only.
No existing migration or financial algorithm changes.

Next: reviewed operational issuer/allocator/view-only scan launcher and
purpose-specific sessions for a separately approved financial target. Financial
target identity/custody, payout-capable pre-OPEN policy, real publication
authorization and wallet execution remain blockers. Synthetic success is not a
genuine deposit/full testnet lifecycle. Production trust stays UNAVAILABLE,
financial authorization NOT_GRANTED, and the optional TSA milestone stays closed.

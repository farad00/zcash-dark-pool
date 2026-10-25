# Architecture

## Zcash-Native Dark Prediction Pool

**Document status:** MVP Architecture Baseline\
**Version:** 1.0\
**Date:** 1 October 2026\
**Depends on:** `PRD.md` v1.0 (updated clarification baseline)\
**Purpose:** Define how the approved MVP is decomposed into components,
trust boundaries, data stores, Zcash wallet roles, transaction flows,
and deployment responsibilities. Protocol-level encodings and exact
edge-case rules are deferred to `SPEC.md`.

------------------------------------------------------------------------

## 1. Architecture Goals

The architecture must implement the PRD without weakening its privacy
model.

The system must:

1.  keep prediction deposits and payouts shielded;
2.  allocate a fresh diversified shielded receiver to each ticket;
3.  avoid requiring a server-side personal account;
4.  allow a bettor to manage multiple independent tickets locally;
5.  keep the public market book dark while the market is open;
6.  detect incoming payments using viewing authority without putting
    spending authority on the public web server;
7.  deterministically map a received payment to its ticket;
8.  freeze the accepted ledger when the predefined closing condition is
    reached;
9.  commit to that frozen ledger without revealing its contents;
10. calculate deterministic parimutuel settlement;
11. authenticate claims using bearer ticket credentials rather than
    personal identity;
12. pay or refund to fresh shielded destinations;
13. separate transaction construction from transaction authorization;
14. support a path to 2-of-3 FROST without making FROST a blocker for
    the working MVP;
15. make accepted privacy limitations explicit rather than hiding them
    behind architecture diagrams.

------------------------------------------------------------------------

## 2. Architectural Principles

### 2.1 Zcash is the settlement and privacy layer

The application should use current maintained Zcash wallet libraries for
shielded address derivation, scanning, note handling, transaction
construction, proving, signing integration, and broadcasting.

The application must not reimplement Orchard transaction rules manually.

### 2.2 Product state and wallet state are different

Prediction-market records and Zcash wallet synchronization data serve
different purposes and should remain logically separated.

The product database knows about markets, tickets, claims, outcomes, and
settlement state.

The wallet database knows about chain synchronization, notes,
transactions, addresses/diversifiers, and spend-related wallet state.

A controlled matcher links the two.

### 2.3 Least privilege

A component receives only the authority required for its role.

In particular:

-   the public frontend receives no wallet secrets;
-   the ordinary web/API service receives no market spending key;
-   the watcher receives viewing capability, not spending capability;
-   the settler prepares transactions but should not unilaterally
    authorize spending;
-   signing authority is isolated from public request handling.

### 2.4 Accountless does not mean stateless

A bettor can hold many tickets without creating a server-side personal
account.

The browser/client maintains a local portfolio of bearer tickets. The
server maintains each ticket independently for settlement but does not
need an account identifier linking all tickets to one person.

### 2.5 Privacy is end-to-end

Using Orchard is not enough if the website publishes or logs the hidden
information.

The architecture therefore treats:

-   frontend state;
-   HTTP routes;
-   analytics;
-   application logs;
-   product database;
-   wallet viewing keys;
-   signer infrastructure;
-   timing;

as part of the privacy design.

------------------------------------------------------------------------

## 3. High-Level Architecture

``` text
                           BETTOR DEVICE
                 ┌────────────────────────────┐
                 │ Public Web UI              │
                 │ Local Ticket Vault         │
                 │ claim_secret generation    │
                 └─────────────┬──────────────┘
                               │ HTTPS
                               ▼
                 ┌────────────────────────────┐
                 │ API / TICKET SERVICE       │
                 │                            │
                 │ market reads               │
                 │ ticket issuance            │
                 │ claim commitment handling  │
                 │ state validation           │
                 └───────┬───────────┬────────┘
                         │           │
              product DB │           │ request fresh
                         ▼           │ receiver
              ┌────────────────┐     ▼
              │ PRODUCT DB     │  ┌──────────────────────┐
              │ markets        │  │ ZCASH WALLET SERVICE │
              │ tickets        │  │ address allocation   │
              │ claims         │  │ wallet operations    │
              │ commitments    │  └──────────┬───────────┘
              │ settlements    │             │
              └────────────────┘             │
                                             ▼
                                     ZIP-321 request
                                             │
                                             ▼
                                      BETTOR WALLET
                                             │
                                      shielded ZEC
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │ MARKET VAULT         │
                                  │ Orchard shielded     │
                                  │ account/authority    │
                                  └──────────┬───────────┘
                                             │ chain
                                             ▼
                    ┌─────────────────────────────────────┐
                    │ LIGHT CLIENT / CHAIN DATA SOURCE    │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
                            ┌───────────────────┐
                            │ WATCHER / SCANNER │
                            │ viewing authority │
                            │ no spend authority│
                            └─────────┬─────────┘
                                      │ confirmed receipt
                                      ▼
                              PAYMENT MATCHER
                                      │
                                      ▼
                                  PRODUCT DB


             AFTER LOCK / RESOLUTION / VALID CLAIM

                  PRODUCT DB + WALLET STATE
                             │
                             ▼
                       SETTLEMENT ENGINE
                             │
                       payout plan
                             │
                             ▼
                       PCZT BUILDER/PROVER
                             │
                             ▼
                   AUTHORIZATION BOUNDARY
                     ┌────────┴────────┐
                     │                 │
               MVP signer        FROST 2-of-3
               fallback          desired path
                     │                 │
                     └────────┬────────┘
                              ▼
                       finalized transaction
                              │
                              ▼
                           BROADCAST
                              │
                              ▼
                       ZCASH SHIELDED POOL
                              │
                              ▼
                    fresh winner/refund UA
```

------------------------------------------------------------------------

## 4. Core Components

## 4.1 Public Web UI

### Responsibilities

The public UI:

-   displays the market question and rules;
-   displays market status;
-   allows YES or NO selection;
-   accepts a stake amount;
-   requests ticket creation;
-   displays the ZIP-321 payment request/QR;
-   displays payment status;
-   stores the bettor's ticket credentials locally;
-   displays the bettor's locally known predictions;
-   supports ticket export/recovery;
-   accepts a fresh payout/refund UA during claim;
-   does not expose the live market book.

### Must not contain

The frontend must not receive or expose:

-   market spending keys;
-   viewing keys;
-   other bettors' sides;
-   other bettors' stakes;
-   side-specific totals;
-   private settlement records.

### Route privacy

Avoid public URLs such as:

`/market/nu7/bet/YES`

if server/access logs would thereby record the prediction side.

Prefer a generic route such as:

`/market/{id}/predict`

with sensitive choice submitted in a minimized request body.

This does not make the operator blind; it reduces unnecessary metadata
exposure.

------------------------------------------------------------------------

## 4.2 Local Ticket Vault

The bettor's browser/device maintains locally owned ticket credentials.

Conceptually:

``` text
LocalTicket {
    market_id
    ticket_id
    side
    requested_amount
    claim_secret
    receiver
    status_cache
}
```

The exact representation will be defined in `SPEC.md`.

### Properties

-   multiple tickets can be stored;
-   tickets do not require a server account;
-   local entries may be grouped into a "My Predictions" UI;
-   the server does not need a `user_id` joining all tickets;
-   export/recovery must preserve the ticket ID and claim secret;
-   local storage must not be treated as the only backup mechanism.

### MVP storage

Browser storage may be used for convenience, but secrets should not be
casually exposed to analytics or application logs.

A ticket export mechanism is required by the PRD clarification. The
final format will be specified separately.

------------------------------------------------------------------------

## 4.3 API / Ticket Service

### Responsibilities

The API:

-   serves public market data;
-   validates market state;
-   accepts a proposed side and stake;
-   coordinates fresh receiver allocation;
-   creates the ticket record;
-   stores the claim commitment;
-   returns the payment request;
-   reports ticket payment state;
-   accepts claim/refund requests;
-   invokes settlement workflows after eligibility checks.

### Authority

The API must not possess unrestricted market spending authority.

It may communicate with the wallet/address service through a narrow
internal interface.

### Side visibility

Under the official MVP privacy model, the application/operator may know
the side associated with a ticket.

Future ZK operator-blind positions may change this, but no current
component should pretend that property exists.

------------------------------------------------------------------------

## 4.4 Product Database

A relational database such as PostgreSQL is suitable for product state.

Logical entities:

``` text
markets
tickets
claims
market_ledger_commitments
resolutions
settlement_runs
settlement_items
refunds
audit_events
```

Exact tables belong in `SPEC.md`.

### Product DB contains

-   market definitions;
-   private ticket side;
-   requested and accepted stake;
-   receiver/diversifier reference;
-   claim commitment;
-   lifecycle state;
-   resolution data;
-   payout/refund state;
-   settlement references.

### Product DB must not require

-   bettor email;
-   bettor username;
-   bettor phone;
-   social identity;
-   a server-side account linking all tickets.

### Sensitive database status

The product database is privacy-sensitive even though the chain is
shielded.

A database compromise may reveal the operator-visible market book.
Encryption at rest, access control, backup handling, and log
minimization are therefore security requirements.

------------------------------------------------------------------------

## 4.5 Zcash Wallet Service

This is the application's interface to current Zcash wallet
functionality.

Likely implementation language: **Rust**, using compatible versions of
the maintained Zcash Rust wallet stack.

Candidate responsibilities include:

-   wallet/account initialization;
-   diversified receiver allocation;
-   wallet database interaction;
-   ZIP-321 construction support;
-   chain scanning integration;
-   received-note querying;
-   PCZT creation/proving support;
-   broadcast integration.

The exact crates and pinned versions are an implementation-plan decision
after a compatibility spike.

### Important rule

Do not manually construct Orchard transactions to bypass wallet-library
behavior.

Protocol upgrades such as Ironwood/NU6.3 make current library
compatibility important.

------------------------------------------------------------------------

## 4.6 Market Vault

The market vault is the shielded Zcash authority holding accepted stakes
before payout/refund.

### One vault, not public YES/NO pots

The architecture uses **one market vault/account context**, with fresh
diversified receivers for individual tickets.

The side is maintained in private application state rather than encoded
by publishing a recognizable YES pot and NO pot.

Conceptually:

``` text
Market Vault
├── receiver A -> ticket A -> YES
├── receiver B -> ticket B -> NO
├── receiver C -> ticket C -> YES
└── receiver D -> ticket D -> NO
```

Externally, these receivers should not form a public side-labelled order
book.

### Why this is preferred

It:

-   avoids publishing a YES address and NO address;
-   reduces side-level blockchain metadata;
-   simplifies custody compared with maintaining separate threshold
    vaults;
-   lets the private matcher determine ticket/side association.

Implementation must validate the chosen wallet/account arrangement with
current diversified-address and signing tooling.

------------------------------------------------------------------------

## 4.7 Wallet Database

The Zcash wallet layer should use its own wallet-state database, likely
through the maintained Zcash client SQLite facilities.

It may contain:

-   scanned blocks;
-   wallet transactions;
-   received notes;
-   diversifier/address metadata;
-   nullifier/spend state;
-   synchronization checkpoints.

This database is not the prediction-market product database.

------------------------------------------------------------------------

## 4.8 Chain Data Source

The wallet service/watcher needs a supported source of Zcash chain data,
such as a compatible lightwalletd/Zaino deployment or service.

### Requirements

-   testnet support during development;
-   reliable block synchronization;
-   compatibility with selected wallet libraries;
-   no assumption that the chain data provider provides application
    privacy;
-   operational monitoring for sync lag.

A watcher outage must not alter market truth; it may delay the
application's knowledge of a payment.

------------------------------------------------------------------------

## 4.9 Watcher / Scanner

The watcher scans Zcash for incoming shielded notes belonging to the
market's viewing authority.

### Authority

The watcher should hold viewing capability sufficient for the required
deposit reconciliation but **not spending authority**.

The exact key type/capability used must be validated against the
selected Orchard wallet stack. The architecture requirement is least
privilege; `SPEC.md`/implementation must not overstate what a narrower
viewing key can do without testing it.

### Responsibilities

-   synchronize wallet state;
-   detect candidate received notes;
-   identify the receiving address/diversifier where supported;
-   provide received amount and relevant internal transaction/note
    references;
-   send normalized receipt events to the matcher;
-   handle re-scans idempotently.

### It must not

-   decide YES/NO;
-   calculate market outcome;
-   sign spends;
-   publish the viewing key;
-   expose received notes publicly.

------------------------------------------------------------------------

## 4.10 Payment Matcher

The matcher connects Zcash wallet state to prediction tickets.

Conceptually:

``` text
received shielded note
        ↓
recognized receiver/diversifier
        ↓
ticket lookup
        ↓
deposit acceptance rules
        ↓
accepted_amount
        ↓
ticket = CONFIRMED
```

### Determinism

The matcher must implement the exact rules later frozen in `SPEC.md`
for:

-   confirmations/finality;
-   underpayment;
-   overpayment;
-   multiple payments;
-   late payments;
-   reorgs;
-   duplicate scan events.

The matcher must be idempotent.

------------------------------------------------------------------------

## 4.11 Market State Engine

The market state engine enforces lifecycle transitions.

Normal path:

``` text
DRAFT -> OPEN -> LOCKED -> RESOLVED -> PAYING -> CLOSED
```

Exceptional paths:

``` text
OPEN -> PAUSED -> OPEN
OPEN/PAUSED/LOCKED -> VOID -> REFUNDING -> CLOSED
```

### OPEN -\> LOCKED

This transition must be based on the closing condition defined before
the market opens.

The operator must not normally be able to choose an arbitrary
earlier/later close after observing predictions.

The final close primitive remains to be frozen in `SPEC.md`:

-   wall-clock deadline;
-   Zcash block height;
-   or a deterministic rule combining them.

### PAUSED

PAUSED is an exceptional safety mechanism, not a discretionary
market-timing control.

Architecture must record:

-   who invoked it;
-   reason;
-   timestamp/height;
-   prior state;
-   subsequent action.

Authorization and payment treatment are specified later.

------------------------------------------------------------------------

## 4.12 Ledger Commitment Builder

At lock, the accepted market ledger is canonicalized and committed.

Input records may conceptually bind:

-   market;
-   ticket;
-   side;
-   accepted stake;
-   accepted payment reference;
-   randomness/salt.

The final construction must be **binding and hiding**.

A naïve hash such as:

`H(ticket_id || YES || 0.1 ZEC)`

is insufficient if low-entropy fields can be guessed.

A salted/hiding commitment or commitment tree will be specified in
`SPEC.md`.

### Purpose

The commitment makes post-lock modification detectable.

### Non-purpose

It does not prove:

-   that every legitimate payment was included;
-   that the operator did not create fake tickets;
-   that the oracle outcome is correct.

Those are separate trust/audit concerns.

------------------------------------------------------------------------

## 4.13 Resolution Service

Resolution is manual but rule-bound.

It records:

-   market;
-   YES/NO/VOID result;
-   evidence/source references;
-   resolution time;
-   operator/referee authorization;
-   immutable audit event.

The resolution service cannot alter the locked ticket set.

Where practical, the signing/referee process should review the
resolution evidence before authorizing settlement.

------------------------------------------------------------------------

## 4.14 Settlement Engine

The settlement engine operates after a valid resolution.

Inputs:

-   locked accepted ticket set;
-   accepted stakes;
-   resolved outcome;
-   vault spendable balance;
-   fee/rounding rules.

Outputs:

-   winning ticket entitlements;
-   deterministic payout amounts;
-   settlement totals;
-   reconciliation report;
-   payout plan.

Conceptual formula:

``` text
payout_i =
    stake_i / total_winning_stake
    * total_market_pool
```

All actual arithmetic must be integer-zatoshi arithmetic according to
`SPEC.md`.

### Settlement invariant

The total amount authorized for outputs plus required fees must never
exceed the spendable market funds allocated to that settlement.

------------------------------------------------------------------------

## 4.15 Claim Service

A claimant submits:

-   ticket ID;
-   claim secret;
-   fresh payout UA.

The claim service:

1.  verifies the claim commitment;
2.  verifies market/ticket eligibility;
3.  verifies winning/refund state;
4.  rejects prior successful claim/refund;
5.  validates the destination;
6.  binds the destination to the claim;
7.  creates an immutable claim record;
8.  requests transaction preparation.

### Concurrency

Claim state changes must be atomic.

Two simultaneous requests with the same bearer credential must not
create two valid payouts.

------------------------------------------------------------------------

## 4.16 PCZT Builder / Prover

The PCZT boundary separates the decision:

> "These are the outputs the market intends to pay."

from:

> "The vault authorizes spending these funds."

The online settlement side should be able to prepare/prove the
transaction without possessing unrestricted signing authority.

### Inputs

-   validated payout/refund plan;
-   fresh destination UAs;
-   amounts;
-   required wallet inputs/notes;
-   current chain state.

### Output

A PCZT suitable for the configured signing workflow.

The exact order of creation, proving, signing, combining, finalization,
and broadcast must follow the selected current Zcash library/tooling
versions.

------------------------------------------------------------------------

## 4.17 Signing Service

### Desired architecture: 2-of-3 FROST

Conceptual signers:

``` text
Signer A: market operator
Signer B: independent/referee signer
Signer C: recovery signer
```

Any valid threshold of two can authorize a spend.

No single signer can move the vault alone.

### Signer review

Before authorizing settlement, signers should receive enough structured
information to verify that the proposed transaction corresponds to an
approved market resolution and settlement plan.

FROST does not itself prove that those business rules are correct.

### MVP fallback

FROST is not allowed to prevent a working submission.

Build sequence:

``` text
working shielded spend
        ↓
PCZT separation
        ↓
FROST 2-of-3
```

If current FROST integration remains unreliable, the demo may use the
simpler signer architecture with the limitation disclosed.

No fake or simulated FROST security claim is acceptable.

------------------------------------------------------------------------

## 4.18 Broadcaster

The broadcaster submits a fully authorized transaction to the Zcash
network.

It must:

-   record broadcast attempts;
-   record transaction identifiers internally as needed;
-   monitor inclusion/failure;
-   avoid marking a claim fully paid solely because a broadcast RPC
    returned success;
-   support safe retry semantics without reconstructing duplicate
    payouts.

------------------------------------------------------------------------

## 5. Ticket Creation Flow

``` text
1. Bettor chooses YES/NO and stake locally.

2. Client generates claim_secret using a CSPRNG.

3. Client derives claim commitment input
   according to SPEC.md.

4. API validates:
   market == OPEN
   stake within rules.

5. Wallet service allocates fresh diversified
   shielded receiver.

6. API creates independent ticket:
   ticket_id
   market_id
   side
   requested stake
   receiver/diversifier ref
   claim_commitment
   state = AWAITING_PAYMENT

7. Server returns:
   ticket_id
   fresh receiver
   ZIP-321 request
   expiry/close information.

8. Browser stores:
   ticket_id
   claim_secret
   local market metadata.

9. User pays from compatible Zcash wallet.
```

Sensitive information should not be duplicated into unnecessary logs.

------------------------------------------------------------------------

## 6. Deposit Confirmation Flow

``` text
Zcash network
     ↓
chain data source
     ↓
watcher scans with viewing authority
     ↓
received note recognized
     ↓
wallet receiver/diversifier association
     ↓
payment matcher
     ↓
ticket
     ↓
acceptance/finality rules
     ↓
CONFIRMED
```

### Critical requirement

The application must not depend on a memo containing `YES` or `NO` to
identify the ticket.

The unique receiver provides the matching context.

------------------------------------------------------------------------

## 7. Multi-Ticket User Flow

A bettor may create:

``` text
Ticket A -> Market 1 -> YES
Ticket B -> Market 2 -> NO
Ticket C -> Market 3 -> YES
Ticket D -> Market 4 -> NO
```

Their browser can display all four under "My Predictions."

Server-side, the records remain:

``` text
ticket A
ticket B
ticket C
ticket D
```

without requiring:

``` text
user_123 -> A, B, C, D
```

The operator may still infer relationships through off-chain metadata;
accountlessness reduces unnecessary explicit linkage but is not a claim
of perfect unlinkability.

------------------------------------------------------------------------

## 8. Lock Flow

The closing rule is committed before OPEN.

At the closing boundary:

``` text
OPEN
  ↓
closing condition satisfied
  ↓
stop issuing valid new tickets
  ↓
apply deterministic pending-payment rules
  ↓
freeze accepted tickets
  ↓
canonicalize ledger
  ↓
build hiding ledger commitment
  ↓
publish/record commitment
  ↓
LOCKED
```

The exact order around late/pending payments will be specified carefully
to avoid race conditions.

The operator may finalize operational steps, but does not normally
choose the close time after observing market activity.

------------------------------------------------------------------------

## 9. Resolution Flow

``` text
LOCKED
   ↓
resolution condition reached
   ↓
operator/referee examines predefined sources
   ↓
YES / NO / VOID
   ↓
resolution record + evidence
   ↓
if YES/NO:
    RESOLVED
else:
    VOID
```

Resolution evidence should be public even though the prediction ledger
remains private.

------------------------------------------------------------------------

## 10. Winning Claim and Payout Flow

``` text
bettor local ticket
     │
ticket_id
claim_secret
fresh payout UA
     │
     ▼
claim service
     │
verify commitment
verify ticket funded
verify winner
verify not claimed
validate fresh destination
     │
     ▼
reserve claim atomically
     │
     ▼
settlement entitlement
     │
     ▼
PCZT builder/prover
     │
     ▼
signing boundary
     │
     ▼
authorized transaction
     │
     ▼
broadcast
     │
     ▼
shielded payout
     │
     ▼
winner wallet
```

A failed broadcast or unconfirmed transaction must not permanently
consume the claim without a recovery/retry state.

------------------------------------------------------------------------

## 11. Void and Refund Flow

``` text
market -> VOID
          ↓
valid funded ticket
          ↓
ticket_id + claim_secret
          ↓
fresh refund UA
          ↓
verify entitlement
          ↓
refund accepted stake
          ↓
PCZT/sign/broadcast
          ↓
shielded refund
```

The application must not attempt to derive or guess the original sender
address.

------------------------------------------------------------------------

## 12. Privacy Boundaries

### 12.1 Public observer

Should not learn from the application or public chain:

-   ticket side;
-   stake amount;
-   live side totals;
-   payout amount;
-   conventional wallet-to-position relationship.

### 12.2 Other bettor

Receives no additional market-book visibility beyond intentionally
public market metadata.

### 12.3 Operator/application

For MVP settlement, can know:

-   ticket;
-   side;
-   accepted stake;
-   receipt status;
-   claim destination when submitted.

This is the primary accepted privacy limitation.

### 12.4 Watcher

Can observe market incoming activity according to the capabilities of
its viewing authority.

Compromise of the watcher/viewing key is a privacy breach even if it is
not a direct spending-key breach.

### 12.5 Signers

Can authorize spends and may see transaction/settlement information
required by the signing workflow.

Threshold signing reduces unilateral custody risk, not necessarily
information visibility.

------------------------------------------------------------------------

## 13. Key and Capability Separation

Conceptual authority model:

``` text
PUBLIC FRONTEND
    no Zcash secret authority

API
    product DB access
    narrow wallet-service calls

ADDRESS/WALLET SERVICE
    address derivation capability as required

WATCHER
    viewing capability
    no spending authority

SETTLER
    product + wallet state required to construct plan
    no unilateral spending authority

SIGNER(S)
    spending authorization material/share
    isolated from public request handling

RECOVERY SIGNER
    offline/cold where practical
```

The exact Unified Viewing Key / incoming viewing capability split must
be validated with the selected library version before documenting a
narrower capability as sufficient.

------------------------------------------------------------------------

## 14. Data Classification

### Public

-   market question;
-   rules;
-   opening/closing information;
-   status;
-   resolution evidence;
-   published ledger commitment;
-   optional total ticket count.

### Confidential application data

-   ticket side;
-   accepted stake;
-   ticket-receiver mapping;
-   claim commitment;
-   settlement entitlements;
-   payout destination before/on settlement;
-   wallet viewing data.

### Secret

-   claim secret;
-   spending key;
-   FROST secret shares;
-   recovery material;
-   database credentials;
-   signing-service credentials.

Different classes must not be mixed casually in logs or analytics.

------------------------------------------------------------------------

## 15. Logging Architecture

Logs should be structured around operational identifiers without
duplicating sensitive values.

Prefer:

``` text
ticket_event:
    ticket_ref = internal opaque ID
    event = PAYMENT_CONFIRMED
```

Avoid:

``` text
IP=...
ticket=...
side=YES
amount=...
claim_secret=...
payout_address=...
```

in one log event.

### Never log

-   plaintext claim secrets;
-   spending keys;
-   FROST shares;
-   seed phrases.

Sensitive side/amount/address logging should be disabled or minimized
and access-controlled.

------------------------------------------------------------------------

## 16. Deployment Boundaries

For the hackathon, components may share infrastructure for practicality,
but **logical privilege separation must remain**.

A reasonable deployment is:

``` text
Service A:
Frontend/API

Service B:
Rust Zcash wallet/watcher service

Service C:
Settlement/PCZT worker

Signer environment:
separate process/machine or offline workflow

Databases:
PostgreSQL product DB
Zcash wallet SQLite DB
```

A single development machine may host several services during early
development, but production-like demonstrations should preserve key
separation.

------------------------------------------------------------------------

## 17. Suggested Technology Stack

### Frontend

-   Next.js / React or similarly lightweight web framework;
-   client-side cryptographic randomness through platform CSPRNG;
-   QR rendering for ZIP-321;
-   local ticket vault/export functionality.

### API/Product Backend

Either:

-   Next.js server/API for product orchestration plus a Rust Zcash
    service; or
-   a dedicated backend service if implementation complexity warrants
    it.

### Zcash Integration

Rust is preferred for the Zcash-specific service because the maintained
Zcash wallet ecosystem is Rust-native.

Candidate libraries/components, to be pinned after compatibility
testing:

-   `zcash_client_backend`;
-   `zcash_client_sqlite`;
-   `zcash_keys`;
-   current ZIP-321 support;
-   `pczt`;
-   `orchard`;
-   compatible FROST tooling where used.

Exact versions belong in `IMPLEMENTATION_PLAN.md` after a reproducible
spike.

### Product Database

-   PostgreSQL preferred;
-   SQLite acceptable for a strictly local demo but less appropriate for
    concurrent web/API operation.

### Wallet Database

-   maintained Zcash wallet SQLite facilities.

------------------------------------------------------------------------

## 18. Network Environments

### Development

Use Zcash testnet/current supported test environment.

### Demo

Prefer testnet or tightly controlled tiny-value testing.

### Production

Out of scope for Zecathon MVP. Production deployment would require
additional security review, operational hardening, legal review,
cryptographic review, key-management procedures, and monitoring.

------------------------------------------------------------------------

## 19. Security Invariants

The architecture must preserve these invariants:

1.  Public web compromise alone must not expose the market spending key.
2.  Watcher compromise alone must not permit spending.
3.  A ticket ID alone must not authorize a claim.
4.  A successful claim/refund may occur at most once per eligible
    ticket.
5.  New tickets cannot become valid after the deterministic closing rule
    except as explicitly allowed by a predeclared pending-payment rule.
6.  Locked ledger records cannot be silently rewritten without
    invalidating the published commitment.
7.  Payout totals plus fees cannot exceed the funds allocated to
    settlement.
8.  Transparent fallback cannot happen silently.
9.  The application must not publish live side-specific market
    information.
10. FROST must never be claimed as active unless the actual spend
    authorization uses the threshold scheme.
11. PAUSE must not be treated as an ordinary operator-controlled early
    close.
12. VOID must lead to the defined refund path rather than discretionary
    redistribution.

------------------------------------------------------------------------

## 20. Failure Isolation

### Frontend failure

Should not destroy server ticket records or vault funds. Bettor recovery
depends on preserved bearer ticket credentials.

### API failure

Should stop new ticket issuance safely without affecting custody.

### Watcher failure

May delay confirmations. Must not cause the system to conclude that an
on-chain payment did not exist solely because scanning was temporarily
unavailable.

### Product DB failure

Requires backup/recovery. A restored database must reconcile against
wallet/chain state.

### Wallet DB failure

Should be recoverable through wallet restoration/rescan procedures,
subject to preserved key material and wallet metadata.

### Signer failure

Should prevent unauthorized movement rather than trigger unsafe
fallback.

### One FROST signer unavailable

A 2-of-3 design should continue if two valid signers remain.

### Two-signature collusion

Can authorize spending in a 2-of-3 design. This is an accepted threshold
trust assumption.

------------------------------------------------------------------------

## 21. FROST Integration Boundary

FROST is deliberately isolated behind the signing interface.

The settlement side should not care whether authorization is currently:

``` text
sign(pczt) -> single authorized signer
```

or:

``` text
sign(pczt) -> threshold FROST session -> signature
```

This lets the team ship the complete product lifecycle first and upgrade
custody without rewriting ticketing or settlement.

------------------------------------------------------------------------

## 22. Future ZK Upgrade Boundary

Operator-blind privacy should also be architecturally isolated.

Potential future flow:

``` text
ticket service
    ↓
position commitment
    ↓
ZK proof
    ↓
operator cannot read side while open
```

Later research may extend this to hidden-stake/private settlement.

The current MVP must not bake assumptions into public APIs that make
such an upgrade impossible, but it must also not complicate the MVP with
unused ZK infrastructure.

The likely integration point is the boundary between:

-   ticket creation;
-   private position representation;
-   locked-ledger representation;
-   settlement eligibility.

------------------------------------------------------------------------

## 23. Architectural Decisions Frozen by This Document

Unless later testing proves one technically impossible, the following
are now architectural decisions:

1.  Shielded-only value flow.
2.  Fresh diversified receiver per ticket.
3.  One market vault/account context rather than public YES/NO pot
    addresses.
4.  Side stored privately by the application for the MVP.
5.  No requirement for YES/NO in the Zcash memo.
6.  Accountless participation with local multi-ticket management.
7.  Separate product DB and Zcash wallet DB.
8.  View-only watcher separated from spending authorization.
9.  Deterministic OPEN -\> LOCKED transition based on a predefined
    closing rule.
10. PAUSED is exceptional and distinct from LOCKED.
11. Hiding ledger commitment at lock.
12. Manual rule-bound oracle for MVP.
13. Parimutuel settlement.
14. Bearer claim secret + server commitment.
15. Fresh payout/refund UA supplied by claimant.
16. PCZT-style construction/authorization separation.
17. FROST 2-of-3 is desired but non-blocking.
18. Operator privacy through custom ZK is future work.

------------------------------------------------------------------------

## 24. Items Deliberately Deferred to SPEC.md

The architecture does not silently decide the following:

-   exact market-close primitive;
-   payment finality/confirmation rule;
-   late-payment boundary;
-   underpayment;
-   overpayment;
-   multiple payments to one ticket;
-   exact ticket ID format;
-   exact claim-secret format;
-   hash/domain separation;
-   canonical ledger serialization;
-   commitment/Merkle construction;
-   integer payout rounding;
-   fee allocation;
-   dust handling;
-   one-sided/zero-liquidity markets;
-   claim expiration;
-   refund expiration;
-   batching policy;
-   transaction retry state machine;
-   exact PAUSE authority and reopening rules;
-   local ticket export encoding.

Those decisions are protocol behavior and belong in the next document.

------------------------------------------------------------------------

## 25. Architecture Validation Checklist

Before implementation is considered architecture-complete, the team must
demonstrate:

-   [ ] fresh diversified receivers can be generated reproducibly with
    the selected stack;
-   [ ] receiver/ticket mapping survives wallet synchronization/restart;
-   [ ] view-only scanning detects the required incoming payment
    information;
-   [ ] watcher can operate without spending authority;
-   [ ] product DB and wallet DB can reconcile idempotently;
-   [ ] a shielded payout can be constructed to a fresh UA;
-   [ ] PCZT construction/proving/signing/broadcast works with pinned
    versions;
-   [ ] claim concurrency cannot create duplicate payouts;
-   [ ] lock prevents new accepted tickets according to the final close
    rule;
-   [ ] ledger commitment is hiding and reproducible;
-   [ ] void/refund path works end to end;
-   [ ] FROST path is either demonstrated for real or clearly marked
    incomplete.

------------------------------------------------------------------------

## 26. Final Architecture Statement

The MVP is built as a privacy-conscious web application around a
shielded Zcash market vault.

A bettor creates an independent bearer ticket, receives a fresh
diversified shielded receiver, and pays through a ZIP-321 request. A
view-only watcher detects the payment and a private matcher confirms the
ticket. The public application never publishes a live YES/NO book. When
the market's predefined closing condition is reached, the accepted
ledger is frozen and cryptographically committed. A rule-bound manual
oracle resolves the event. The settlement engine calculates parimutuel
entitlements, winning users authenticate with their ticket secrets and
provide fresh shielded destinations, and PCZT-based transaction
preparation is separated from authorization. The desired authorization
layer is 2-of-3 FROST, with a simpler signer path retained only as a
disclosed hackathon fallback.

This architecture intentionally provides **public privacy, not full
operator privacy**. The operator-visible market book is the principal
accepted MVP privacy limitation and the natural boundary for a later ZK
upgrade.

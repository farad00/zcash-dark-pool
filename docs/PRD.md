# Product Requirements Document (PRD)

## Zcash-Native Dark Prediction Pool

**Document status:** MVP Baseline\
**Version:** 1.0\
**Date:** 30 September 2026\
**Purpose:** Product-level source of truth for the Zecathon MVP.
Implementation details that do not affect product behavior belong in
`ARCHITECTURE.md` or `SPEC.md`.

------------------------------------------------------------------------

## 1. Product Summary

The product is a Zcash-native, binary-event prediction pool in which
users stake shielded ZEC on either **YES** or **NO**. Individual
positions, stake sizes, payout amounts, and wallet relationships must
not become a public order book.

The MVP is deliberately not a Polymarket-style exchange. It is a
**parimutuel event pool**: users stake on one of two outcomes, the
market locks, a predefined event is resolved, and the losing pool is
distributed proportionally among winning stakes.

The system uses Zcash's shielded transaction capabilities as the privacy
foundation. Each prediction receives a fresh diversified shielded
receiving address. Deposits and payouts remain shielded. The public
market interface intentionally exposes very little information while
betting is open.

The MVP's privacy boundary is explicit: **the public and other bettors
must not be able to see individual positions or stakes, but the market's
settlement infrastructure/operator can see the information required to
match deposits and calculate settlement.** Hiding this information from
the operator using custom zero-knowledge protocols is a future privacy
upgrade, not an MVP requirement.

------------------------------------------------------------------------

## 2. Problem

Most prediction-market designs expose information that can influence
later participants:

-   which side a wallet selected;
-   how much was staked;
-   changes in market liquidity;
-   live odds or implied probabilities;
-   large positions;
-   wallet histories and relationships;
-   settlement and payout relationships.

This creates a visible market book. Participants can react to whales,
copy positions, profile wallets, and infer trading behavior.

Zcash provides a different design opportunity. A prediction pool can use
shielded ZEC so that the blockchain does not become the public market
book.

The product therefore asks:

> Can a useful event market be operated where the public can verify that
> a market exists and later see its resolution, while individual
> predictions, stakes, and payouts remain shielded from public
> observation?

The MVP is intended to demonstrate that this is practical.

------------------------------------------------------------------------

## 3. Product Goals

The MVP must:

1.  Allow a user to take a YES or NO position using shielded ZEC.
2.  Support variable stake amounts.
3.  Prevent the public blockchain from exposing the user's position,
    stake amount, or payout amount.
4.  Avoid publishing a live order book through the application itself.
5.  Require no user account, username, email address, or social identity
    to place a prediction.
6.  Give every ticket a fresh shielded receiving address.
7.  Detect and reconcile incoming shielded payments without exposing the
    spending authority to the public web application.
8.  Represent ownership of a prediction with a private ticket/claim
    secret.
9.  Lock the market before resolution.
10. Resolve the event according to a rule published before betting.
11. Distribute the pool proportionally to winning stakes.
12. Pay winners to fresh shielded addresses.
13. Support a defined void/refund path.
14. Separate transaction construction from spending authorization where
    practical.
15. Demonstrate the complete lifecycle in a working Zecathon demo.

------------------------------------------------------------------------

## 4. Non-Goals

The MVP will not attempt to build:

-   an automated market maker;
-   a central-limit order book;
-   tradable YES/NO shares;
-   secondary trading;
-   liquidity providers;
-   Zcash Shielded Assets as prediction tokens;
-   cross-chain betting;
-   fiat deposits or withdrawals;
-   multiple concurrent production markets;
-   decentralized governance;
-   a decentralized oracle network;
-   a custom consensus protocol;
-   custom ZK circuits for operator-private settlement;
-   MPC-based private settlement;
-   fully homomorphic encrypted settlement;
-   anonymous-credential infrastructure;
-   a mobile wallet;
-   a general-purpose prediction-market platform;
-   public live odds;
-   public live YES/NO counts;
-   transparent-address payment fallback.

These may be future directions, but none may delay the working MVP.

------------------------------------------------------------------------

## 5. Target Users

### 5.1 Bettor

A Zcash user who wants to take a position on a binary event without
publishing the position or stake amount to the blockchain or to other
market participants.

The bettor should only need:

-   access to a compatible Zcash wallet;
-   shielded ZEC;
-   the private ticket information required to claim or recover funds.

### 5.2 Market Operator

The party operating the MVP market. The operator:

-   creates the market;
-   publishes its resolution rule;
-   issues tickets/payment requests;
-   monitors incoming payments using viewing authority;
-   locks the market;
-   records the outcome according to the predefined rule;
-   prepares settlement or refunds;
-   participates in authorization/signing as required.

The operator is inside the MVP privacy boundary and may see settlement
information.

### 5.3 Settlement Signer / Referee

Where threshold authorization is enabled, additional signers review and
authorize movement of pooled funds. They exist primarily to reduce
unilateral custody risk, not to provide full operator privacy.

------------------------------------------------------------------------

## 6. Core Value Proposition

The product is a **dark prediction pool built inside Zcash's shielded
system**.

The intended property is:

> A user can stake ZEC on YES or NO without creating a publicly visible
> position, stake size, live order-book entry, or publicly linked
> payout.

The product does not claim that the market operator learns nothing.

------------------------------------------------------------------------

## 7. Terminology

**Market:** One binary event with a predefined question, closing
condition, resolution rule, and YES/NO outcomes.

**Ticket:** The application's private record representing one
prediction.

**Stake:** The ZEC amount associated with a valid ticket.

**Ticket ID:** A high-entropy identifier assigned to a ticket.

**Claim secret:** A high-entropy secret generated for the bettor and
required to prove control of the ticket during claim/refund operations.

**Claim commitment:** A cryptographic hash derived from the
market/ticket context and claim secret. The server stores the commitment
rather than the plaintext secret.

**Market vault:** The shielded Zcash authority/account holding market
funds.

**Watcher:** A component with viewing capability that scans for incoming
market payments but does not hold spending authority.

**Settler:** The component/process that computes payouts or refunds and
prepares transactions.

**PCZT:** A partially constructed Zcash transaction used to separate
transaction construction/proving/signing workflows.

**FROST:** Threshold-signing technology intended to prevent a single
party from unilaterally spending market funds.

**Ledger commitment:** A cryptographic commitment to the locked set of
accepted tickets, intended to make post-lock rewriting of the market
ledger detectable.

**Fresh payout UA:** A new Unified Address supplied by the winner for
receiving the payout, avoiding unnecessary reuse of the
prediction-receiving context.

------------------------------------------------------------------------

## 8. Product Assumptions

1.  The MVP operates a single binary market for the principal
    demonstration.
2.  The event must have an objective or sufficiently explicit resolution
    rule.
3.  Users possess compatible Zcash wallets capable of making shielded
    payments.
4.  The application uses maintained/current Zcash wallet libraries
    rather than manually implementing Orchard transaction rules.
5.  The operator requires viewing capability for MVP settlement.
6.  The MVP does not claim network-layer anonymity. Website, IP,
    browser, timing, and endpoint metadata require separate protections.
7.  FROST is desired, but the market must remain demonstrable if current
    FROST/tooling integration becomes a blocker.
8.  Custom ZK operator privacy is explicitly deferred until the base
    product works.

------------------------------------------------------------------------

## 9. Privacy Promise

### 9.1 What the MVP must hide from the public

The system must not intentionally publish:

-   which ticket selected YES or NO;
-   individual stake amounts;
-   the bettor's identity;
-   the bettor's source wallet relationship;
-   live pool totals by side;
-   live odds derived from pool totals;
-   live side-specific ticket counts;
-   payout amounts;
-   public links between a prediction and its later payout.

Shielded Zcash transactions provide the on-chain privacy foundation.

### 9.2 What the operator may know

For the MVP, the settlement infrastructure/operator may learn:

-   ticket identifier;
-   selected side;
-   accepted stake amount;
-   payment status;
-   settlement eligibility;
-   claim destination when a user submits it;
-   information required to construct the payout/refund.

This is an accepted MVP limitation.

### 9.3 Claims the product must not make

The product must not claim:

-   that the operator cannot see positions;
-   that users are anonymous against all network observers;
-   that IP metadata is hidden automatically by Zcash;
-   that FROST makes the operator unable to observe settlement
    information;
-   that the market is trustless;
-   that the oracle is decentralized;
-   that custom ZK private settlement exists in the MVP.

------------------------------------------------------------------------

## 10. MVP Market Definition

The MVP supports one binary question:

**YES / NO**

A market record must define at minimum:

-   market ID;
-   human-readable question;
-   YES outcome definition;
-   NO outcome definition;
-   opening time;
-   closing/locking time or condition;
-   resolution source(s);
-   resolution rule;
-   void conditions;
-   status;
-   resolved outcome, once known;
-   resolution evidence/links where applicable.

A Zcash-relevant question such as an objectively verifiable network
event is preferred for the primary presentation. A separate
already-resolved or accelerated demo market may be used to demonstrate
the complete lifecycle during judging.

------------------------------------------------------------------------

## 11. Market Lifecycle

The normal lifecycle is:

`DRAFT -> OPEN -> LOCKED -> RESOLVED -> PAYING -> CLOSED`

A void branch is mandatory:

`OPEN/PAUSED/LOCKED -> VOID -> REFUNDING -> CLOSED`

An exceptional safety state is also recognized:

`OPEN -> PAUSED -> OPEN`

or, when safe continuation is not possible:

`PAUSED -> VOID -> REFUNDING -> CLOSED`

### DRAFT

The market is configured but does not accept predictions.

### OPEN

Users may create tickets and fund them.

### LOCKED

No new prediction may become valid after the applicable close rule. The
accepted ticket ledger is frozen and committed.

### RESOLVED

The operator records YES or NO according to the predefined rule and
publishes resolution evidence.

### PAYING

Winning tickets may be settled according to the claim mechanism.

### VOID

The event cannot be resolved under the published rule or a predefined
void condition occurs.

### REFUNDING

Valid funded tickets are entitled to return of their accepted stake,
subject to the refund mechanism.

### CLOSED

Settlement/refunds are complete or the market has reached its defined
terminal state.

State transitions must be explicit and auditable in application records.

------------------------------------------------------------------------

## 12. Bettor Flow

### 12.1 Select Market

The user opens the market page and sees:

-   question;
-   description;
-   closing rule/time;
-   resolution rule;
-   resolution source(s);
-   current market status;
-   total prediction count if the product chooses to expose it;
-   YES and NO action controls.

The page must not expose live side-specific statistics.

### 12.2 Choose Position and Stake

The user selects:

-   YES or NO;
-   stake amount in ZEC.

The system validates the amount against configured minimum/maximum
constraints if such constraints are enabled.

### 12.3 Generate Ticket

For every new ticket, the system must:

1.  generate a random ticket ID;
2.  associate the selected side privately with that ticket;
3.  create or receive a client-generated high-entropy claim secret;
4.  store a cryptographic commitment to the secret rather than relying
    on plaintext server storage;
5.  allocate a fresh diversified shielded receiver for the ticket;
6.  associate that receiver/diversifier with the ticket;
7.  create the corresponding payment request.

### 12.4 Payment Request

The application presents a ZIP-321-compatible payment request containing
the appropriate shielded receiver and requested amount.

Prediction metadata should not be placed on-chain merely for application
convenience. In particular, YES/NO should not be required in the memo if
the ticket can be matched through its unique receiver.

Any memo used by the MVP should contain only the minimum information
actually required.

### 12.5 User Pays

The user completes the payment with a compatible Zcash wallet.

The MVP is shielded-only. It must not silently fall back to a
transparent payment path.

### 12.6 Payment Confirmation

The watcher detects the incoming shielded payment and matches it to the
ticket using the allocated receiver/address information.

The ticket transitions to an accepted/confirmed state only when all
required conditions are satisfied.

The user receives a clear confirmation and is instructed to preserve the
ticket ID and claim secret.

------------------------------------------------------------------------

## 13. Ticket Requirements

Each ticket must track at least:

-   ticket ID;
-   market ID;
-   private side;
-   requested stake;
-   accepted stake;
-   allocated receiver/diversifier reference;
-   claim commitment;
-   creation time;
-   payment deadline/market close relationship;
-   payment status;
-   transaction/note reference as needed internally;
-   claim/refund status;
-   payout/refund reference as needed internally.

The exact storage schema belongs in `SPEC.md`.

Ticket IDs and claim secrets must contain enough entropy to resist
guessing.

The system must never treat possession of a ticket ID alone as
sufficient authority to claim funds.

------------------------------------------------------------------------

## 14. Deposit Acceptance Rules

A deposit is accepted only if it satisfies the final protocol rules. At
minimum, the implementation must address:

-   payment to the receiver allocated to that ticket;
-   valid shielded receipt;
-   market still accepting that ticket under the close rule;
-   stake amount policy;
-   duplicate/ambiguous payments;
-   underpayment;
-   overpayment;
-   payment arriving around the lock boundary;
-   multiple payments to one ticket receiver.

The precise rules for underpayment, overpayment, multiple notes, and
close-boundary behavior must be frozen in `SPEC.md` before
implementation is considered complete.

The matching operation must be deterministic.

------------------------------------------------------------------------

## 15. No Public Live Order Book

While the market is OPEN, the public interface must not expose:

-   YES ticket count;
-   NO ticket count;
-   YES pool size;
-   NO pool size;
-   implied odds;
-   individual stake sizes;
-   recent position direction;
-   largest stake;
-   wallet/address information;
-   side-specific activity feed.

The application may expose the **total number of confirmed predictions**
if desired, provided that doing so does not reveal side distribution.

After lock/resolution, aggregate statistics may be published only if
doing so is consistent with the final privacy policy.

------------------------------------------------------------------------

## 16. Market Lock and Ledger Commitment

When the market locks:

1.  no later prediction may be silently added to the accepted book;
2.  the final accepted ticket set must be frozen;
3.  the application must produce a cryptographic commitment to the
    locked ledger;
4.  that commitment should be published or otherwise timestamped in a
    way that makes later rewriting detectable.

The commitment must be **hiding as well as binding**. Low-entropy fields
such as YES/NO and predictable stake values must not be exposed through
naïve unsalted hashes.

The exact commitment construction, salt/randomness strategy, tree
format, canonical serialization, and publication mechanism belong in
`SPEC.md`.

The ledger commitment is intended to detect post-lock alteration. It
does not by itself prove that the operator accepted every legitimate
payment or that every committed record is truthful.

------------------------------------------------------------------------

## 17. Resolution

The MVP uses a predefined manual oracle process.

Before betting opens, the market must publish:

-   the event being measured;
-   authoritative source(s);
-   the condition that produces YES;
-   the condition that produces NO;
-   the resolution time/condition;
-   ambiguity/void conditions.

After lock, the operator resolves the market using those rules.

The resolution record should include:

-   market ID;
-   outcome;
-   timestamp;
-   cited evidence/source links;
-   operator/referee authorization as defined by the implementation.

If the published rule cannot determine a valid outcome, the market must
enter the VOID path rather than inventing a discretionary result.

------------------------------------------------------------------------

## 18. Parimutuel Settlement

Let:

-   `Y` = total accepted YES stake;
-   `N` = total accepted NO stake;
-   `T = Y + N`;
-   `W` = total stake on the winning side;
-   `s_i` = accepted stake belonging to winning ticket `i`.

Before fees, the conceptual payout for winning ticket `i` is:

`p_i = (s_i / W) * T`

The MVP currently assumes no hidden house edge unless explicitly
specified before implementation.

The final integer-zatoshi algorithm must define:

-   arithmetic precision;
-   rounding direction;
-   residual/dust allocation;
-   transaction fees;
-   treatment of zero-liquidity edge cases;
-   whether the original stake is conceptually included in `p_i` (it is
    under the formula above);
-   deterministic reconciliation so total outputs do not exceed
    spendable pool funds.

These details are mandatory in `SPEC.md`.

------------------------------------------------------------------------

## 19. Winning Claim Flow

A winning user submits:

-   ticket ID;
-   claim secret;
-   a fresh shielded-compatible payout UA.

The system must:

1.  verify the claim commitment;
2.  verify that the ticket belongs to the resolved winning side;
3.  verify that the ticket is funded and eligible;
4.  verify that it has not already been claimed;
5.  calculate the deterministic payout;
6.  bind the submitted payout address to the claim record;
7.  prepare the shielded payout;
8.  authorize and broadcast it through the configured signing workflow;
9.  atomically mark the ticket claimed so replay cannot produce a second
    payout.

The user should be shown the payout destination and calculated amount
before final claim confirmation where the UI flow permits.

A payout must not be sent to a guessed "from address." The user supplies
a fresh destination.

------------------------------------------------------------------------

## 20. Void and Refund Flow

If a market becomes VOID, every valid funded ticket becomes
refund-eligible according to the final rules.

The refund must return the ticket's accepted stake, adjusted only by a
previously documented fee policy if one exists.

The user should prove control using the ticket/claim mechanism and
provide a fresh shielded refund destination.

The system must prevent double refunds and must not rely on identifying
a sender's original wallet address.

The exact handling of unclaimed refunds and operational timeouts must be
defined before production use.

------------------------------------------------------------------------

## 21. Claim Secret Security

The preferred model is:

1.  the browser/client generates a cryptographically secure random
    secret;
2.  a commitment is derived from the secret and ticket/market context;
3.  the server stores the commitment;
4.  the bettor retains the secret;
5.  claim verification recomputes the commitment.

A conceptual form is:

`H(domain || market_id || ticket_id || claim_secret)`

The final hash, domain separator, canonical encoding, and secret length
belong in `SPEC.md`.

The claim secret is a bearer credential. Anyone who obtains both the
required ticket information and secret may be able to claim the funds.

The UI must therefore communicate that the ticket/secret must be stored
securely.

------------------------------------------------------------------------

## 22. Shielded-Only Requirement

The intended value flow is:

`shielded bettor -> shielded market vault -> shielded winner/refund destination`

The application must not silently downgrade to transparent Zcash
addresses or transparent outputs.

If the supplied wallet/address cannot satisfy the shielded payment
requirement, the application must reject or clearly mark the operation
unsupported.

------------------------------------------------------------------------

## 23. Viewing and Spending Separation

The online deposit-watching component must not require the market's
spending authority merely to detect incoming payments.

The product should separate:

-   web/ticket service;
-   viewing/scanning authority;
-   settlement calculation;
-   transaction construction;
-   transaction authorization/signing;
-   broadcasting.

The exact key hierarchy and service topology belong in
`ARCHITECTURE.md`.

------------------------------------------------------------------------

## 24. PCZT Requirement

The intended signing design uses PCZT or equivalent current Zcash
transaction-construction separation so that transaction preparation does
not require placing unrestricted spending authority in the public web
application.

The product requirement is the **separation of transaction preparation
and authorization**. The architecture document will define the exact
implementation and compatible library versions.

------------------------------------------------------------------------

## 25. FROST Requirement and Fallback

The desired vault design is **2-of-3 threshold authorization**.

Conceptual roles:

-   operator signer;
-   independent/referee signer;
-   recovery signer.

No single share should be sufficient to spend the market vault.

However, current FROST/PCZT integration risk must not prevent a working
Zecathon submission.

Therefore:

-   the complete single-authority or otherwise simplified signing path
    must be made functional first;
-   PCZT separation should be added next;
-   FROST should then replace/augment signing if the current compatible
    stack works reliably;
-   if FROST cannot be completed safely in the hackathon window, the
    limitation must be disclosed rather than simulated.

FROST reduces unilateral spending risk. It does not automatically
guarantee correct oracle resolution or settlement, and a threshold of
colluding signers can still authorize spending.

------------------------------------------------------------------------

## 26. Functional Requirements

### FR-01 Market Display

The application shall display the market question, status, close
condition, and resolution rule.

### FR-02 Binary Position

The application shall allow selection of exactly YES or NO.

### FR-03 Variable Stake

The application shall accept a user-selected ZEC stake within configured
limits.

### FR-04 Unique Ticket

The system shall generate a unique high-entropy ticket identifier.

### FR-05 Fresh Receiver

The system shall allocate a fresh diversified shielded receiver for each
ticket.

### FR-06 ZIP-321

The system shall generate a wallet-compatible ZIP-321 payment request.

### FR-07 Shielded Deposit

The system shall require a shielded payment path.

### FR-08 View-Only Detection

The watcher shall detect incoming deposits without requiring
unrestricted spending authority.

### FR-09 Ticket Matching

The system shall deterministically match a valid deposit to its ticket.

### FR-10 Confirmation

The system shall expose confirmed/unconfirmed/invalid ticket state to
the user without exposing the market book publicly.

### FR-11 Market Lock

The system shall stop accepting new valid predictions according to a
deterministic close rule.

### FR-11A Exceptional Pause

The system shall distinguish an exceptional PAUSED state from the normal
LOCKED state. Pause/continue/void behavior and authorization must be
predefined and must not provide an ordinary mechanism for discretionary
market timing.

### FR-12 Ledger Commitment

The system shall commit to the accepted locked ticket ledger.

### FR-13 Resolution

The operator shall resolve the market according to the rule published
before opening.

### FR-14 Settlement

The system shall calculate deterministic parimutuel payouts.

### FR-15 Claim Authentication

The system shall require the valid ticket claim secret/commitment
relationship.

### FR-16 Fresh Payout Destination

The claimant shall be able to provide a fresh shielded payout address.

### FR-17 Double-Claim Protection

A ticket shall not produce more than one successful winning payout.

### FR-18 Void

The operator shall be able to mark a market void only under the
published conditions.

### FR-19 Refund

A valid funded ticket in a void market shall have a deterministic refund
path.

### FR-20 Signing Separation

Payout transaction construction shall be separable from spending
authorization.

### FR-21 Threshold Authorization

The product should support 2-of-3 FROST authorization if the current
compatible implementation can be integrated without compromising the
working MVP.

------------------------------------------------------------------------

## 27. Privacy and Security Requirements

### PS-01

Do not publish individual stakes.

### PS-02

Do not publish individual sides.

### PS-03

Do not publish live side totals or implied odds.

### PS-04

Do not require personally identifying account data for ordinary
participation.

### PS-05

Do not store plaintext claim secrets when a commitment-based design is
available.

### PS-06

Do not place unnecessary YES/NO metadata in transaction memos.

### PS-07

Do not publish the market UFVK as an audit mechanism.

### PS-08

Do not place the market spending key on the public web server.

### PS-09

Minimize application logs containing side, payment URI, payout address,
IP association, or other correlatable metadata.

### PS-10

Do not claim IP/network anonymity.

### PS-11

Use fresh payout addresses rather than attempting to pay a presumed
source address.

### PS-12

Use atomic claim/refund state transitions to prevent replay.

### PS-13

Ledger commitments must not permit practical dictionary attacks against
low-entropy side/stake fields.

### PS-14

No transparent fallback may occur silently.

------------------------------------------------------------------------

## 28. Failure and Edge Cases

The final implementation/specification must explicitly handle:

-   ticket generated but never paid;
-   payment received after market lock;
-   payment broadcast before lock but confirmed/scanned after lock;
-   underpayment;
-   overpayment;
-   multiple payments to one ticket receiver;
-   duplicated watcher events;
-   chain reorganization/reorg effects;
-   watcher outage;
-   database outage;
-   public web server compromise;
-   viewing-key compromise;
-   signer unavailability;
-   FROST participant failure;
-   two or more malicious threshold signers;
-   ambiguous oracle outcome;
-   resolution-source outage;
-   ticket/claim-secret theft;
-   lost claim secret;
-   payout address entered incorrectly;
-   claim replay;
-   concurrent claims against the same ticket;
-   payout construction failure;
-   broadcast failure;
-   transaction not mined/expired;
-   rounding residual/dust;
-   winning side with no accepted stake;
-   losing side with no accepted stake;
-   all tickets on one side;
-   market with zero funded tickets;
-   refund claim never submitted.

The precise expected behavior for each belongs in `SPEC.md` and
`TEST_PLAN.md`.

------------------------------------------------------------------------

## 29. Public Interface Requirements

The MVP should prioritize a simple one-question experience.

While OPEN, the main page should contain approximately:

-   market question;
-   short event description;
-   resolution rule/source;
-   closing information;
-   market status;
-   optional total confirmed prediction count;
-   YES action;
-   NO action.

It should intentionally omit market-book visualizations.

The product should not imitate a conventional exchange UI if that UI
would encourage leaking the very information the product is designed to
hide.

------------------------------------------------------------------------

## 30. Operator Interface Requirements

The operator must be able to:

-   create/configure the demo market;
-   open it;
-   inspect operational deposit/ticket status privately;
-   lock it;
-   generate/publish the ledger commitment;
-   enter the resolution with evidence;
-   preview deterministic settlement;
-   prepare payout/refund transactions;
-   send transactions through the signing workflow;
-   inspect completion/failure status.

Operational information visible here must not automatically be exposed
to the public frontend.

------------------------------------------------------------------------

## 31. Data Minimization

The product should collect only information needed for:

-   ticket issuance;
-   payment matching;
-   market operation;
-   settlement/refund;
-   abuse/error handling.

Email, phone number, social handles, names, and conventional user
accounts are not required for the MVP.

Third-party analytics should be avoided during the hackathon MVP unless
demonstrated not to leak sensitive prediction behavior.

------------------------------------------------------------------------

## 32. Demo Scenario

The final demo must show the complete lifecycle, not merely a payment
screen.

A representative scenario:

1.  Market is OPEN.
2.  Wallet A creates a YES ticket for 0.01 ZEC.
3.  Wallet A receives a unique ZIP-321 request and pays shielded.
4.  Watcher confirms the ticket.
5.  Wallet B creates a NO ticket for 0.02 ZEC.
6.  Wallet B pays a different fresh shielded receiver.
7.  Public page shows that predictions exist but does not reveal the two
    stakes or which side has which stake.
8.  Market locks.
9.  Ledger commitment is produced.
10. Operator resolves YES according to the predefined demo rule.
11. System calculates the winning ticket's payout.
12. Winner supplies a fresh shielded UA and valid claim secret.
13. Settlement transaction is prepared and authorized.
14. Winner receives the shielded payout.
15. The demo shows that a public observer does not obtain a conventional
    order book or publicly readable stake/payout amounts from the chain.

A second short void/refund demonstration may be included if time
permits.

------------------------------------------------------------------------

## 33. MVP Success Criteria

The MVP is successful when:

1.  A user can complete a YES/NO prediction end to end.
2.  A unique shielded receiver is generated per ticket.
3.  A compatible wallet can pay using the generated payment request.
4.  The watcher detects and matches the shielded payment.
5.  Public UI does not reveal side or stake.
6.  Market can lock deterministically.
7.  Accepted ledger can be committed without revealing its contents.
8.  Market can resolve under its predefined rule.
9.  Payout calculation is deterministic and reconciles with available
    funds.
10. A valid winner can claim using the ticket secret.
11. A double claim is rejected.
12. A payout reaches a fresh shielded destination.
13. A void market has a working refund path.
14. Spending authorization is not exposed to the public web application.
15. The complete lifecycle can be demonstrated reliably during judging.
16. Any incomplete FROST functionality is honestly identified rather
    than represented as production-ready.
17. Privacy claims in the demo match the actual threat model.

------------------------------------------------------------------------

## 34. Technical Dependencies and Risks

### Current Zcash wallet stack

The implementation depends on current compatible Zcash wallet libraries
for diversified addresses, scanning, transaction construction, and
shielded transfers.

**Risk:** protocol/library changes or version mismatches.

**Response:** pin a tested compatible dependency set and avoid manual
low-level Orchard transaction construction.

### Light client / chain data source

The watcher needs reliable Zcash chain access through an appropriate
light-client infrastructure.

**Risk:** sync latency/outage affects confirmation UX.

### PCZT

PCZT is the intended transaction-construction/authorization boundary.

**Risk:** API/version integration friction.

### FROST

Threshold authorization is technically desirable and demonstrated in
Zcash tooling, but remains the highest integration-risk component.

**Response:** do not make FROST a prerequisite for proving the product
lifecycle.

### Ledger commitment

The commitment must be designed carefully enough to be hiding and
deterministic.

**Risk:** a naïve commitment can leak low-entropy fields or fail to
prove the intended property.

### Application metadata

Zcash cannot automatically hide website/IP/timing information.

**Risk:** application logs or third parties can recreate correlations
outside the blockchain.

**Response:** data minimization and explicit privacy boundaries.

------------------------------------------------------------------------

## 35. Future Privacy Upgrade: Operator-Blind / ZK

Operator privacy is intentionally outside the MVP.

A future version may investigate:

-   commitments to private YES/NO positions;
-   Halo2/ZK proofs of valid position formation;
-   operator-blind positions while a market is open;
-   nullifier-based private claim systems;
-   proofs binding application stake commitments to real Zcash value;
-   private proportional settlement;
-   selective disclosure for disputes/auditing.

The long-term target could be:

> The public cannot see the book, and the operator learns only the
> minimum information necessary---or eventually no individual position
> information at all.

No such property may be claimed until it is actually implemented and
tested.

------------------------------------------------------------------------

## 36. Open Questions to Freeze in SPEC.md

These are genuine remaining design questions rather than reasons to
reopen the product concept:

1.  Exact minimum and maximum stake.
2.  Exact confirmation/finality rule before a deposit becomes accepted.
3.  Exact close-boundary rule for transactions submitted before but
    observed after lock.
4.  Underpayment behavior.
5.  Overpayment behavior.
6.  Multiple-payment behavior for one ticket.
7.  Canonical ticket-record serialization.
8.  Ledger commitment construction and publication location.
9.  Exact claim-secret length, hash function, and domain separation.
10. Integer-zatoshi payout algorithm.
11. Fee policy.
12. Dust/residual allocation.
13. Behavior when the winning side has zero stake.
14. Behavior when only one side has stake.
15. Claim/refund expiration policy, if any.
16. Exact signer approval information exposed to FROST participants.
17. Exact Zcash dependency versions selected after implementation spike.
18. Whether total prediction count remains public while OPEN or is
    hidden as an additional privacy measure.
19. Whether payouts are immediate per claim or optionally batched.
20. Whether aggregate statistics are ever published after resolution.
21. Exact closing primitive: wall-clock time, Zcash block height, or a
    deterministic mapping between the two.
22. Exact PAUSE authorization, pending-payment behavior, reopening
    conditions, and mandatory-void conditions.
23. Local multi-ticket storage format and ticket export/recovery UX.

These must be resolved deliberately in `SPEC.md`; they must not be
decided accidentally inside implementation code.

------------------------------------------------------------------------

## 37. Final MVP Definition

The Zecathon MVP is:

> **A Zcash-native dark binary prediction pool where users stake
> variable amounts of shielded ZEC on YES or NO through fresh
> diversified receivers, the public never receives a live order book of
> positions or stake sizes, accepted tickets are privately reconciled
> and committed at lock, the event is resolved under a predefined rule,
> and winners claim proportional payouts to fresh shielded addresses.**

The operator retains the viewing capability required for MVP settlement.
PCZT separates transaction construction from authorization. A 2-of-3
FROST vault is the desired custody model but may not block delivery of
the working market. Operator-blind ZK settlement is reserved for a later
privacy upgrade.

This definition is the product baseline. Later architecture,
specification, threat-model, implementation, and test documents may
refine **how** it is built, but should not silently expand or alter
**what** the MVP is.

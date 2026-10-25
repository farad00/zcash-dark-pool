# THREAT_MODEL.md --- Security and Privacy Threat Model

## Zcash-Native Dark Prediction Pool

**Status:** MVP Threat Model Baseline\
**Version:** 1.0\
**Date:** 2 October 2026\
**Depends on:** `PRD.md`, `ARCHITECTURE.md`, `SPEC.md`

## 1. Purpose

This document asks what can go wrong even if the product behaves as
designed.

The MVP's central privacy promise is deliberately limited:

> Individual positions, stake sizes, and payouts should not become a
> public order book on the Zcash blockchain or public application
> interface.

The MVP does **not** promise that the market operator cannot see
positions or stakes. The operator requires private application state and
viewing capability to reconcile deposits and settle the market.

Security goals are therefore split into:

1.  public privacy;
2.  custody security;
3.  ticket/claim security;
4.  market integrity;
5.  settlement correctness;
6.  application/network metadata privacy;
7.  operational availability.

------------------------------------------------------------------------

## 2. Protected Assets

The system protects:

### Funds

-   shielded ZEC deposited into the market;
-   winner entitlements;
-   refundable stakes;
-   transaction-fee reserves where applicable.

### Secrets

-   claim secrets;
-   market spending authority;
-   FROST secret shares;
-   wallet seed/recovery material;
-   database credentials;
-   service credentials.

### Confidential data

-   ticket side;
-   accepted stake;
-   ticket-to-receiver mapping;
-   claim commitments;
-   payout/refund destinations before and during settlement;
-   wallet viewing data;
-   private ledger records.

### Integrity-critical data

-   market rules;
-   close rule;
-   accepted ticket ledger;
-   published ledger root;
-   resolution record;
-   settlement plan;
-   claim/refund state.

------------------------------------------------------------------------

## 3. Adversaries

The model considers:

1.  **Public chain observer** --- analyzes Zcash blockchain activity.
2.  **Other bettor** --- tries to infer competitors' positions or
    manipulate the pool.
3.  **Web observer / analytics provider** --- sees browser, HTTP, IP,
    timing, or telemetry data.
4.  **Database attacker** --- obtains product database contents.
5.  **Watcher attacker** --- compromises viewing infrastructure or
    viewing keys.
6.  **Web/API attacker** --- compromises the public application.
7.  **Ticket thief** --- obtains a user's bearer ticket credentials.
8.  **Malicious bettor** --- exploits payment, claim, race, or
    settlement edge cases.
9.  **Malicious operator** --- manipulates market records, resolution,
    or custody.
10. **Malicious/colluding signer** --- authorizes unauthorized spending.
11. **Compromised dependency/infrastructure** --- wallet library, node,
    RPC, database, deployment, or supply-chain failure.
12. **Network disruption** --- reorg, outage, delayed scanning, or
    inconsistent chain view.

------------------------------------------------------------------------

## 4. Trust Boundaries

``` text
BETTOR DEVICE
   |
   | HTTPS
   v
PUBLIC WEB/API
   |
   +------ PRODUCT DB
   |
   +------ ZCASH WALLET SERVICE
               |
               +------ WALLET DB
               |
               +------ VIEW-ONLY WATCHER
               |
               +------ CHAIN DATA SOURCE

SETTLEMENT ENGINE
   |
   v
PCZT / SETTLEMENT PLAN
   |
   v
SIGNING BOUNDARY
   |
   +------ signer / FROST shares
   |
   v
ZCASH NETWORK
```

Crossing a boundary MUST NOT automatically grant authority belonging to
the next boundary.

------------------------------------------------------------------------

## 5. Privacy Properties

### P1 --- Public side privacy

A public observer should not learn whether a specific ticket is YES or
NO from the public application or ordinary shielded chain data.

### P2 --- Public stake privacy

Individual accepted stake amounts should not become a public market
book.

### P3 --- Public payout privacy

Winner payout amounts and simple deposit-to-payout relationships should
remain shielded from public chain observation.

### P4 --- No explicit server-side identity graph

The application should not require a personal account linking all of one
bettor's tickets.

### P5 --- Operator visibility is explicit

The operator can see the private market book required for MVP
settlement. This is not treated as a failure of the stated MVP privacy
promise.

### P6 --- No network-anonymity claim

Zcash shielded transactions do not automatically hide application
IP/browser/timing metadata.

------------------------------------------------------------------------

## 6. Threat: Public YES/NO Pot Identification

### Attack

If all YES bettors pay one public address and all NO bettors another,
observers may identify side-related activity or correlate application
behavior.

### Mitigation

-   fresh diversified shielded receiver per ticket;
-   one logical market vault rather than publicly labelled YES/NO pots;
-   side maintained privately in application state;
-   no side required in memo.

### Residual risk

Timing and external application metadata can still correlate activity.

**Severity:** High\
**MVP status:** Mitigated by architecture.

------------------------------------------------------------------------

## 7. Threat: Memo Metadata Leakage

### Attack

Application embeds `YES`, `NO`, market IDs, ticket IDs, or other
unnecessary metadata into payment memos.

Even if memo contents are shielded on-chain, this unnecessarily expands
sensitive information visible to entities with relevant viewing
capability and complicates privacy boundaries.

### Mitigation

-   match tickets using unique receiver allocation;
-   empty or minimal opaque memo;
-   never rely on side metadata in memo.

**Severity:** Medium\
**MVP status:** Mitigated by SPEC.

------------------------------------------------------------------------

## 8. Threat: Application Recreates a Public Order Book

### Attack

Frontend/API exposes live YES/NO counts, pool sizes, odds, largest
stake, or recent side direction.

This defeats the product even though Zcash transactions remain shielded.

### Mitigation

While OPEN, prohibit: - side counts; - side pool totals; - odds; -
individual stakes; - directional activity feeds.

Total confirmed prediction count is optional and subject to review.

**Severity:** Critical to product thesis\
**MVP status:** Explicitly prohibited.

------------------------------------------------------------------------

## 9. Threat: Server-Side Identity Linkage

### Attack

Requiring accounts, email, usernames, or a persistent server-side user
ID links a bettor's otherwise independent positions.

### Mitigation

-   independent bearer tickets;
-   local "My Predictions" store;
-   local/exportable claim secrets;
-   no required server-side user identity.

### Residual risk

IP address, browser fingerprinting, timing, and repeated network
behavior may still correlate tickets.

**Severity:** Medium\
**MVP status:** Reduced, not eliminated.

------------------------------------------------------------------------

## 10. Threat: IP and Timing Correlation

### Attack

An observer correlates:

``` text
browser request for prediction
        +
time
        +
wallet transaction timing
```

to infer participation or link multiple tickets.

### Mitigation

-   no third-party analytics by default;
-   minimize access-log retention;
-   avoid side-bearing URLs;
-   avoid logging full ZIP-321 URIs;
-   separate public analytics from sensitive endpoints;
-   avoid claiming network anonymity.

### Future mitigation

Tor/proxy-aware access, batching, delayed submission, private relays, or
other network privacy work.

### Residual risk

Significant in MVP. Application metadata can remain correlatable.

**Severity:** High\
**MVP status:** Accepted residual risk with minimization.

------------------------------------------------------------------------

## 11. Threat: Product Database Breach

### Attack

Attacker steals database and learns ticket sides, accepted stakes,
market book, claim commitments, and operational metadata.

### Impact

Privacy breach. Claim commitments alone should not permit claiming
without the 256-bit secrets.

### Mitigation

-   access control;
-   encryption at rest where practical;
-   secrets separated from product records;
-   no plaintext claim secrets;
-   minimized logs;
-   database credentials isolated;
-   backups treated as sensitive.

### Residual risk

The operator-visible market book exists by design, so DB compromise can
expose it.

**Severity:** High\
**MVP status:** Accepted architectural trust boundary; harden storage.

------------------------------------------------------------------------

## 12. Threat: Viewing-Key / Watcher Compromise

### Attack

Attacker obtains the viewing authority used to reconcile market
deposits.

### Impact

Privacy loss over wallet activity visible to that authority.

### Mitigation

-   watcher receives no spending authority;
-   viewing keys never published;
-   isolate watcher credentials;
-   restrict service access;
-   rotate/recover where supported;
-   treat wallet DB/backups as sensitive.

### Residual risk

Least privilege prevents theft of funds but does not prevent privacy
loss.

**Severity:** High privacy / lower custody impact\
**MVP status:** Mitigated by privilege separation.

------------------------------------------------------------------------

## 13. Threat: Public UFVK as "Auditability"

### Attack

Publishing a full viewing key to prove deposits gives broad third
parties visibility into wallet activity.

### Mitigation

The MVP MUST NOT publish the market UFVK.

Auditability instead uses: - locked-ledger commitment; - resolution
evidence; - signer review; - future selective-disclosure mechanisms.

### Residual risk

Current ledger commitment is not a complete public solvency proof.

**Severity:** High privacy\
**MVP status:** Explicitly prohibited.

------------------------------------------------------------------------

## 14. Threat: Web Server Compromise Leads to Fund Theft

### Attack

Public API server is compromised and attacker tries to drain market
funds.

### Mitigation

-   no spending key on public web server;
-   watcher is view-only;
-   settlement plan/PCZT boundary;
-   signer isolated;
-   desired 2-of-3 FROST.

### Residual risk

A compromised API may manipulate claims, destinations, availability, or
settlement proposals. Signer review is still necessary.

**Severity:** Critical\
**MVP status:** Strong architectural mitigation.

------------------------------------------------------------------------

## 15. Threat: Malicious Payout Address Substitution

### Attack

Attacker changes the winner's submitted payout address before signing.

### Mitigation

-   bind payout UA to the atomically reserved claim;
-   include destination in immutable settlement plan;
-   hash settlement plan;
-   signer verifies plan/outputs;
-   prohibit silent destination changes once signing starts.

### Residual risk

If API, settlement engine, and signer review are all compromised,
substitution remains possible.

**Severity:** Critical\
**MVP status:** Mitigated through binding and signer boundary.

------------------------------------------------------------------------

## 16. Threat: Double Claim

### Attack

Same ticket submits simultaneous or repeated claims.

### Mitigation

-   atomic `UNCLAIMED -> RESERVED`;
-   database uniqueness/transaction constraints;
-   idempotency key;
-   claim state machine;
-   reconcile uncertain broadcast before retry.

### Residual risk

Implementation/database transaction bugs.

**Severity:** Critical\
**MVP status:** Must be tested.

------------------------------------------------------------------------

## 17. Threat: Ticket Theft

### Attack

Attacker obtains ticket ID and claim secret.

### Impact

Bearer credential may be claimed by attacker.

### Mitigation

-   256-bit secret;
-   server stores commitment only;
-   secure local handling;
-   sensitive export warning;
-   avoid logging secret;
-   optional future encrypted export.

### Residual risk

There is no identity-based recovery or revocation in MVP.

**Severity:** High\
**MVP status:** Accepted bearer-token risk.

------------------------------------------------------------------------

## 18. Threat: Lost Ticket Secret

### Failure

User loses local secret/export.

### Mitigation

-   explicit backup/export UX;
-   warning before funding;
-   local ticket vault.

### Residual risk

No identity recovery. Operator must not bypass authentication.

**Severity:** High to affected user\
**MVP status:** Accepted.

------------------------------------------------------------------------

## 19. Threat: Guessing Claim Secrets

### Attack

Brute-force claim commitment.

### Mitigation

256-bit uniformly random claim secrets and cryptographic hash
commitment.

### Residual risk

Negligible if CSPRNG and hash are correctly implemented.

**Severity:** Critical if randomness fails\
**MVP status:** Cryptographically mitigated.

------------------------------------------------------------------------

## 20. Threat: Naïve Ledger Hash Leaks Positions

### Attack

Operator publishes:

`H(ticket || YES || common_amount)`

Observer brute-forces low-entropy side/amount combinations.

### Mitigation

-   independent high-entropy `record_blinding`;
-   domain-separated leaf commitment;
-   canonical serialization;
-   only blinded Merkle root publicly exposed.

**Severity:** High privacy\
**MVP status:** Mitigated by SPEC.

------------------------------------------------------------------------

## 21. Threat: Operator Rewrites Ledger After Lock

### Attack

Operator changes side, amount, or ticket membership after seeing the
outcome.

### Mitigation

-   deterministic close;
-   freeze accepted ledger;
-   blinded Merkle commitment;
-   publish/store root before resolution;
-   settlement plan references root.

### Residual risk

Commitment detects later alteration but cannot prove that the original
committed ledger was honest.

**Severity:** Critical integrity\
**MVP status:** Partially mitigated.

------------------------------------------------------------------------

## 22. Threat: Operator Omits a Legitimate Ticket

### Attack

Operator excludes a valid timely deposit before producing the ledger
root.

### Mitigation

-   deterministic watcher/matcher;
-   chain-derived payment evidence;
-   immutable audit events;
-   ticket holder can retain ticket/payment evidence;
-   signer/operator review.

### Residual risk

The ledger commitment alone cannot prove completeness. A malicious
operator with control over product bookkeeping can attempt omission.

### Future mitigation

Selective payment disclosure, independent auditor/viewer, stronger
inclusion receipts, or cryptographic proofs of complete wallet scanning.

**Severity:** High\
**MVP status:** Residual trust assumption.

------------------------------------------------------------------------

## 23. Threat: Operator Invents Fake Tickets

### Attack

Operator adds fabricated entries before locking to manipulate payout
shares.

### Mitigation

Accepted tickets must correspond to detected qualifying shielded
deposits in wallet state. Settlement reconciliation must compare
accepted stake totals against actual wallet funds and exceptions.

### Residual risk

The public cannot independently verify the private wallet book without
broader disclosure.

### Future mitigation

Independent audit authority or selective proofs.

**Severity:** High\
**MVP status:** Partially mitigated; operator remains trusted.

------------------------------------------------------------------------

## 24. Threat: Arbitrary Early/Delayed Lock

### Attack

Operator closes after seeing favorable activity or keeps market open
after useful outcome information becomes available.

### Mitigation

-   close rule frozen before OPEN;
-   API automatically stops issuing tickets at close;
-   chain-based near-boundary classification;
-   PAUSED separate from LOCKED;
-   state transitions audited.

### Residual risk

Operator controls infrastructure and can cause denial of service;
protocol cannot force availability.

**Severity:** Critical fairness\
**MVP status:** Mitigated by deterministic rules.

------------------------------------------------------------------------

## 25. Threat: Abuse of PAUSED

### Attack

Operator uses PAUSE as a disguised discretionary close.

### Mitigation

-   PAUSE limited to safety incidents;
-   reason recorded/displayed;
-   original close rule unchanged;
-   reopen only when fairness remains intact;
-   otherwise VOID/refund.

**Severity:** High\
**MVP status:** Governance/trust mitigation.

------------------------------------------------------------------------

## 26. Threat: Late Payment Ambiguity

### Attack/failure

Payment is broadcast before close but observed later, or included around
the close boundary.

### Mitigation

-   server observation time is not authoritative;
-   close policy frozen before OPEN;
-   chain evidence determines classification;
-   wait for confirmation/finality before ledger freeze.

### Residual risk

Reorgs and exact chain-boundary interpretation require careful
implementation and test vectors.

**Severity:** High\
**MVP status:** Defined conceptually; implementation-critical.

------------------------------------------------------------------------

## 27. Threat: Underpayment/Overpayment Manipulation

### Attack

Bettor intentionally sends unusual amounts or multiple payments to
exploit settlement accounting.

### Mitigation

-   requested amount is economic stake;
-   exact funding policy;
-   partial payments only aggregate to exact requested amount before
    deadline;
-   excess never increases stake;
-   exception/refund path;
-   integer accounting.

**Severity:** Medium/High\
**MVP status:** Mitigated by deterministic rules.

------------------------------------------------------------------------

## 28. Threat: Duplicate Scan / Reorg Accounting

### Attack/failure

Same received note is processed twice or chain reorganization changes
observed state.

### Mitigation

-   stable wallet receipt identity;
-   database uniqueness;
-   idempotent matcher;
-   confirmation threshold;
-   rollback before finality;
-   safety review for post-finality inconsistency.

**Severity:** High\
**MVP status:** Must be tested.

------------------------------------------------------------------------

## 29. Threat: Settlement Rounding Exploit

### Attack/failure

Floating point or inconsistent rounding creates excess/deficit or favors
particular tickets.

### Mitigation

-   integer zatoshi arithmetic;
-   floor division;
-   deterministic largest-remainder allocation;
-   ticket-ID tie-break;
-   reconciliation invariant.

**Severity:** High financial integrity\
**MVP status:** Mitigated by SPEC.

------------------------------------------------------------------------

## 30. Threat: Integer Overflow

### Attack

Large stake values cause multiplication overflow in:

`stake_i * D`

### Mitigation

-   sufficiently wide integer type;
-   explicit checked arithmetic;
-   configured maximum stake;
-   property tests around limits.

**Severity:** Critical if unchecked\
**MVP status:** Implementation requirement.

------------------------------------------------------------------------

## 31. Threat: Fee Misaccounting

### Failure

Network fees cause payouts to exceed available funds or create
unexplained shortfalls.

### Mitigation

-   fee policy frozen before OPEN;
-   no hidden house fee;
-   settlement plan includes expected fee;
-   reconcile outputs + fees against spendable funds;
-   operator-subsidized fee mode preferred for simple demo if practical.

**Severity:** High\
**MVP status:** Must be validated with real transaction builder.

------------------------------------------------------------------------

## 32. Threat: No Winning Stake

### Failure/manipulation

Outcome resolves to a side with zero stake.

### Mitigation

NO_WINNER_REFUND. Losing pool is not awarded to operator.

**Severity:** Medium fairness\
**MVP status:** Defined.

------------------------------------------------------------------------

## 33. Threat: Oracle Manipulation

### Attack

Operator intentionally chooses wrong outcome.

### Mitigation

-   objective proposition;
-   resolution rule frozen before OPEN;
-   source hierarchy published;
-   evidence published;
-   ambiguous case -\> VOID;
-   signer/referee can review resolution before authorizing settlement.

### Residual risk

Manual oracle remains trusted. FROST does not itself prove real-world
truth.

**Severity:** Critical\
**MVP status:** Explicit trust assumption.

------------------------------------------------------------------------

## 34. Threat: Resolution Source Failure

### Failure

Source is unavailable, contradictory, or ambiguous.

### Mitigation

-   source hierarchy;
-   predefined ambiguity rule;
-   VOID/refund if outcome cannot be defensibly determined.

**Severity:** High\
**MVP status:** Defined at market configuration level.

------------------------------------------------------------------------

## 35. Threat: Single Operator Drains Vault

### Attack

One operator uses spending key to steal pool.

### Mitigation

Desired 2-of-3 FROST: - operator; - independent/referee; - recovery
signer.

No single share can authorize a spend.

### Fallback risk

If hackathon MVP uses a single signer, unilateral custody risk remains
and MUST be disclosed.

**Severity:** Critical\
**MVP status:** FROST desired, fallback accepted for delivery.

------------------------------------------------------------------------

## 36. Threat: FROST Signer Collusion

### Attack

Any threshold coalition authorizes malicious spend.

### Mitigation

-   independent signer roles;
-   settlement-plan review;
-   operational separation;
-   cold/recovery signer practices.

### Residual risk

2-of-3 FROST cannot prevent two colluding signers.

**Severity:** Critical\
**MVP status:** Explicit threshold trust assumption.

------------------------------------------------------------------------

## 37. Threat: FROST Integration Failure

### Failure

Experimental/version-sensitive FROST integration blocks settlement or
produces unsafe behavior.

### Mitigation

Implementation order: 1. working shielded spend; 2. PCZT separation; 3.
real FROST integration.

Never simulate threshold security.

### Residual risk

Fallback has weaker custody security.

**Severity:** High delivery risk\
**MVP status:** Contained by architecture boundary.

------------------------------------------------------------------------

## 38. Threat: PCZT / Settlement Plan Mismatch

### Attack/failure

Signed transaction differs from the approved settlement plan.

### Mitigation

-   plan hash;
-   outputs/fee summary;
-   signer inspection;
-   transaction construction through compatible maintained libraries;
-   tests comparing plan and final transaction.

**Severity:** Critical\
**MVP status:** Must be tested.

------------------------------------------------------------------------

## 39. Threat: Broadcast Retry Creates Duplicate Payment

### Failure

RPC timeout occurs after transaction actually propagated; application
builds another transaction.

### Mitigation

-   persist transaction identity;
-   BROADCAST is not final;
-   reconcile uncertain status;
-   idempotency;
-   do not reconstruct until prior state is known.

**Severity:** Critical\
**MVP status:** Defined.

------------------------------------------------------------------------

## 40. Threat: Compromised Chain Data Source

### Attack

Malicious or faulty light-client backend gives stale/inconsistent chain
view.

### Mitigation

-   sync-health monitoring;
-   checkpoint/chain validation from wallet stack;
-   fail closed on severe inconsistency;
-   optional secondary source comparison for high-value operation.

### Residual risk

MVP may depend on one infrastructure provider.

**Severity:** High\
**MVP status:** Operational trust dependency.

------------------------------------------------------------------------

## 41. Threat: Dependency / Supply-Chain Compromise

### Attack

Malicious or compromised package/library enters build.

### Mitigation

-   pin dependency versions;
-   minimize dependencies;
-   use official/maintained Zcash crates where possible;
-   lockfile committed;
-   review dependency changes;
-   reproducible build practices where practical.

**Severity:** Critical\
**MVP status:** Implementation responsibility.

------------------------------------------------------------------------

## 42. Threat: Transparent Fallback

### Failure

Wallet/application accidentally creates transparent payment/output.

### Impact

Direct privacy failure.

### Mitigation

-   shielded-capable destination validation;
-   no transparent fallback;
-   test chain outputs;
-   fail rather than downgrade.

**Severity:** Critical privacy\
**MVP status:** Hard invariant.

------------------------------------------------------------------------

## 43. Threat: Address Reuse

### Failure

Same ticket receiver or payout address reused across positions.

### Mitigation

-   fresh diversified receiver per ticket;
-   fresh payout/refund UA recommendation;
-   address allocation tests;
-   never infer payout from deposit address.

**Severity:** Medium/High privacy\
**MVP status:** Mitigated.

------------------------------------------------------------------------

## 44. Threat: Claim Endpoint Enumeration

### Attack

Attacker probes ticket IDs to learn whether positions exist or their
values.

### Mitigation

-   high-entropy ticket IDs;
-   generic public errors;
-   rate limiting;
-   never expose side/amount in failed claim responses.

**Severity:** Medium\
**MVP status:** Mitigated.

------------------------------------------------------------------------

## 45. Threat: Denial of Service

### Attack

Attacker creates large numbers of unpaid tickets, floods claim
endpoints, or overloads watcher/API.

### Mitigation

-   rate limiting;
-   ticket issuance limits;
-   expiration of unfunded tickets;
-   request size limits;
-   bounded database queries;
-   separate watcher from public API;
-   operational monitoring.

### Privacy caution

Anti-abuse controls SHOULD avoid introducing unnecessary identity
collection.

**Severity:** Medium/High availability\
**MVP status:** Basic protections required.

------------------------------------------------------------------------

## 46. Threat: Unfunded Ticket Flood

### Attack

Attacker requests many fresh receivers/tickets without paying.

### Mitigation

-   per-IP/request throttling where appropriate;
-   short ticket payment validity bounded by market close;
-   cleanup/archive unfunded tickets;
-   resource quotas.

### Residual risk

IP-based throttling itself creates metadata; retain only what is
operationally necessary.

**Severity:** Medium\
**MVP status:** Operational mitigation.

------------------------------------------------------------------------

## 47. Threat: Client-Side Secret Exfiltration

### Attack

Third-party JavaScript, analytics, XSS, malicious browser extension, or
compromised frontend reads claim secrets.

### Mitigation

-   no third-party analytics/scripts on sensitive pages;
-   strong CSP;
-   output escaping;
-   minimize dependencies;
-   avoid exposing secrets to unnecessary components;
-   secure export UX.

### Residual risk

A fully compromised client/browser can steal bearer credentials.

**Severity:** Critical\
**MVP status:** Web-security priority.

------------------------------------------------------------------------

## 48. Threat: CSRF / Unauthorized State Changes

### Attack

Malicious website triggers operator or claimant actions.

### Mitigation

-   SameSite cookies where cookies exist;
-   CSRF protection for authenticated operator actions;
-   explicit claim confirmation;
-   origin checks;
-   operator authentication;
-   no GET endpoints that mutate market state.

**Severity:** High\
**MVP status:** Standard web hardening required.

------------------------------------------------------------------------

## 49. Threat: XSS

### Attack

Injected script steals local tickets/claim secrets or changes payout
address.

### Mitigation

-   strict CSP;
-   framework escaping;
-   no unsafe HTML;
-   sanitize externally supplied text;
-   minimize third-party scripts;
-   security headers;
-   test payout-address rendering/confirmation.

**Severity:** Critical\
**MVP status:** High-priority test area.

------------------------------------------------------------------------

## 50. Threat: Operator Credential Compromise

### Attack

Attacker gains operator dashboard credentials and resolves/pauses/voids
markets or prepares malicious settlements.

### Mitigation

-   strong operator authentication;
-   least privilege;
-   sensitive action re-authentication where practical;
-   immutable audit events;
-   signer boundary prevents dashboard compromise from directly spending
    funds.

**Severity:** Critical\
**MVP status:** Operational hardening required.

------------------------------------------------------------------------

## 51. Threat: Backup Leakage

### Attack

Database or wallet backups expose private market book or viewing
material.

### Mitigation

-   encrypt backups;
-   restrict access;
-   avoid backing up plaintext claim secrets because server should not
    possess them;
-   document recovery process;
-   treat wallet backups as high sensitivity.

**Severity:** High\
**MVP status:** Operational requirement.

------------------------------------------------------------------------

## 52. Threat: Data Retention Creates Long-Term Privacy Risk

### Attack/failure

Logs and historical DB records preserve sensitive market behavior
indefinitely.

### Mitigation

Define retention separately for: - operational logs; - private ticket
records; - wallet scan data; - audit records.

Delete unnecessary web metadata as soon as operationally practical.

### Residual risk

Financial/application records needed for settlement and debugging may
persist through the hackathon.

**Severity:** Medium\
**MVP status:** Minimize by default.

------------------------------------------------------------------------

## 53. Threat: Payout Timing Correlation

### Attack

Observer correlates claim time, application interaction, and shielded
network activity.

### Mitigation

-   do not expose public claim feed;
-   minimize web logs;
-   optional payout batching;
-   no claim-time analytics.

### Residual risk

MVP does not provide strong network-level timing anonymity.

**Severity:** Medium/High privacy\
**MVP status:** Accepted; batching is optional stretch.

------------------------------------------------------------------------

## 54. Threat: Market Solvency / Accounting Mismatch

### Failure

Private ticket ledger says more is owed than vault can spend.

### Mitigation

Before authorization:

`sum(outputs) + fee <= spendable settlement funds`

and accepted-stake totals must reconcile against wallet state plus
documented exception funds.

Settlement MUST fail closed on unexplained mismatch.

**Severity:** Critical\
**MVP status:** Hard invariant.

------------------------------------------------------------------------

## 55. Threat: Operator Pays Wrong Winner by Mistake

### Failure

Incorrect side filter, stale resolution, or settlement bug selects wrong
tickets.

### Mitigation

-   settlement references immutable resolution;
-   deterministic tests;
-   plan hash;
-   signer summary;
-   test vectors for YES and NO outcomes;
-   no manual editing of payout list.

**Severity:** Critical\
**MVP status:** Must be tested.

------------------------------------------------------------------------

## 56. Threat: Privacy Claims Exceed Reality

### Failure

Demo says "fully private" or "anonymous" while operator sees the book
and network metadata exists.

### Mitigation

Required language:

> Positions, stake sizes and payouts are hidden from the public
> blockchain and other market participants. The market operator has the
> viewing/application access required for settlement.

Do not claim: - operator blindness; - full anonymity; - decentralized
oracle; - trustless settlement; - production-ready FROST unless actually
demonstrated.

**Severity:** Critical credibility/privacy\
**MVP status:** Documentation invariant.

------------------------------------------------------------------------

## 57. Threat Priorities

### Critical before demo

-   spending key exposed to web server;
-   double claim;
-   payout address substitution;
-   incorrect settlement arithmetic;
-   transparent fallback;
-   XSS stealing bearer tickets;
-   operator/signing path able to send arbitrary unnoticed outputs;
-   false FROST/privacy claims;
-   solvency mismatch.

### High before demo

-   ledger rewriting;
-   late-payment ambiguity;
-   watcher duplication/reorg behavior;
-   DB/viewing-key exposure;
-   oracle manipulation controls;
-   operator credential compromise;
-   fee accounting;
-   chain-source inconsistency.

### Medium / acceptable with disclosure

-   timing correlation;
-   total-ticket-count leakage;
-   bearer ticket loss;
-   payout batching not implemented;
-   no identity-based recovery;
-   single infrastructure provider.

------------------------------------------------------------------------

## 58. Security Acceptance Criteria

Before the MVP is considered ready for judging:

-   [ ] public UI exposes no live side-specific book;
-   [ ] each ticket receives a fresh shielded receiver;
-   [ ] no transparent fallback occurs;
-   [ ] claim secret is generated client-side and not stored plaintext
    server-side;
-   [ ] duplicate claim test fails safely;
-   [ ] watcher has no spending authority;
-   [ ] public web service has no spending key;
-   [ ] accepted ledger root changes if any committed record changes;
-   [ ] blinded leaves resist trivial YES/NO/amount guessing;
-   [ ] close-boundary tests behave deterministically;
-   [ ] settlement uses integer arithmetic and reconciles exactly;
-   [ ] payout destination is bound before authorization;
-   [ ] uncertain broadcast cannot create an immediate duplicate payout;
-   [ ] void/refund works end to end;
-   [ ] operator resolution evidence is recorded;
-   [ ] signer sees settlement summary/plan binding;
-   [ ] FROST is either real and demonstrated or explicitly marked
    incomplete;
-   [ ] privacy wording matches actual operator visibility;
-   [ ] no claim secrets appear in ordinary logs.

------------------------------------------------------------------------

## 59. Residual Risks Accepted for Zecathon MVP

The MVP knowingly accepts:

1.  operator visibility into sides and stakes;
2.  trust in the manual oracle;
3.  incomplete public proof that the committed private ledger is
    complete/honest;
4.  possible web/IP/timing correlation;
5.  bearer-ticket loss/theft risk;
6.  reliance on current Zcash wallet/light-client infrastructure;
7.  single-signer custody risk if FROST cannot be completed;
8.  no production-grade legal/compliance model;
9.  no formal cryptographic/security audit.

These are limitations to disclose, not properties to hide.

------------------------------------------------------------------------

## 60. Future Security and Privacy Work

After the core MVP, the strongest research directions are:

-   operator-blind side commitments while OPEN;
-   ZK proof of valid private position;
-   private stake/settlement proofs;
-   nullifier-based private claims;
-   stronger proof of ledger completeness;
-   independent/private auditor role;
-   selective payment disclosures for disputes;
-   stronger network-layer privacy;
-   encrypted local ticket vault/export;
-   hardened HSM/offline threshold signing;
-   production key rotation/recovery;
-   formal protocol review.

------------------------------------------------------------------------

## 61. Final Threat-Model Statement

The design uses Zcash to prevent the blockchain from becoming the
prediction market's public book, but it does not pretend that shielded
transactions solve every privacy problem.

The main MVP trust boundary is the operator: the operator can see the
private market book and participates in resolution and settlement. The
architecture reduces what a public observer, compromised web server,
watcher, or single signer can do, while ledger commitments,
deterministic settlement, bearer-ticket authentication, PCZT separation,
and optional FROST reduce specific integrity and custody risks.

The highest-value security property for the hackathon is therefore not
"nobody knows anything." It is:

> **The public cannot read the market book from the chain or
> application, the web server cannot unilaterally spend the pool,
> settlement follows deterministic rules, and every remaining trusted
> party or privacy limitation is stated explicitly.**

# SPEC.md --- Protocol and Product Specification

## Zcash-Native Dark Prediction Pool

**Status:** MVP Specification Baseline\
**Version:** 1.0\
**Date:** 2 October 2026\
**Depends on:** `PRD.md`, `ARCHITECTURE.md`

This document freezes the deterministic behavior of the MVP. It does not
redefine the product or architecture.

## 1. Normative Rules

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative. All economic calculations MUST use integer zatoshis.

`1 ZEC = 100,000,000 zatoshis`

Floating-point arithmetic MUST NOT be used for settlement, refunds,
balance reconciliation, or eligibility.

## 2. Identifiers and Secrets

### Market ID

Each market MUST have a unique opaque identifier. It is public and is
not an authenticator.

### Ticket ID

Each ticket MUST have a cryptographically unpredictable identifier with
at least 128 bits of entropy. Possession of a ticket ID alone MUST NOT
authorize a claim.

### Claim Secret

Each ticket MUST have an independent 256-bit claim secret generated
client-side with a CSPRNG:

`claim_secret = random(32 bytes)`

It MUST NOT be sent to the server during ticket creation. The client
stores it locally and supports export/recovery.

### Claim Commitment

The server stores a commitment rather than the secret:

`BLAKE2b-256("DARKPOOL_CLAIM_V1" || encode(market_id) || encode(ticket_id) || claim_secret)`

If another reviewed 256-bit hash is used, it MUST be frozen before
deployment. Encoding MUST be canonical and domain-separated.

## 3. Canonical Encoding

Cryptographically committed data MUST use one versioned canonical byte
encoding. Hashes MUST NOT depend on JSON key ordering, locale
formatting, floating point, or mutable display labels.

Canonical CBOR or an explicitly defined binary encoding is recommended.

## 4. Ticket Record

Logical record:

``` text
Ticket {
  version
  ticket_id
  market_id
  side                    // YES | NO
  requested_amount_zat
  accepted_amount_zat
  receiver_ref
  diversifier_ref
  claim_commitment
  created_at
  payment_deadline_ref
  payment_state
  ticket_state
  accepted_payment_ref
  accepted_at
  claim_state
}
```

There is no required `user_id` linking a person's tickets.

## 5. Local Ticket Management

The client MAY show multiple tickets under **My Predictions** without
creating a server-side identity.

A ticket export SHOULD contain:

``` text
version
network
market_id
ticket_id
side
requested_amount_zat
claim_secret
receiver
created_at
```

The export is a bearer credential and MUST be presented as sensitive.
Password-encrypted export is a future hardening feature, not an MVP
blocker.

## 6. Market Record

Before OPEN, a market MUST freeze:

``` text
market_id
question
yes_definition
no_definition
opens_at
close_rule
resolution_rule
resolution_sources[]
void_conditions[]
min_stake_zat
max_stake_zat
payment_acceptance_policy
fee_policy
zero_winner_policy
```

Economically meaningful rules MUST NOT be changed after OPEN. A material
configuration error discovered after OPEN SHOULD lead to PAUSE and, if
fairness cannot be preserved, VOID.

## 7. Market State Machine

States:

`DRAFT, OPEN, PAUSED, LOCKED, RESOLVED, PAYING, VOID, REFUNDING, CLOSED`

Normal path:

`DRAFT -> OPEN -> LOCKED -> RESOLVED -> PAYING -> CLOSED`

Exceptional paths:

`OPEN -> PAUSED -> OPEN`

`OPEN/PAUSED/LOCKED -> VOID -> REFUNDING -> CLOSED`

Every transition MUST record prior state, new state, trigger, timestamp,
actor/system source, and relevant chain reference where applicable.

## 8. Closing Rule

The MVP publishes a human-readable **UTC close time** before opening.

At `now >= close_time`, the API MUST stop issuing new tickets. The
operator MUST NOT arbitrarily extend or shorten this window after
observing market activity.

Server observation time MUST NOT decide whether a near-boundary payment
is valid.

During lock finalization, the system derives/records the applicable
canonical Zcash chain boundary and classifies payments against the
market's frozen close policy. The implementation MUST wait for its
configured confirmation/finality threshold before freezing the accepted
ledger.

The exact demo confirmation count is deployment configuration and MUST
be declared before the market opens.

## 9. Payment Request

Every ticket receives a fresh diversified shielded receiver.

The application MUST generate a ZIP-321-compatible payment request
containing the receiver and requested amount.

YES/NO MUST NOT be required in the memo. Memo content SHOULD be empty or
minimal/opaque.

Transparent fallback MUST NOT occur silently.

## 10. Deposit Detection and Matching

The watcher detects incoming shielded notes using viewing authority
without spending authority.

Matching is conceptually:

`received note -> receiver/diversifier -> ticket`

Processing MUST be idempotent. Re-scanning the same note MUST NOT
increase accepted stake twice.

A detected payment becomes CONFIRMED only after the configured
confirmation threshold and all acceptance rules pass.

A pre-finality reorg MUST safely roll back detection state. A
post-finality inconsistency MUST enter safety/operator review rather
than silently settle inconsistent state.

## 11. Exact Funding Policy

The ticket's requested amount is its economic stake.

### Exact payment

Exactly the requested zatoshis -\> eligible for confirmation.

### Underpayment

Underpayment does not create a valid prediction. The matcher MAY
aggregate qualifying partial payments to the same ticket receiver before
the payment deadline until the exact requested amount is reached.

### Overpayment

Overpayment MUST NOT increase the prediction stake. Excess funds enter
an exception/refund path.

### Multiple payments

Multiple payments MUST NOT silently create multiple predictions. Once
exact funding is reached, later funds are excess and handled separately.

The UI SHOULD strongly encourage one exact ZIP-321 payment.

Suggested payment states:

`AWAITING_PAYMENT, DETECTED, UNDERPAID, CONFIRMED, LATE, EXCESS, INVALID, REFUND_REQUIRED`

## 12. Lock Finalization

When the closing condition is reached:

1.  stop issuing tickets;
2.  begin closing finalization;
3.  continue scanning enough chain data to classify potentially timely
    payments;
4.  wait for the frozen confirmation/finality rule;
5.  classify all potentially timely tickets;
6.  freeze the accepted ticket set;
7.  canonicalize the ledger;
8.  build the hiding ledger commitment;
9.  publish/store the commitment;
10. transition to LOCKED.

No ticket may be manually added after the accepted ledger is frozen.

## 13. Accepted Ledger Commitment

Each accepted ticket contributes a private record:

``` text
LedgerRecordV1 {
  market_id
  ticket_id
  side
  accepted_amount_zat
  accepted_payment_ref
  receiver_ref
  record_blinding
}
```

`record_blinding` MUST be independent high-entropy randomness.

Recommended leaf:

`H("DARKPOOL_LEDGER_LEAF_V1" || canonical_record || record_blinding)`

Recommended Merkle internal node:

`H("DARKPOOL_LEDGER_NODE_V1" || left || right)`

Leaves MUST be deterministically ordered, e.g. lexicographically by
ticket ID. The odd-leaf convention MUST be fixed and covered by test
vectors.

Published lock object:

``` text
market_id
ledger_version
accepted_ticket_count
merkle_root
locked_at
```

The blinding prevents dictionary attacks against low-entropy YES/NO and
common stake values.

The root proves commitment to a ledger; it does **not** prove every
legitimate payment was included, every committed record is truthful, or
the oracle is correct.

## 14. PAUSED

PAUSED is exceptional, not a normal close control.

Valid reasons include serious compromise, wallet/watcher failure making
continued issuance unsafe, material configuration error, or severe
chain/network conditions.

Pause MUST stop new ticket issuance, preserve existing funds/records,
publish/record the reason, and MUST NOT rewrite the original close rule.

Reopen only if fairness and the original rules remain intact. Otherwise
VOID.

## 15. Resolution

Before OPEN, the market defines exact YES, NO, source hierarchy,
observation point, and void conditions.

Resolution record:

``` text
ResolutionV1 {
  market_id
  outcome        // YES | NO | VOID
  resolved_at
  evidence[]
  rule_version
  actor
}
```

If the predefined rule cannot defensibly produce YES or NO, the market
MUST be VOID.

## 16. Settlement Set

Only CONFIRMED tickets in the frozen accepted ledger participate.

Let:

`Y = total accepted YES stake`

`N = total accepted NO stake`

`T = Y + N`

`W = total accepted stake on winning side`

Detected, late, excess, invalid, or unresolved-exception funds MUST NOT
silently enter the pool calculation.

## 17. Zero/One-Sided Cases

If `T = 0`, there is nothing to settle.

If all accepted stake is on the winning side, there is no losing pool.
Winning tickets receive their accepted stake back, subject only to the
declared network-fee policy.

If `W = 0`, the operator MUST NOT take the losing pool. The MVP enters
**NO_WINNER_REFUND** and returns accepted stakes through the refund
mechanism.

This policy MUST be disclosed before OPEN.

## 18. Parimutuel Arithmetic

For an ordinary resolved market with `W > 0`, use integer arithmetic.

If fees are externally subsidized, distributable pool `D = T`.

If settlement fees come from the pool,
`D = T - declared settlement fees`.

For winning ticket `i`:

`numerator_i = stake_i * D`

`base_i = floor(numerator_i / W)`

`remainder_i = numerator_i mod W`

Use sufficiently wide integer arithmetic to prevent overflow.

### Residual allocation

Any residual zatoshis are allocated by the **largest remainder method**:

1.  sort winners by descending `remainder_i`;
2.  tie-break lexicographically by ticket ID;
3.  allocate one residual zatoshi in that order until `D` is fully
    reconciled.

This makes settlement deterministic.

## 19. Fee Policy

The MVP has **no house fee**.

Necessary Zcash transaction fees are either:

-   subsidized by the demo operator; or
-   deducted from the distributable pool under a policy frozen before
    OPEN.

The selected mode MUST be displayed in the market rules.

The settlement builder determines actual network fees using the pinned
Zcash transaction stack. No hidden fee is permitted.

## 20. Claim Request

Logical request:

``` text
ClaimRequestV1 {
  market_id
  ticket_id
  claim_secret
  payout_ua
  idempotency_key
}
```

The claim secret MUST NOT be written to normal logs.

Verification order:

1.  market exists;
2.  market is in a claimable state;
3.  ticket exists;
4.  ticket belongs to frozen accepted ledger;
5.  claim commitment matches;
6.  ticket is winner/refund-eligible;
7.  no prior successful claim/refund exists;
8.  destination is valid for the configured Zcash network;
9.  destination satisfies shielded-capable policy;
10. deterministic entitlement is computed;
11. claim is atomically reserved.

Errors SHOULD avoid revealing private ticket information to
unauthenticated callers.

## 21. Claim State Machine

Suggested states:

`UNCLAIMED -> RESERVED -> TX_PREPARING -> AWAITING_SIGNATURE -> BROADCAST -> CONFIRMED`

Failure states:

`RETRYABLE_FAILURE, TERMINAL_FAILURE`

`UNCLAIMED -> RESERVED` MUST be atomic so concurrent requests cannot
produce two payouts.

A claim is not considered paid merely because a transaction was
broadcast.

## 22. Idempotent Claim Retry

Every claim attempt MUST have an idempotency key.

A repeated identical request SHOULD return the existing claim state
rather than create another payout.

If broadcast status is uncertain, reconcile the existing transaction
before constructing another spend.

## 23. Fresh Payout Destination

The claimant supplies a fresh shielded-capable Unified Address.

The server MUST NOT infer the destination from the deposit transaction,
presumed sender, prior ticket, or account profile.

Once transaction authorization begins, the bound payout destination MUST
NOT be silently changed.

## 24. Refunds

Refund-eligible cases include VOID, NO_WINNER_REFUND, and defined
excess/payment exceptions.

Normal void refund entitlement:

`refund_amount = accepted_amount_zat`

subject only to the frozen network-fee policy.

Authentication uses the same ticket bearer credential and a fresh refund
UA.

A ticket MUST NOT be both successfully paid as a winner and successfully
refunded.

## 25. Lost or Stolen Ticket Secret

There is no identity-based recovery in the MVP.

If the user loses the claim secret and has no backup/export, the
operator MUST NOT bypass authentication based on an ownership assertion.

Anyone obtaining the necessary ticket ID and claim secret may be able to
claim the entitlement. The UI MUST clearly communicate this bearer-token
property.

## 26. Settlement Plan and PCZT

Before transaction authorization, the system creates an immutable
settlement plan:

``` text
SettlementPlanV1 {
  settlement_id
  market_id
  resolution_ref
  ledger_root
  outputs[]
  total_output_zat
  expected_fee_zat
  plan_hash
}
```

The plan hash binds what the signer(s) approve.

The PCZT builder/prover constructs the shielded transaction using
current compatible Zcash wallet libraries.

Signer review SHOULD expose:

-   market ID;
-   outcome;
-   ledger root;
-   settlement plan hash;
-   number of outputs;
-   total output amount;
-   fee;
-   reconciled remaining balance.

## 27. FROST Mode

When enabled, the desired vault uses 2-of-3 threshold authorization.

FROST ceremony, shares, nonce handling, rerandomized signing, and PCZT
integration MUST follow the compatible current Zcash/FROST
implementation rather than a custom design.

FROST is considered enabled only after a real threshold-authorized
shielded spend succeeds.

If the hackathon uses the fallback signer, documentation/demo MUST say
so explicitly.

## 28. Broadcast and Confirmation

After authorization:

1.  finalize transaction;
2.  broadcast;
3.  persist transaction reference;
4.  mark associated claims BROADCAST;
5.  monitor inclusion;
6.  after the configured threshold, mark CONFIRMED.

Uncertain broadcast state MUST be reconciled before creating a
replacement spend.

## 29. Payout Batching

Batching multiple shielded winner outputs is OPTIONAL.

It may reduce operational overhead and simple timing correlation, but it
MUST NOT block the core payout path.

If enabled, claim states additionally track queue/batch membership.

## 30. Public Information Policy

While OPEN, the application MAY publish:

-   question;
-   rules;
-   open/close information;
-   status;
-   optional total confirmed prediction count.

It MUST NOT publish:

-   YES count;
-   NO count;
-   YES/NO pool sizes;
-   odds;
-   recent side direction;
-   largest stake;
-   ticket-level stake;
-   payout destination.

Post-resolution aggregate statistics are optional and require
threat-model review.

## 31. API Idempotency

The following MUST be idempotent or duplicate-protected:

-   ticket creation retries;
-   scan ingestion;
-   payment matching;
-   lock finalization;
-   ledger-root publication;
-   resolution submission;
-   claim reservation;
-   settlement preparation;
-   broadcast reconciliation;
-   refund reservation.

## 32. Audit Events

The system SHOULD maintain an append-only logical audit stream for:

``` text
MARKET_OPENED
MARKET_PAUSED
MARKET_REOPENED
MARKET_LOCK_FINALIZATION_STARTED
MARKET_LOCKED
LEDGER_COMMITTED
MARKET_RESOLVED
MARKET_VOIDED
TICKET_CONFIRMED
CLAIM_RESERVED
SETTLEMENT_PLAN_CREATED
TX_AUTHORIZED
TX_BROADCAST
CLAIM_CONFIRMED
REFUND_CONFIRMED
```

Audit data MUST NOT contain claim secrets, spending keys, FROST shares,
or seed material.

## 33. Network and Time Rules

All addresses/identifiers MUST be network-aware. Testnet and mainnet
destinations MUST NOT be mixed.

Canonical server timestamps are UTC. Browser timezone MUST NOT affect
economic eligibility.

## 34. Demo Configuration

The Zecathon demo SHOULD use:

-   Zcash testnet/current supported test environment;
-   tiny stake amounts;
-   one primary market;
-   a short predefined close;
-   a declared low confirmation threshold suitable for demo speed;
-   no house fee;
-   shielded-only deposits/payouts;
-   an event that can be resolved during the demo.

Demo parameters MUST NOT be presented as production security policy.

## 35. Required Test Vectors

`TEST_PLAN.md` MUST include:

1.  claim commitment;
2.  valid/invalid claim secret;
3.  ledger leaf;
4.  ledger root;
5.  odd Merkle leaf count;
6.  exact payment;
7.  underpayment;
8.  overpayment;
9.  partial/multiple payments;
10. late payment;
11. duplicate scan;
12. payout arithmetic;
13. largest-remainder allocation;
14. remainder tie-break;
15. zero-funded market;
16. one-sided market;
17. zero winning stake;
18. concurrent double claim;
19. broadcast retry;
20. void refund.

## 36. Example Settlement

Assume:

``` text
YES:
A = 2 ZEC
B = 1 ZEC

NO:
C = 1 ZEC

Outcome = YES
```

Then:

``` text
T = 4 ZEC
W = 3 ZEC
```

Ignoring fees:

`A = floor(2 * 4 / 3) ZEC`

`B = floor(1 * 4 / 3) ZEC`

All real implementation arithmetic uses zatoshis. Any residual is
assigned by the largest-remainder rule.

## 37. Accepted Trust Assumptions

The MVP explicitly assumes:

1.  operator can view ticket side and stake;
2.  manual oracle follows the published rule;
3.  private product database is trusted for bookkeeping, with the ledger
    commitment limiting post-lock rewriting;
4.  selected Zcash wallet libraries correctly implement wallet behavior;
5.  configured signer(s) do not authorize malicious spends;
6.  in FROST mode, fewer than the signing threshold are malicious;
7.  claim secrets remain secret;
8.  web/IP/timing metadata may reveal information outside Zcash's
    blockchain privacy.

These assumptions are inputs to `THREAT_MODEL.md`.

## 38. Future ZK Compatibility

No custom ZK proof is part of V1.

The architecture should preserve future insertion points for:

``` text
position_commitment
proof_of_valid_position
nullifier
```

The first likely upgrade is operator-blind side selection while OPEN.
Hidden-stake/private settlement remains later research.

## 39. Frozen Decisions

SPEC v1.0 freezes:

1.  integer-zatoshi accounting;
2.  256-bit claim secrets;
3.  domain-separated claim commitments;
4.  independent bearer tickets;
5.  local multi-ticket management;
6.  fresh diversified receiver per ticket;
7.  ZIP-321 exact-payment request;
8.  no YES/NO requirement in memo;
9.  requested amount is the economic stake;
10. overpayment does not increase stake;
11. deterministic multiple-payment handling;
12. UTC public close plus chain-based near-boundary classification;
13. frozen confirmation threshold;
14. closing finalization before ledger freeze;
15. blinded Merkle ledger commitment;
16. rule-bound manual YES/NO/VOID resolution;
17. integer parimutuel settlement;
18. largest-remainder residual allocation;
19. no hidden house fee;
20. refund when winning side has zero stake;
21. bearer-secret claim authentication;
22. atomic double-claim protection;
23. fresh shielded payout/refund UA;
24. PCZT settlement-plan boundary;
25. optional batching;
26. desired but non-blocking 2-of-3 FROST;
27. operator-visible positions as an explicit MVP limitation.

## 40. Implementation-Pinning Items

The following do not reopen product design, but must be pinned during
implementation:

1.  exact Zcash crate versions;
2.  testnet/light-client endpoint or local infrastructure;
3.  demo confirmation count;
4.  canonical encoding library;
5.  exact commitment hash implementation;
6.  Merkle odd-leaf convention;
7.  database isolation/locking for claim reservation;
8.  wallet API used to map received notes to receivers;
9.  compatible PCZT workflow;
10. fee subsidy vs pool-funded demo mode;
11. whether payout batching ships;
12. ticket export encoding;
13. whether public total prediction count is enabled;
14. exact FROST tooling/version if completed.

## 41. Specification Summary

A prediction is an independent bearer ticket. The client creates a
256-bit claim secret and the server stores only a domain-separated
commitment. Each ticket receives a fresh diversified shielded receiver
and exact ZIP-321 payment request. A view-only watcher detects and
deterministically matches shielded funds.

At the predefined close, new ticket issuance stops. Potentially timely
payments are classified from chain evidence under a frozen confirmation
policy, not by server observation time. The accepted ledger is then
frozen and committed using blinded, canonically ordered Merkle leaves.

The rule-bound manual oracle resolves YES, NO, or VOID. Settlement uses
integer-zatoshi parimutuel arithmetic and deterministic
largest-remainder allocation. Claims use bearer credentials and fresh
shielded destinations with atomic double-claim protection.
Void/no-winner cases use refunds. PCZT separates preparation from
authorization, while 2-of-3 FROST remains the desired but non-blocking
custody upgrade.

`THREAT_MODEL.md`, `IMPLEMENTATION_PLAN.md`, and `TEST_PLAN.md` must
test this specification rather than silently redefine it.

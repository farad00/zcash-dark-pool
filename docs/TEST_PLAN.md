# TEST_PLAN.md — Zcash-Native Dark Prediction Pool

**Status:** MVP test-planning baseline; tests not yet executed  
**Version:** 1.0  
**Date:** 2 October 2026  
**Sources:** PRD.md v1.0 (30 September 2026, updated clarification baseline); ARCHITECTURE.md v1.0 (1 October 2026); SPEC.md v1.0, THREAT_MODEL.md v1.0, and IMPLEMENTATION_PLAN.md v1.0 (2 October 2026).

Source fingerprints (SHA-256 of the supplied file bytes):

| File | SHA-256 |
|---|---|
| PRD.md | `CF1E255C2CB9CB1096518A8B49CA86C54C7C23FB69848470855789C57B867C27` |
| ARCHITECTURE.md | `C258AE8A1182FCFE35520C3CF3237FDEC6817A9383C1BD1B58A946926A41FB6C` |
| SPEC.md | `5723C5FD669EABAC1A3AC75E79419E617E546BE40C7D210F904606190B9BE7AD` |
| THREAT_MODEL.md | `BD00B67BE7EC9B8BDC5B6675A5B68D58E48E26E970A6684535194A7D2175D52E` |
| IMPLEMENTATION_PLAN.md | `4721435E76802E614538BE9E960789F827E3401D53476AD7FA6156559A3E6C00` |

## 1. Purpose and authority

Verify the approved accountless, shielded binary parimutuel pool from ticket creation through confirmed payout or refund. This plan tests the source documents; it does not amend them. SPEC.md supplies the refined protocol behavior where earlier documents explicitly deferred decisions. IMPLEMENTATION_PLAN.md supplies build order and feature priorities. THREAT_MODEL.md supplies adversaries, security gates, and accepted limitations.

All test cases below are planned. Neither this document nor a fixture constitutes evidence that an implementation has passed. Actual results must identify the tested build, configuration, environment, and evidence.

The primary lifecycle is:

```text
ticket → shielded deposit → deterministic close/finalization → locked commitment
       → rule-bound resolution → authenticated claim → confirmed shielded payout
```

Also verify VOID refunds, NO_WINNER_REFUND, payment exceptions, and safe recovery. Do not add an AMM, tradable shares, decentralized oracle, custom ZK, operator blindness, or identity-based ticket recovery to the acceptance scope.

## 2. Frozen invariants

| Invariant | Source | Test families |
|---|---|---|
| Integer zatoshis only; 1 ZEC = 100,000,000 zat | SPEC §§1, 18–19 | U, ECON |
| Client CSPRNG generates independent 32-byte secrets; ticket ID has at least 128 bits of entropy; ID alone is insufficient | SPEC §2 | U, CLAIM, SEC |
| Domain-separated commitment binds market, ticket, and secret; server stores commitment | SPEC §§2–3, 20 | V01–V02, SEC |
| Independent bearer tickets, local multi-ticket management, no required personal account | PRD §§13, 21, 26–27; SPEC §§4–5, 25 | UI, INT, SEC |
| One market vault context; fresh diversified shielded receiver per ticket; no side-labelled pots | ARCHITECTURE §§4.6, 23 | ZC, SEC |
| ZIP-321 exact invoice; requested amount is economic stake; no side required in memo | SPEC §§9–11 | PAY, ZC |
| No transparent fallback; claimant supplies fresh shielded-capable payout/refund UA | SPEC §§9, 23–24, 33 | CLAIM, ZC, SEC |
| Published UTC close; issuance stops at now >= close; chain evidence classifies payments; finalization precedes ledger freeze | SPEC §§8, 12 | SM, PAY, REC |
| Exceptional PAUSED does not rewrite close; economically meaningful rules cannot change after OPEN | SPEC §§6–8, 14 | SM, SEC |
| Blinded canonical Merkle commitment; locked ledger cannot silently change | SPEC §§12–13 | MERKLE, SEC |
| Manual oracle follows frozen rules, sources and void conditions | SPEC §15 | SM, E2E |
| Only CONFIRMED members of frozen ledger settle; excess/late/invalid funds are excluded | SPEC §16 | PAY, ECON |
| Largest remainders, descending remainder then lexicographic ticket-ID tie-break; no house fee | SPEC §§18–19 | ECON |
| T=0 has nothing to settle; all winners get accepted stakes subject to fees; W=0 returns stakes, never awards pool to operator | SPEC §17 | V15–V17 |
| Atomic reservation, claim/refund replay protection, destination binding, reconcile uncertain broadcasts before replacement | SPEC §§20–24, 28, 31 | CLAIM, REC |
| Immutable settlement plan binds authorization; web and watcher lack spending authority | SPEC §26; ARCHITECTURE §§13, 19 | PCZT, SEC |
| FROST is optional 2-of-3; claim it active only after a real threshold-authorized shielded spend | SPEC §27 | FROST, DEMO |
| Public has no live side/stake book; operator visibility and network metadata risks are disclosed | SPEC §§30, 37; THREAT_MODEL §§5, 56–59 | SEC, DEMO |

## 3. Configuration and unresolved details: no invented protocol rules

Before market OPEN, preserve a versioned test/deployment profile with source-document hashes, application commit, dependency lockfile hashes, network, chain endpoint, wallet stack versions, stake bounds, UTC close, exact canonical chain-boundary mapping/comparison, deposit and payout confirmation thresholds, fee mode, and market resolution rules. Store optional-feature flags and signer mode as well.

SPEC §§8 and 40 require implementation pinning. The supplied documents do not provide complete byte-level or operational answers to all edge cases. Record the following explicitly; an affected test is **BLOCKED**, never implicitly PASS, until its expected result is grounded in a reviewed pinned choice:

| Detail to pin or clarify | Reason and test dependency |
|---|---|
| Canonical encoding, identifier representation, exact hash implementation | Claim/ledger/plan golden bytes cannot be guessed. Default claim formula is BLAKE2b-256 in SPEC §2; any reviewed substitute must be frozen before deployment. |
| Leaf serialization and placement of record_blinding | SPEC §13 lists blinding inside the logical record and also appends it in the recommended leaf formula. Specify the exact bytes, including whether it occurs once or twice; this plan does not choose. |
| Leaf order comparator, internal hash, odd-leaf and empty/single-leaf conventions | Lexicographic ticket-ID ordering is an example; odd-leaf convention is explicitly unpinned. Pin before golden roots. Never invent an empty root. |
| Exact UTC-to-canonical-chain close mapping and boundary equality | SPEC fixes chain-based classification but not the full algorithm. Test block time/height ambiguity and reorg behavior against the recorded rule. Observation time and broadcast time cannot substitute for it. |
| Qualifying partial receipts, deterministic receipt ordering, accepted_payment_ref for multiple notes | SPEC §11 permits aggregation; IMPLEMENTATION_PLAN §15 expects aggregation of qualifying receipts. Record how references bind all accepted receipts and how concurrent or excess receipts are classified. |
| Single overpayment and partial sum overshoot | Excess cannot increase stake. Sources do not fully specify whether a single oversized note funds the requested stake or sends the whole receipt to exception review. Freeze that distinction and refund principal before asserting an exact result. |
| Underpaid/late/unmapped exception refund eligibility and credentials | They cannot enter settlement, but detailed return amounts, authentication and procedures are not fully enumerated. Never silently confiscate or add them to winners' funds. |
| Pool-funded fee allocation for refunds/one-sided cases; actual-fee changes and multiple payouts | Formula D=T−fees is specified for ordinary settlement. Per-ticket refund fee allocation and total fees across claim timing/batches need an explicit rule; avoid changing entitlement when claims arrive in another order. |
| Claimable states; NO_WINNER_REFUND representation; empty-market closure | NO_WINNER_REFUND is an economic mode, not one of the nine published market states. Pin its mapping without adding a new public state by accident. |
| Pending-payment handling during PAUSED; reopen after close; pause authority | Preserve original close, funds and records. Sources do not specify every pause-boundary payment result. |
| Unclaimed entitlements, claim/refund expiry and zero/sub-fee outputs | No concrete expiry, forfeiture or dust rule is established. Keep liabilities visible; do not declare CLOSED by erasing them or award them to operator. Clarify unsupported payouts without inventing an economic haircut. |
| Ticket-ID/commitment creation handshake | Commitment includes ticket_id, while implementation flow describes deriving it before API issuance. Prove client knows the final ID before committing; choose/document a consistent handshake without dropping ticket binding. |
| Status-read privacy authorization | IMPLEMENTATION_PLAN §11 requests refresh by ID without secret. Pin a response policy that does not disclose private side/stake to an unauthenticated ID holder. Do not automatically upload the local portfolio. |
| Export format, DB isolation/locking, PCZT workflow, FROST tooling, batching and public total count | SPEC §40 implementation profile items; tests must match actual enabled features. |

A deployment choice cannot relax a frozen invariant. Economic ambiguities require an explicit documented clarification before opening an affected market, not a test fixture that accidentally becomes policy. Lack of implementation pinning does not prevent writing this plan; it prevents claiming dependent conformance tests have passed.

## 4. Environments, fixtures, and evidence

Use three complementary environments:

1. **Deterministic local:** pure protocol modules, fixed synthetic IDs/secrets, controlled UTC clock, canonical-chain fixtures and fault injection. Tiny zatoshi arithmetic fixtures need not satisfy demo stake limits; test the calculator directly.
2. **Integration:** actual product DB, wallet DB/service boundary and browser; concurrent workers, restarts, migrations and durable reservations. Mock chain events only for controlled faults, clearly labelled.
3. **Zcash testnet/current supported test environment:** real compatible wallets, shielded funding, receiver allocation, view-only scans, transaction construction/proving, active signer, broadcast and receiving-wallet confirmation. Record pinned versions from SPIKE_RESULTS.md; this plan makes no assertion about currently compatible versions.

Never use production funds or production secrets as test fixtures. Keep synthetic secrets distinguishable and exclude even test secrets from shared evidence. Testnet addresses and transaction references may be retained in restricted evidence; public demonstration artifacts must not reveal a participant's private book or viewing authority.

Each case record includes ID, priority, source section, preconditions/profile, stimulus, expected outcome, actual result, build/environment, owner, UTC execution time and redacted evidence. Results: **PASS, FAIL, BLOCKED, NOT RUN, DEFERRED, N/A**. Optional FROST can be DEFERRED with disclosure. Enabled optional features cannot be marked N/A to bypass failures.

### Priority and execution schedule

- **P0 gate:** core IMPLEMENTATION_PLAN §32 functionality plus critical-before-demo threats in THREAT_MODEL §57. Any funds, credential, shielded-flow, arithmetic, replay, signer-binding or false-claim defect blocks judging readiness.
- **P1:** PCZT integration, robust export/import, operational audit/recovery and other high-priority hardening. Mandatory source invariants still apply even if a supporting feature is P1; for example, no spending key on the web service is never optional.
- **P2:** FROST, batching, encrypted exports and reviewed optional post-resolution statistics. Exercise each enabled feature; defer honestly otherwise.

Run pure units/vectors and static checks on every change; DB/concurrency/integration tests on relevant changes and release candidates; real testnet smoke after wallet/signing/dependency changes; full E2E, recovery and privacy review on demo candidate. Use seeded property tests and preserve failing seeds. Avoid using uncontrolled testnet reorgs as the only way to exercise fault logic.

## 5. Unit and protocol tests

| ID | Stimulus | Expected result | Source |
|---|---|---|---|
| U01 | Parse string amounts 0.01, 0.00000001, configured min/max and values just outside limits | Exact 1,000,000 and 1 zat conversions; bounds enforced; format round-trips | SPEC §§1, 6 |
| U02 | Negative, zero where disallowed, malformed, NaN/Infinity, exponent/locale strings, >8 fractional digits, oversized integers | Explicit rejection under pinned parser policy; no truncation or float rounding into eligibility | SPEC §§1, 3; IMPL §7 |
| U03 | Addition/multiplication near type limits and values beyond JS safe-integer range | Exact checked wide-integer math or bounded rejection; no wraparound | SPEC §18; TM §30 |
| U04 | Instrument client RNG and failure; create many tickets | 32 random bytes per independent secret; secure generator used; RNG failure prevents creation; uniqueness sampling is not proof of entropy | SPEC §2 |
| U05 | Change market, ticket, secret or domain; ambiguous concatenation inputs | Commitment changes; canonical boundaries distinguish inputs; wrong versions rejected | SPEC §§2–3 |
| U06 | Reorder logical fields, vary locale/display labels or runtime | Same bytes for same logical record under pinned encoding; no locale/JSON-order dependency | SPEC §3 |
| U07 | Invalid side, missing market fields, inconsistent source/void rules | Cannot OPEN invalid market or create nonbinary position | SPEC §§6, 15 |
| U08 | Parse/generate ZIP-321 and UA for supported/unsupported receivers and networks | Exact amount/receiver preserved; no side memo dependency; invalid network/transparent-only rejected | SPEC §§9, 33 |
| U09 | Verify entitlement using live mutable ticket DB instead of frozen ledger | Settlement uses frozen accepted set and immutable resolution; inconsistency fails closed | SPEC §§12, 16, 26 |

## 6. Mandatory SPEC §35 vector catalogue

All amounts below are zatoshis unless stated. Use synthetic lexically ordered IDs A < B < C < D for arithmetic; they are fixture labels, not production ID formats. Fee-free examples mean externally subsidized fees, not free Zcash transactions. A hash vector becomes executable only when it has committed literal input bytes and independently reviewed literal expected digest/root; do not generate expected values at test runtime using the implementation under test.

| Vector | Fixed input/scenario | Expected assertion |
|---|---|---|
| V01 Claim commitment | market m1, ticket t1, 32 secret bytes 00 through 1f; pinned encoded IDs | Literal digest of BLAKE2b-256(ASCII DARKPOOL_CLAIM_V1 || encode(m1) || encode(t1) || secret), unless a reviewed frozen alternative is active. Repeat identical bytes gives identical digest. |
| V02 Valid/invalid secret | V01 secret, then flip one bit; also 31/33-byte secrets, wrong ticket/market | Correct secret authenticates only its bound ticket/market; mutations and malformed secrets fail without reservation or private error data. |
| V03 Ledger leaf | m1, t1, YES, accepted=1,000,000, fixed synthetic payment/receiver refs, synthetic blinding bytes 20 through 3f | Literal canonical_record, blinding placement and leaf digest captured under pinned format; each field or blinding mutation changes leaf. Synthetic blinding is for tests only. |
| V04 Ledger root | Two distinct fixed V03-style records t1/t2 with saved blindings | Literal ordered leaves, internal nodes and root; reversed input order yields same root after canonical ordering; changed membership changes root. |
| V05 Odd count | Three and five distinct records | Literal nodes/root according to the pinned odd-leaf rule at every level; singleton and empty fixtures separately pinned; no accidental library-default convention. |
| V06 Exact payment | request 1,000,000; one timely qualifying receipt 1,000,000 | Eligible only after configured confirmations; accepted=1,000,000 exactly once. |
| V07 Underpayment | request 1,000,000; timely receipt 999,999 | No valid prediction; accepted stake remains zero; durable underpaid/exception status, no settlement inclusion. |
| V08 Overpayment | request 1,000,000; timely receipt 1,000,001 | Never accepted stake >1,000,000. Full-note-versus-excess treatment depends on §3 clarification; exception/refund liability retained, never winner pool enrichment. |
| V09 Partial/multiple | 400,000 then 600,000 timely qualifying receipts; later distinct 50,000 | With declared aggregation, exact total funds one ticket after qualifying finality; later 50,000 is separate excess, not second prediction. Test 400,000+600,001 overshoot and late second receipt against pinned policy. |
| V10 Late payment | Payment classified beyond pinned canonical boundary; contrast timely inclusion scanned after UTC close | Late payment not accepted; delayed observation of timely chain evidence does not make it late. Exact boundary equality uses declared comparator. |
| V11 Duplicate scan | Replay same V06 receipt serially, concurrently and after restart | One receipt and one accepted stake; totals, root and exception principal unchanged. Distinct notes in one tx are not false duplicates. |
| V12 Payout arithmetic | YES A=200,000,000; YES B=100,000,000; NO C=100,000,000; YES wins | T=D=400,000,000; W=300,000,000. Bases A=266,666,666, B=133,333,333; remainders A=200,000,000, B=100,000,000; residual 1 → A. Final A=266,666,667, B=133,333,333, C=0. |
| V13 Largest remainder | YES A=2, B=1; NO C=2; YES wins, D=5, W=3 | Bases A=3, B=1; remainders A=1, B=2; final A=3, B=2. Larger stake does not automatically receive residual. |
| V14 Remainder tie | YES A=1, B=1, C=1; NO D=2; YES wins | D=5,W=3; bases 1 each, remainders 2 each, residual 2. Final A=2,B=2,C=1 by lexical order, independent of request/DB order. |
| V15 Zero funded | No confirmed accepted tickets; T=0 | Nothing to settle; no divide by zero, fabricated output or operator award. Empty commitment and closure follow pinned conventions. |
| V16 One-sided | YES A=2,B=1; no NO; YES wins; subsidized fees | A=2,B=1; no artificial return/yield. Pool-funded variant follows declared fee allocation. |
| V17 Zero winner | YES A=2,B=1; outcome NO; W=0 | NO_WINNER_REFUND; return accepted stakes subject only to declared fee policy; never divide by zero or transfer pool to operator. |
| V18 Concurrent claim | Same eligible ticket/secret, simultaneous identical and different idempotency keys | One atomic reservation and at most one successful entitlement payout; competing callers get existing state or safe rejection. |
| V19 Broadcast retry | Network accepts signed tx; RPC times out; retry/restart | Reconcile durable existing tx identity; no immediate new spend; confirmation credits entitlement once. |
| V20 Void refund | Fund YES A=1,000,000 and NO B=2,000,000; valid VOID; subsidized fees | Both authenticate separately and receive exactly 1,000,000/2,000,000 to supplied fresh shielded UAs; duplicates and claim/refund crossover cannot pay twice. |

### Golden-vector packaging

Store vectors under test-vectors/ with schema/version, profile ID, logical inputs, exact encoded hex, expected hashes/nodes/root, receipt chain evidence, expected state/amounts, and source references. Produce hash expectations using an independent implementation/reference tool after encoding and hash choices are frozen; cross-check browser/server/Rust where those implementations participate. Fixed test randomness is forbidden in production.

V01 and V03–V05 deliberately do not assert invented hexadecimal digests: supplied SPEC leaves encoding and Merkle details to implementation pinning. Their golden bytes are a release dependency, not missing protocol decisions supplied by this plan.

## 7. Payment and close-boundary integration

Each payment case runs against the real matcher/DB and controlled chain fixtures, with successful exact-payment paths repeated on testnet. Inspect accepted stake, exception liability, receipt identity, audit events and resulting ledger membership, not only UI labels.

| ID | Scenario | Expected result |
|---|---|---|
| PAY01 | V06–V09 exact, under, over, partial and subsequent payments | Required vector outcomes; only exact qualifying funding can yield requested economic stake; exception funds tracked separately. |
| PAY02 | Multiple notes in same tx to same or different ticket receivers; replays/out-of-order concurrent ingestion | Stable note-level identities; no tx-ID-only deduplication that drops valid notes; deterministic pinned aggregation/reference order. |
| PAY03 | Receipt to unknown receiver, malformed ref, wrong market mapping, unsupported network | Quarantine/reject as appropriate; no arbitrary match from amount/memo and no ledger inclusion. Preserve funds evidence for review. |
| PAY04 | Confirmations c−1, c, c+1; scanned but unconfirmed; scanner lag | No premature acceptance; confirmation count calculated from canonical chain using pinned rule, not number of scans or elapsed server seconds. |
| PAY05 | Inclusion immediately before, exactly at, and after canonical close boundary | Recorded classification matches pinned rule; repeat with watcher delayed and browser timezones changed. |
| PAY06 | Broadcast before close but inclusion after boundary; timely inclusion confirmed after UTC close | Broadcast timestamp does not establish timeliness; timely pending payment handled in finalization before freeze. |
| PAY07 | Partial funding straddles deadline; pre-close exact total with one receipt later reorged | Late portion cannot silently complete stake; rollback/reclassification under pinned policy before ledger freeze. |
| PAY08 | No payment; repeated expired invoice; payment after LOCKED | No prediction from unpaid ticket; late funds remain exception liabilities and cannot mutate accepted root. |
| PAY09 | Watcher offline across close, then full catch-up | Issuance stops at UTC close even without worker; root waits for sufficient canonical evidence/finality; timely receipts not lost because of outage. |
| PAY10 | Ticket issuance races UTC close, pause and wallet allocation; API retries after dropped response | State/deadline checked at authoritative commit point; no valid post-close issuance, duplicate ticket or reused receiver. Orphan allocation handled durably without mapping it to two tickets. |
| PAY11 | Pre-finality reorg removes/replaces receipt; post-finality conflicting chain evidence | Pre-finality reversible state and exact totals; post-finality safety/operator review, no silent rerooting or settlement of inconsistent state. |
| PAY12 | Under/excess/late receipts mixed with accepted pool and external fee subsidy | Reconciliation explains every received amount; exception funds and subsidy cannot increase winning shares. |

## 8. State-machine and oracle tests

SM01 enumerates every ordered pair of the nine public states. Exercise valid normal path DRAFT→OPEN→LOCKED→RESOLVED→PAYING→CLOSED, exceptional OPEN→PAUSED→OPEN, and OPEN/PAUSED/LOCKED→VOID→REFUNDING→CLOSED. Unsupported transitions fail without mutation; idempotent resubmission returns existing result. Source: SPEC §§7, 31.

SM02 checks that DRAFT is editable; OPEN freezes all economically meaningful configuration, including question semantics, stake bounds, payment/fee/zero-winner/close/resolution policies. Try UI, API and authorized administrative paths. Direct private-DB tampering is separately tested for detection and remains a trust-boundary limitation.

SM03 advances UTC to close−1 tick, close, close+1 tick with scheduler active, delayed and restarted. At and after close no new tickets. LOCK_FINALIZING is an internal phase if implemented, not an invented tenth public state. Resolution and settlement cannot run against an unfinished ledger. Source: SPEC §§8, 12; IMPL §16.

SM04 pauses with authorized actor and valid safety reason; check issuance stops, funds/records persist, reason displayed/recorded and original close unchanged. Attempt unauthorized pause, discretionary early-close abuse, unsafe reopening, and reopening after original close. Reopening cannot restore expired issuance rights; ambiguous pending-payment outcomes require the §3 profile. Otherwise VOID under published conditions. Source: SPEC §14.

SM05 crashes after each lock-finalization step, replays finalization and races two workers. One accepted set, one stable persisted blinding set/root, publication before settlement, no manual post-freeze additions. Partial publication failure cannot expose contradictory roots or allow early resolution.

SM06 resolves YES and NO using predefined source hierarchy, observation point, evidence and rule version. Unauthorized, premature, contradictory, missing-evidence or stale-resolution requests cannot silently proceed. Ambiguity/unavailable sources follow predefined hierarchy/void rule, not invented discretionary outcome. Resolution is immutable once settlement begins. Source: SPEC §15; IMPL §18.

SM07 verifies transition records include prior/new state, trigger, timestamp, actor/system and relevant chain reference. Retry does not manufacture a second economic action. Logical append-only audit history excludes secrets; DB-owner tampering is not claimed cryptographically impossible. Source: SPEC §§7, 32.

SM08 exercises CLOSED only under documented completion/terminal rules. Unclaimed entitlements, pending/failed broadcasts and refundable exception funds cannot disappear because all currently queued claims finished. Test terminal/recovery behavior under pinned policy; never invent claim expiry.

## 9. Merkle commitment tests

Source: SPEC §§3, 12–13; IMPL §17; THREAT_MODEL §§20–23.

- **MERKLE01:** V03–V05 plus sizes 0,1,2,3,5 and larger sets; saved canonical bytes and node hashes reproduce across processes/restarts. Repeat with shuffled DB/input order and locale/timezone variations.
- **MERKLE02:** Mutate market, ID, side, accepted amount, payment reference, receiver reference, blinding or membership. Recomputed root differs and settlement against old root is refused. Duplicate ticket IDs rejected, not silently merged.
- **MERKLE03:** Inspect blinding generation and persistence: independent high-entropy randomness, not timestamp/side/amount/reused constant. Finalization retry preserves frozen blindings; it does not regenerate a new root.
- **MERKLE04:** Public lock object contains market_id, ledger_version, accepted_ticket_count, merkle_root, locked_at; no records, blindings, receiving/payout addresses or viewing keys in public serialization, caches or downloadable artifacts.
- **MERKLE05:** Attempt a small YES/NO/common-stake dictionary against roots/leaves without blinding. Confirm design requires unknown high-entropy blinding and reject unsalted fallback. This exercise validates implementation structure, not a formal proof of hiding.
- **MERKLE06:** Compare accepted set privately against all qualifying wallet receipts; inject omitted timely payment and fabricated accepted ticket. Ordinary reconciliation should detect mismatches and halt. Do not represent the public root as proof of completeness, truthful records, solvency or oracle correctness.
- **MERKLE07:** If inclusion proofs ship, verify correct proof and reject wrong leaf, index/sibling/root/version. Inclusion proofs are conditional tests, not a new MVP deliverable.

## 10. Settlement arithmetic and funds reconciliation

Source: SPEC §§16–19, 24, 26; THREAT_MODEL §§29–32, 54–55.

Run V12–V17 and V20 as pure-unit fixtures and settlement-DB integration. Repeat ordinary cases with NO winning and swapped side labels. Losing tickets have no winner entitlement. Amounts include original winning stake; do not add it again.

Additional fixed fee fixture: winners A=2,B=1; loser C=2; T=5,W=3; declared total pool-funded fees=1 → D=4. Bases A=2,B=1, remainders A=2,B=1, residual=1 → A=3,B=1. Outputs 4 plus fee 1 equal T. This is an arithmetic fixture, not a realistic network-fee quote.

Properties for ordinary W>0, nonnegative D:

```text
sum(winning stakes) = W
T = Y + N
base_i = floor(stake_i * D / W)
0 <= remainder_i < W
R = D - sum(base_i)
0 <= R < number_of_winners
payout_i = base_i or base_i + 1
sum(payout_i) = D
pool-funded mode: D + declared_total_settlement_fees = T
```

**ECON01:** Generate bounded valid ledgers, randomized ordering, fee values and both outcomes. Compare to independent arbitrary-precision reference arithmetic. Input reordering never changes allocation; lexical remainder ties use pinned ticket representation, not locale collation. Preserve failing seeds.

**ECON02:** Test large stake×D products, totals beyond JS safe-integer range, maximum configured bounds, invalid negative D, excessive fees and malformed/stale ledger data. Use sufficiently wide checked arithmetic; invalid inputs fail before authorization.

**ECON03:** Use transaction builder's actual fees with subsidy and pool-funded modes. Missing subsidy, fee drift, extra output, wrong change ownership or insufficient spendable notes fails closed or requires a newly reviewed consistent plan under frozen policy. No hidden fee or use of refundable exceptions to make up shortfalls.

**ECON04:** Reconcile spendable funds, accepted stakes, outstanding entitlements, exception liabilities, spent/confirmed transactions, approved fees/subsidy, change and explicitly retained balances. Before each authorization sum(outputs)+actual fee <= spendable funds allocated to that transaction, while funds for all other liabilities remain reserved. An arbitrary <= check alone is insufficient: every residual must have an explanation.

**ECON05:** Change claim order, restart settlement worker and enable/disable batching in separate preconfigured runs. Entitlements remain the approved ledger-wide allocation; no largest-remainder recomputation over only current claimants. Fee-mode-dependent totals follow frozen policy, never a post-OPEN convenience change.

**ECON06:** Zero/sub-fee entitlement and refunds, unclaimed winners, one-sided pool-funded fees and W=0/VOID fees use §3 clarifications. Do not silently round away liability, invent a minimum payout or add house revenue. Root protects locked book, not proof of honest accounting.

## 11. Claim/refund authentication, concurrency and UI

Follow SPEC §20's verification order: market exists → claimable state → ticket exists → frozen membership → commitment match → winner/refund eligibility → no prior successful claim/refund → correct network → shielded-capable destination → deterministic entitlement → atomic reservation. Instrument internal assertions while public errors remain privacy-safe.

| ID | Scenario | Expected result |
|---|---|---|
| CLAIM01 | V02, ticket ID alone, wrong market, unpaid/late/excluded/losing ticket, malformed secret | No entitlement reservation or payout; no leaked side/amount/eligibility in unauthenticated errors. |
| CLAIM02 | Valid UA, wrong-network UA, transparent-only address, unsupported shielded receiver, malformed string | Valid supported shielded path only; selecting transparent receiver from mixed UA cannot bypass policy. |
| CLAIM03 | V18 with parallel processes and actual DB isolation; same and different keys; payout-vs-refund race | One durable reservation and at most one successful economic entitlement; constraints survive worker race. |
| CLAIM04 | Same idempotency key/same request; same key with changed ticket, amount or destination | Existing state for identical request; conflict cannot silently redirect or produce another payment. Verify key scope is pinned. |
| CLAIM05 | Destination tampering after reservation/authorization; stale plan; caller retries with another UA | Bound authorized destination unchanged; any permitted preauthorization update uses documented new reviewed binding, never silently changes signed plan. |
| CLAIM06 | Suggested claim states UNCLAIMED→RESERVED→TX_PREPARING→AWAITING_SIGNATURE→BROADCAST→CONFIRMED | Broadcast is not paid; configured confirmation required. Failure states retain recoverable liability and transaction identity; no blind reset to UNCLAIMED. |
| CLAIM07 | VOID before/after lock, V20, W=0, declared exception refund cases | Deterministic eligible refunds, same bearer auth, fresh supplied UA, declared fees only; no guessed sender destination. |
| CLAIM08 | Completed winner payout followed by refund; completed refund followed by winner claim | Second economic payment refused. Separately refundable excess is handled only under explicitly defined exception accounting; it cannot become a second accepted-stake entitlement. |
| CLAIM09 | Losing local browser storage then importing export; multiple YES/NO tickets | Credentials restore independent tickets without account; network/version validation; no upload of whole portfolio; export does not lose secret/ID. |
| CLAIM10 | Lost secret and no export; claimed ownership assertion; stolen synthetic bearer secret | No identity bypass; synthetic thief possessing valid bearer credentials can claim if eligible, showing accepted risk. Race still pays once. |
| CLAIM11 | Display/copy/confirm payout UA and entitlement; invalid imported export or status response | User sees accurate destination/amount; malformed data cannot execute script or overwrite another ticket; status read does not leak private book under pinned policy. |
| CLAIM12 | No claimant submits refund/winner claim; operational timeout | Liability retained under documented terminal policy; no invented forfeiture or refund to original sender. |

## 12. Zcash testnet and architecture integration

Source: ARCHITECTURE §§4–6, 13, 19, 25; IMPL §6 spikes A–G and milestones M0–M8.

- **INT01 / M0:** Clean migrations/bootstrap work; product and wallet DB roles separated; no plaintext-secret field. Constraints enforce unique receipt and active/successful economic claim. Service auth limits wallet operations to necessary callers.
- **ZC01 / M1:** Allocate at least 100 sequential fresh receivers and concurrent receivers from one vault context. All distinct, supported shielded receivers; ticket mappings persist across service restart and wallet sync. Recovered allocation index does not reuse addresses.
- **ZC02 / M1:** Parse displayed/copied/QR ZIP-321 using actual compatible wallet(s). Amount and receiver exact; no required YES/NO memo or transparent fallback. Verify QR matches URI, not just visual appearance.
- **ZC03 / M1–M3:** Export required viewing capability to isolated watcher; real shielded deposit detected and mapped by receiver/diversifier. Prove available capability suffices to return amount/note/reference and cannot authorize spend. Record actual key capability rather than asserting a narrower key works untested.
- **INT02 / M2:** Accountless creation, client-generated commitment handshake, independent secret storage, export/import and local multi-ticket list work together. Dropped responses/retries recover the same intended ticket without breaking commitment context.
- **ZC04 / M3:** Real testnet exact deposits for YES and NO become correct confirmed tickets automatically at configured finality; rescans/restart do not duplicate stake.
- **ZC05 / M4–M6:** Real timed close, accepted-root publication, rule-bound resolution and correct claim to newly supplied UA. Receiving wallet confirms shielded receipt and exact entitlement; application reaches CONFIRMED only at configured threshold.
- **ZC06 / M6:** Real VOID/refund reaches fresh shielded receiving wallet; duplicate refund prevented. W=0 logic also exercised end-to-end using deterministic integration fixtures, with real refund path verified.
- **ZC07:** Inspect authorized/final transaction using wallet/library evidence to verify intended shielded recipients and no unintended transparent value flow. Public chain observation alone cannot validate hidden recipient amounts; compare privately with decrypted receiving-wallet evidence. Do not publish viewing keys for the demonstration.
- **ZC08:** Pinned stack rejects wrong network/unsupported transaction conditions and handles endpoint lag/outage. After dependency update repeat primitives and payout tests; prior success on another version is insufficient.

## 13. PCZT and authorization boundary

PCZT is P1 in implementation order; separation of preparation and authorization, plan binding and absence of web spending keys remain hard requirements. If PCZT is deferred, document actual safe authorization boundary and mark PCZT-specific tests DEFERRED; never claim M7 achieved. Source: PRD §24; SPEC §26; IMPL §§6, 22–23; THREAT_MODEL §§14–15, 38.

**PCZT01:** Build immutable SettlementPlanV1 with settlement_id, market_id, resolution_ref, ledger_root, outputs, total_output_zat, expected_fee_zat and plan_hash. Pin canonical hash construction, including how plan_hash itself is excluded from its preimage; source gives logical fields, not exact bytes. Independent hash vector required.

**PCZT02:** Construct/prove without unrestricted signing authority, transfer across isolated authorization boundary, review, sign, finalize, broadcast and confirm a real shielded testnet payout. Record pinned versions and all stage evidence. Watcher/web cannot access signer material.

**PCZT03:** Change recipient, amount, output count/order where committed, fee, market, resolution/root, settlement identifier or change ownership after review. Signer/finalization rejects plan mismatch; a stale or partially signed transaction cannot be relabelled with a new plan hash.

**PCZT04:** Compare final decoded/decrypted transaction effects against approved outputs, actual fee, intended vault change and wallet balance. A displayed matching hash alone does not prove the transaction conforms. Extra arbitrary outputs or insufficient funds block authorization.

**PCZT05:** Wrong network/version, missing proof, invalid signature, malformed PCZT, replayed authorization and interrupted transfer fail safely. Prepared claims remain recoverable without creating another authorized spend. Signer summary exposes market, outcome, root, plan hash, output count/total, fee and remaining reconciled balance.

## 14. Optional FROST 2-of-3

Run only after core payout and stable PCZT path. Use compatible pinned Zcash/FROST tooling for ceremony, shares, nonces, rerandomized signing and integration; no custom threshold cryptography. Source: SPEC §27; IMPL §24; THREAT_MODEL §§35–37.

| ID | Test | Acceptance |
|---|---|---|
| FROST01 | Isolated three-party ceremony and each valid signer pair | Real threshold-authorized shielded testnet spend confirms; all supported 2-of-3 combinations validated. One share alone cannot authorize. |
| FROST02 | One unavailable signer; two unavailable signers | Two available valid shares can complete; fewer than threshold halts safely, no automatic single-signer downgrade. |
| FROST03 | Invalid share/participant, mismatched session/message/plan, malformed signing response | Session rejected without paying or exposing shares; no signature accepted against wrong plan. |
| FROST04 | Interrupted/retried concurrent sessions, signer restart | Follow tooling's nonce lifecycle; consumed/uncertain nonce material never reused. Share/session secrets absent from logs/backups outside protected design. |
| FROST05 | Integration recovery and fallback configuration | Active mode recorded honestly; switching to fallback is an explicit deployment/custody decision, not a silent response to failed threshold signing. No plan/entitlement rewrite. |
| FROST06 | Threshold collusion and claims review | Document that two colluding signers can authorize malicious spends; FROST does not prove oracle truth, operator blindness or correct private ledger. |

Mocked signing rounds, a library unit test or standalone threshold demo not connected to active vault spend do not prove FROST is enabled. A separate spike may PASS while product FROST remains DEFERRED. Disclosed isolated single-authority signer is an accepted hackathon fallback.

## 15. Security and privacy adversarial tests

Inspect HTTP responses, hydration/HTML, client bundles, browser requests, caches, errors, polling, websockets if present, admin boundaries, metrics, proxy/access logs, traces, crash reporting and downloadable evidence. Verify controls at actual deployment configuration, not only development defaults.

| ID | Attack/inspection | Expected boundary | Threat-model sections |
|---|---|---|---|
| SEC01 | Public observer/other bettor requests all routes/status feeds while OPEN and after resolution | No sides, individual stakes, side totals/counts, odds, largest stakes, payout destinations/amounts or private feed. Optional total confirmed count only under profile; post-resolution stats need threat review. | 6–8, 53, 56 |
| SEC02 | URLs/referrers/ZIP-321 memos/analytics; browser cross-ticket portfolio traffic | Generic prediction route, minimal memo, no third-party analytics/scripts handling secrets, no unnecessary identity linkage. | 7, 9–10, 47 |
| SEC03 | DB snapshots, ordinary logs, traces, failed-request dumps and backups after claim | Server holds commitment, not durable plaintext secret; no claim secrets, keys, shares or seeds in audit/logs. Request body redaction covers error paths. | 11–13, 17–19, 51–52 |
| SEC04 | Simulated web/watcher credentials and filesystem access attempt to spend/access signer or viewing keys | No web spending key; watcher view-only; frontend no viewing authority; narrow service auth. Public UFVK publication prohibited. Compromised viewer can expose activity, an accepted privacy breach boundary. | 11–14, 35 |
| SEC05 | DB/private-book edits, fabricated/omitted receipts, root replacement | Root/plan mismatch and reconciliation stop ordinary workflow; no claim of public completeness proof or fully tamperproof DB-owner audit. | 20–23, 54–55 |
| SEC06 | XSS payloads in market text, oracle evidence, imported ticket, UA and error content | Escaped/sanitized text, CSP, safe rendering; no script reads secret or substitutes destination; no unsafe HTML. | 47, 49 |
| SEC07 | CSRF, cross-origin mutation, GET mutation, unauthorized operator actions | Auth/origin/CSRF safeguards as applicable; no GET state changes; protected pause/resolve/void/settlement endpoints. | 48, 50 |
| SEC08 | ID enumeration, wrong secrets, varied failure timing/responses, cross-ticket access | No unauthenticated private detail disclosure; generic errors and bounded throttling. Distinct internal reasons remain restricted. | 19, 44 |
| SEC09 | Unpaid-ticket floods, huge payloads, claim floods and bounded load | Rate/request/resource limits; wallet/matcher isolated; no eligibility corruption, secret logging or required personal signup added as anti-abuse shortcut. | 45–46 |
| SEC10 | UA substitution, replay, race, changed settlement output or fee | Atomic reservation, destination/plan binding and independent signer checks; no arbitrary unnoticed output. | 15–16, 38–39 |
| SEC11 | Wrong-network or transparent-only destination; unsupported shielded wallet | Reject unsupported operation; no transparent fallback in invoice, builder or final transaction. | 42–43 |
| SEC12 | Dependency lockfiles, release config, backups and least-privilege DB accounts | Pinned tested libraries; no real secrets in source/example config; protected encrypted backups and documented restoration; sensitive retention minimized. | 40–41, 51–52 |
| SEC13 | Wrong/ambiguous manual outcome and compromised admin credential proposal | Frozen rule/evidence and signer review exercised; ordinary admin access alone cannot bypass spend authorization. Trusted oracle/signer collusion risks remain disclosed. | 33–38, 50, 56 |

Security tests do not establish full anonymity, secrecy against the operator, formal cryptographic security or production readiness. The accepted boundaries in THREAT_MODEL §59 must appear in actual demo copy.

## 16. Failure injection and recovery

Source: SPEC §§10, 21–22, 28, 31; ARCHITECTURE §20; IMPL §§25, 27, 30.

Inject faults immediately before and after durable writes, external requests and authorization/broadcast. Verify restart from persisted state, not manual edits that change rules or unlock already-spent claims.

| ID | Fault | Expected recovery |
|---|---|---|
| REC01 | API exits after receiver allocation or ticket commit but before reply | Retry recovers intended mapping/ticket; no receiver reuse, dropped secret context or duplicate prediction. |
| REC02 | Watcher crashes before/after receipt insertion; duplicate queues; wallet full rescan | Stable receipt identity and checkpoint reconciliation; no double stake or orphaned timely payment. |
| REC03 | Product DB restart/older backup; wallet DB restoration | Reconcile receipts, mappings, roots, claims and actual chain spends before issuance/authorization resumes. Stale UNCLAIMED backup cannot repay already-paid entitlement. |
| REC04 | Chain endpoint outage/stale/divergent data during close | Delay unsafe finalization; issuance deadline still enforced; no observation-time eligibility shortcut or silent endpoint assumptions. Severe inconsistency leads safety review. |
| REC05 | Crash during ledger freeze/blinding/root publication | Idempotent completion with identical frozen ledger and root; no premature resolution or contradictory public commitment. |
| REC06 | Prover/builder/signing unavailable, signer refusal, invalid transaction | Claim retains durable recoverable state and entitlement; funds do not move; no automatic weakening of signer/shielded policy. |
| REC07 | Broadcast rejects before propagation | Persist failure; retry under known safe transaction status and pinned wallet behavior; no terminal consumption of unpaid claim. |
| REC08 | Broadcast accepted but timeout/crash occurs before app stores response | Durable prepared tx identity/raw signed transaction or recoverable wallet association lets reconciliation find the spend; do not build replacement based only on missing RPC response. Covers V19. |
| REC09 | Transaction unmined/expired/dropped; reorg removes payout inclusion | BROADCAST is not CONFIRMED; reconcile canonical status and note spendability before any replacement. Absence from one endpoint is insufficient proof of safe replacement. |
| REC10 | Post-confirmation deep inconsistency or double-spend report | Safety/operator review; no silent replay of entitlement or rewrite of settled history. |
| REC11 | PAUSE during outage; recovery crosses original close | Preserve original rules and classify pending payments under pinned policy; do not extend market for convenience. |
| REC12 | Browser state loss with and without exported credential | Export restores claim; no export means no identity bypass. Restart does not infer payout from deposit. |
| REC13 | Batched payout failure if enabled | Durable membership; no claim appears in two active batches; per-output confirmation/entitlement mapping exact; unbatched core remains viable. |

Recovery rehearsal must record time to recovery and unresolved liabilities. Backup success alone is insufficient: demonstrate restore plus chain reconciliation. Do not infer production recovery guarantees from one local exercise.

## 17. End-to-end acceptance scenarios

### E2E01 — ordinary YES market (P0)

1. Start a clean/reproducible environment with pinned rules, network, fee mode and low demo confirmation threshold declared before OPEN.
2. Configure objective market and publish YES/NO definitions, UTC close, sources and void rules; OPEN.
3. Wallet A creates YES ticket for 0.01 ZEC (1,000,000 zat); browser saves/export credential and displays fresh ZIP-321.
4. Wallet A pays shielded; watcher automatically confirms the correct ticket at configured threshold.
5. Wallet B creates NO ticket for 0.02 ZEC (2,000,000 zat), gets a different receiver and funds shielded.
6. Observe as unauthenticated third party: public page/API exposes neither side nor amount nor odds. Inspect actual traffic, not just screen.
7. Reach original UTC close; verify issuance refused, chain-classification/finality completed, ledger frozen and root/count published.
8. Resolve YES using frozen source/evidence; settlement references exact frozen root and resolution.
9. A imports/uses bearer ticket and supplies new shielded-capable UA. With subsidized fees entitlement is exactly 3,000,000 zat; with pool-funded fees it is T minus declared fees under approved policy.
10. Preview destination/entitlement, reserve atomically, prepare immutable plan, authorize through actual isolated active signer, broadcast and confirm.
11. Receiving wallet confirms exact shielded receipt; replayed/concurrent claim cannot pay again; losing ticket cannot claim winner entitlement.
12. Reconcile wallet funds, change, fees, liabilities and completion status. Public artifacts contain no private book or viewing key.

### E2E02 — NO wins (P0)

Repeat with NO winner and several unequal winning stakes to exercise V12–V14 residual/tie behavior at valid configured stake sizes. Reorder claim submission; approved allocations stay unchanged. Prove no hardcoded YES filter.

### E2E03 — VOID and NO_WINNER_REFUND (P0)

Run V20 through actual shielded refund path. Separately resolve a one-sided accepted market to the empty side and exercise W=0 refund mode. Verify both sides' accepted stakes, same bearer auth, fresh UAs, declared fees, replay rejection and no operator award. Also cover VOID before ledger lock using pinned refund accounting.

### E2E04 — boundary and interrupted payout (P0 integrity)

Use deterministic chain/fault fixtures with real DB/service integration: timely receipt scanned after close, late receipt, duplicate scan, pre-finality reorg and accepted-but-timeout payout. Recover through normal workers. Accepted set and entitlements remain deterministic; no replacement while spend is uncertain. Clearly label fault-injected chain scenarios separately from real testnet payout evidence.

### E2E05 — optional modes (conditional)

If PCZT ships, run E2E01 through it and pass PCZT01–05. If FROST ships, active vault payout uses real 2-of-3 and FROST tests pass. If batching ships, repeat claims in different orders and include partial batch/failure recovery. P2 absence is disclosed, not a reason to block core lifecycle.

## 18. Demo acceptance and release gates

The accelerated demo must use the same application and settlement path, a predeclared short close, supported test environment and tiny stakes. A prepared/already-resolvable event is allowed; mocked deposits/settlement are not proof of a working lifecycle. Source: PRD §§32–33; IMPL §§28–30, 34.

Before judging, record checklist evidence:

- [ ] M0–M6 core flow and E2E01–03 pass in integrated environment, with real testnet shielded payout/refund evidence.
- [ ] SPEC §35 all 20 vectors have recorded results; hash/tree vectors have pinned literal bytes and independent expected hashes.
- [ ] Exact close policy/finality and economic ambiguities affecting demo are frozen before OPEN; no post-OPEN deadline/fee changes.
- [ ] No public live side/stake book or public viewing key; fresh receivers; no transparent flow.
- [ ] Client secret generation, commitment-only server storage, ticket backup and bearer warnings verified; no ordinary secret logs.
- [ ] Double-claim/refund races, destination substitution, settlement arithmetic and solvency tests pass.
- [ ] Locked root precedes settlement and detects committed-record edits; oracle evidence recorded.
- [ ] Web/watcher lack spending authority; signer reviews bound plan and rejects mismatched outputs/fees.
- [ ] Uncertain broadcast recovery prevents duplicate payout; faults/restarts do not change rules or erase liability.
- [ ] Active PCZT/FROST/batching status shown accurately; optional deferrals and accepted residual risks in KNOWN_LIMITATIONS.md.
- [ ] Repeatable clean-state rehearsal completed; pre-funded testnet wallets, protected exports and prior completed transaction evidence ready.
- [ ] Demo confirmation threshold labelled a demo parameter, not production security policy.

Required privacy wording from THREAT_MODEL §56:

> Positions, stake sizes and payouts are hidden from the public blockchain and other market participants. The market operator has the viewing/application access required for settlement.

Explain manual-oracle trust, operator-visible book, absence of complete public ledger/solvency proof, bearer theft/loss, web/IP/timing correlation, infrastructure dependence, no formal audit and single-signer custody risk if fallback is active. Do not claim fully anonymous, operator-blind, trustless, decentralized-oracle or production-ready threshold security.

**No-go:** any failing P0/core test, critical THREAT_MODEL §57 item, unresolved funds mismatch, transparent fallback, duplicate payment, unbound authorization or false privacy/FROST claim. A mandatory dependent test BLOCKED/NOT RUN is not a passing gate. High-priority unresolved defects require explicit risk review and cannot waive a normative invariant. Optional DEFERRED features are acceptable only when the core works and the limitation is disclosed.

Live endpoint delay may require showing clearly labelled prior real transaction evidence as contingency. It must not be presented as the current live run having completed. Never shorten confirmation requirements or rewrite the market close during the presentation.

## 19. Requirements and milestone traceability

| Approved requirement | Coverage |
|---|---|
| PRD FR-01–03 market/binary/variable stake | U01–03, U07, SM02, E2E01–02 |
| FR-04–06 unique ticket/receiver/ZIP-321 | U04–05, INT02, ZC01–02, PAY10 |
| FR-07–10 shielded deposit/watcher/matching/status | PAY01–12, ZC03–04, SEC01/11 |
| FR-11/11A close and exceptional pause | SM01–05, PAY05–11, REC04/11 |
| FR-12 ledger commitment | V03–05, MERKLE01–07, SM05 |
| FR-13–14 resolution/settlement | SM06, V12–17, ECON01–06, E2E02 |
| FR-15–17 claim/auth/destination/double claim | V01–02/V18–19, CLAIM01–06, SEC10, REC08 |
| FR-18–19 void/refund | V20, CLAIM07–08/12, E2E03 |
| FR-20 signing separation | SEC04/10, PCZT01–05, ZC05 |
| FR-21 conditional FROST | FROST01–06, E2E05, demo disclosure |
| PRD PS-01–04 public privacy/accountlessness | SEC01–02/08, INT02, CLAIM09 |
| PS-05–09 secret/memo/UFVK/key/log boundaries | U04–05, SEC02–04/12, ZC03 |
| PS-10–14 network disclaimer/fresh UA/atomicity/hiding/no fallback | CLAIM02–08, MERKLE03–05, SEC10–11, DEMO gates |
| IMPL M0–M3 environment/primitives/ticket/deposit | INT01–02, ZC01–04 |
| M4–M6 market integrity/economics/full lifecycle | SM, MERKLE, ECON, CLAIM, E2E01–04 |
| M7 PCZT; M8 optional FROST | PCZT, FROST; explicit DEFERRED status if absent |
| M9 hardened repeatable demo | SEC, REC, §18 checklist and rehearsal |

## 20. Test report and completion record

For each candidate, produce a concise report:

```text
Build/profile/source document hashes:
Network and pinned wallet/PCZT/FROST versions:
Active signer mode and optional features:
Execution dates (UTC):
Results by case ID: PASS / FAIL / BLOCKED / NOT RUN / DEFERRED / N/A
Real testnet deposit, payout and refund evidence references:
Golden-vector review reference:
Funds reconciliation summary and outstanding liabilities:
Security/privacy findings and recovery evidence:
Unresolved protocol clarifications or defects:
Approved feature deferrals and disclosure text:
Demo rehearsal outcome and go/no-go owner:
```

Keep restricted raw evidence separate from public demo artifacts. Public summaries must not attach secrets, viewing material, private ledgers or payout mappings. Any protocol-affecting clarification updates the referenced source/profile, vectors and tests together; this document cannot authorize a silent redesign.

The core is accepted only after a repeatable real shielded lifecycle and refund path pass alongside deterministic economics, close/ledger integrity, bearer authentication and the critical security/privacy gates. PCZT and genuine FROST strengthen that lifecycle in the implementation order already approved.

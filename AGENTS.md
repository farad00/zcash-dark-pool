# Implementation authority

Read ALL of `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/SPEC.md`,
`docs/THREAT_MODEL.md`, `docs/IMPLEMENTATION_PLAN.md`, and `docs/TEST_PLAN.md`
completely before implementation. They are the source of truth; this file is a
summary, not an amendment. SPEC refines behavior explicitly deferred by earlier
documents; the implementation plan controls sequencing and the threat model
controls security/privacy boundaries.

Stop and ask the user BEFORE changing any frozen decision in SPEC, ARCHITECTURE,
or THREAT_MODEL, even if a library makes it inconvenient. Do not silently invent
missing protocol or economic rules. Record ambiguities and block dependent work.
Preserve the six approved documents. The user reviewed Phase 0/1 and explicitly
authorized Phase 2 only. Stop after Phase 2; do not begin Phase 3 or build the
prediction frontend. TEST_PLAN section 3 ambiguities still require explicit review.
Phase 2 is COMPLETE; see docs/PHASE2_RESULTS.md. Do not continue implementation
without separate user authorization. Claim-only encoding approval is not Phase 3 approval.

## Product and privacy invariants

- Single binary YES/NO parimutuel event pool; no AMM, order book, tradable shares,
  cross-chain, fiat, custom ZK, decentralized oracle, or production rollout.
- Testnet ONLY; tiny valueless test funds, never meaningful funds or mainnet keys.
- Shielded-only deposits, change and payouts/refunds. Reject unsupported/wrong
  network addresses; NEVER introduce transparent fallback.
- One market vault/account context with a fresh diversified shielded receiver per
  ticket; no public YES/NO pots. Prove Orchard receiver generation with the stack.
- ZIP-321 requests carry the exact requested amount; no YES/NO memo requirement.
  Match notes through receiver/diversifier, never amount, sender guess or side memo.
- No public sides, individual stakes, side counts/totals, odds, largest stake,
  directional activity, private receipt/payout mappings or destinations. Optional
  total confirmed count needs a pinned profile; post-resolution stats need review.
- Operator visibility of the private book is accepted. No operator-blind,
  trustless, fully anonymous, decentralized-oracle or audited-production claims.
  Zcash does not hide IP/browser/timing metadata. No third-party analytics by default.
- Accountless independent bearer tickets with local multi-ticket management and
  export/recovery; do not create a required server-side identity/portfolio graph.

## Authority and secret handling

- Frontend gets no wallet authority; web/API gets no spending authority; watcher
  uses tested viewing capability only. Viewing-key compromise is a privacy breach.
- Separate product PostgreSQL and Zcash wallet SQLite. Narrow internal interfaces;
  spending authorization belongs to an isolated signer, never public request handling.
- Never publish UFVKs. Never commit seeds, spending keys, FROST shares, claim secrets,
  wallet/viewing databases, backups, private evidence, credentials or populated envs.
  `.env.example` contains names/placeholders only, no signing material.
- Never log secrets. Minimize/redact sides, amounts, addresses, payment URIs and IP
  associations, including request/error dumps. Protect backups and minimize retention.
- Ticket IDs have >=128 bits CSPRNG entropy, independent client claim secrets have
  256 bits. ID alone cannot claim. Server stores only commitment; no secret at creation.
- Default commitment: BLAKE2b-256("DARKPOOL_CLAIM_V1" || encode(market_id) ||
  encode(ticket_id) || claim_secret). Keep domain separation and canonical bytes;
  never drop ticket binding to resolve the creation-handshake ambiguity.
- User approved the claim-only V1 encoding exactly as proposed. Approval and
  implementation profile: docs/CLAIM_ENCODING_V1_IMPLEMENTATION.md. Other
  TEST_PLAN section 3 ambiguities, including the creation handshake, stay open.
- Lost bearer secret has no identity-based recovery/bypass. Export is sensitive.

## Market and economic rules (future phases)

- All accounting is checked integer zatoshis (1 ZEC = 100,000,000 zat), with wide
  multiplication; no floating point. Requested amount is economic stake. Underpaid
  is not accepted; qualifying partials may aggregate before deadline. Excess cannot
  increase stake or silently fund winners; preserve exception/refund liabilities.
- Stable note-level receipt identity, unique storage and idempotent scans/matching;
  txid alone cannot deduplicate multiple notes. Roll back pre-finality reorgs;
  post-finality inconsistencies stop for safety review.
- Nine public states: DRAFT, OPEN, PAUSED, LOCKED, RESOLVED, PAYING, VOID,
  REFUNDING, CLOSED. Audit transitions. LOCK_FINALIZING may be internal only.
- Freeze economically meaningful rules before OPEN. Published UTC close stops
  issuance at now >= close. Chain evidence, never observation/broadcast time,
  classifies boundary payments. Finalize scanning and declared confirmations BEFORE
  freezing accepted ledger. PAUSE is exceptional; preserve original close or VOID.
- Freeze accepted membership, then publish blinded binding/hiding Merkle commitment
  before resolution. Independent high-entropy blindings, persisted across retries,
  versioned canonical encoding and deterministic leaf order. No public blindings.
  Root does not prove completeness, honesty, solvency or oracle correctness.
- Manual YES/NO/VOID oracle obeys frozen rule/source hierarchy; ambiguous => VOID.
- Settlement includes only CONFIRMED frozen tickets. T=Y+N; W=winning stake;
  D=T with subsidy or T-declared fees. base_i=floor(stake_i*D/W), residuals by
  descending remainder, lexical ticket-ID tie-break, over the whole frozen ledger.
  T=0: nothing; one-sided winners: stakes subject to fees; W=0: NO_WINNER_REFUND.
  No house fee, hidden haircut, invented expiry/forfeiture, or operator award.
- Follow SPEC section 20 claim verification order. Atomically reserve claims,
  enforce idempotency and mutually exclusive successful payout/refund. Claimant
  supplies fresh network-valid shielded UA; never infer deposit sender. Bind
  destination, outputs, root, resolution and fee to immutable approved plan.
- Outputs + fees <= allocated spendable funds, while preserving all liabilities;
  fail closed on unexplained mismatch. Broadcast != confirmed. Reconcile uncertain
  transaction identity/spends BEFORE creating replacements or resetting claims.

## Dependencies, sequence and evidence

- Use maintained Zcash wallet libraries, official upstream APIs/source and current
  compatible releases. Do not hand-roll Orchard transactions or guess signatures.
  Resolve candidate versions, actually build/test, THEN pin tested direct versions
  and commit lockfiles. Preserve actual compiler errors; no security downgrade to build.
- Orchard receiver/key format and value-pool identity are distinct after NU6.3.
  Current libraries route Orchard-protocol receivers to Ironwood for payments;
  record the actual pool in live evidence. ARCHITECTURE requires current upgrade
  compatibility; never force obsolete consensus rules or mislabel received notes.
- Receiver matching must compare the Orchard receiver or scoped diversifier in
  the correct vault context, not complete UA strings: a watcher can reconstruct
  additional receiver types while retaining the exact paid shielded receiver.
- Upstream devtool revision 5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8 has a
  reproduced PCZT Ironwood-signing gap: exit 0 can leave real spends unsigned.
  See the recorded local CLI patch and SPIKE_RESULTS. Always verify real
  authorization, approved outputs/change/fee, extraction and mined receipt;
  a successful process exit alone cannot pass a signing or payout gate.
- Phase 1: A initialization/fresh receiver/persistence; B ZIP-321; C view-only scan;
  D deterministic ticket matching; E real shielded payout; F PCZT; G FROST only
  AFTER A-F pass. No mock substitutes for real testnet evidence.
- Simple isolated signer first, PCZT construction/authorization separation next,
  genuine compatible 2-of-3 FROST last. Disclose fallback; never auto-downgrade on
  signer failure. FROST active only after real threshold shielded spend; follow
  official share/nonce/session lifecycle, no custom threshold crypto.
- Phase 1 review result: A-F PASS, G DEFERRED. Official frost-tools revision
  06c0dbdbb1bac9b99cd255e74ba2f387c295e660 requires an unmerged Orchard FVK
  constructor explicitly marked incompatible with quantum recoverability and
  scheduled for removal; published Orchard 0.15.5 rejects it with E0599.
  Do not claim FROST is active or replace the tested stack with that fork silently.
  Phase 2 is now authorized after user review; stop before Phase 3.
- Keep `docs/SPIKE_RESULTS.md` current with exact versions, source references,
  commands, UTC dates, PASS/FAIL/BLOCKED/NOT RUN/DEFERRED, redacted transaction
  evidence and unresolved issues. Local library tests != live wallet/payment PASS.
- TEST_PLAN section 3 lists unpinned encoding/blinding/tree/close/overshoot/fee/
  exception/pause/expiry/handshake/status details. Do not freeze these accidentally.
- Run appropriate builds, format/lint/tests; preserve golden literal vectors with
  independent expectations when their protocol details are frozen. No passing gate
  from a mock, fixture, BLOCKED or NOT RUN result. Verify actual privacy boundaries.

Required eventual product wording (do not present unbuilt functionality as achieved):
"Positions, stake sizes and payouts are hidden from the public blockchain and other
market participants. The market operator has the viewing/application access required
for settlement."

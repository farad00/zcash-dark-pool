# Approved V1 claim commitment implementation

The user explicitly approved `packages/protocol/CLAIM_ENCODING_PROPOSAL.md`
**exactly as written** on 2026-10-04, and authorized finishing Phase 2 only.
This note records that approval without changing any frozen source document.
The original proposal is retained unchanged as the reviewed artifact; its
historical UNPINNED status is superseded by this approval.

Approved proposal SHA-256:
`58F9370BEAB486D81F8D63975149F1DBD0310416004F7698D3C02F990168D12D`.
Profile ID: `DARKPOOL_CLAIM_V1_ID_FRAME_1`.

## Approved bytes

```text
encode(id) = 0x01 || u32_big_endian(UTF8(id).byte_length) || UTF8(id)
preimage = ASCII("DARKPOOL_CLAIM_V1") || encode(market_id)
           || encode(ticket_id) || raw_32_byte_claim_secret
commitment = BLAKE2b(preimage, output_length=32_bytes)
```

Exact UTF-8; no normalization, case folding, implicit prefix/terminator, salt,
personalization or JSON serialization. Ill-formed Unicode is rejected before
TextEncoder can replace lone surrogates. Lengths are unsigned 32-bit big-endian
UTF-8 **byte** lengths. Each ID has its own version byte. Unsupported versions
and secrets other than exactly 32 Uint8Array bytes are rejected. The hash is
native BLAKE2b-256, not truncation of BLAKE2b-512. Both final IDs remain bound.

`encodeClaimId` and `deriveClaimCommitment` in the shared protocol package implement
this profile using exactly pinned `@noble/hashes` 2.4.0. Digest results use lowercase
hexadecimal for the existing in-memory ClaimCommitment type. That representation
does not choose wire, ticket export, production ID or database encoding. IDs must
already be known; this function does not invent a creation handshake or issue IDs.
Encoding empty bytes is not approval of an empty production market/ticket ID.

The hash is streamed in the fixed domain/market/ticket/secret order and destroyed
after use; no combined secret-bearing preimage is exposed by the production API.
It does not mutate the caller's secret, log secrets or authorize/reserve a claim.
Actual claim verification order, authentication endpoints and atomic reservation
remain later-phase work. Browser integration is not claimed by Node unit tests.

## Independent literal vectors

`test-vectors/claim-commitment-v1.json` contains literal ID frames, domain, complete
synthetic preimages and expected digests for five cases. Rust
`scripts/dev/phase2-claim-reference.rs` independently constructs frames from Rust
UTF-8 bytes and hashes with `blake2b_simd` 1.0.5 `Params::hash_length(32)`.
It imports neither production TypeScript nor the JavaScript hash library.
Its separate reproducible manifest/lockfile are under `test-vectors/reference`;
the product Cargo manifest/lockfile are unchanged.

Primary TEST_PLAN V01: synthetic m1/t1, secret bytes 00 through 1f:

```text
39fe1b1e0383976626942f13f1defe23504fb5c73cc2cc1c23894d70bfef1fa7
```

Other vectors cover multibyte Unicode, `ab|c` versus `a|bc`, and a 256-byte ID.
Each also records independently generated truncated-512 and alternate-domain
digests as negative controls. Production tests compare saved literal expectations;
they do not generate expected digests with the production implementation at runtime.
The Rust helper accepts no arguments or private inputs and emits only synthetic
fixture material. Fixed synthetic secrets must never be used for real tickets.

## Approval boundary

This approval covers **only claim commitment encoding**. It does not resolve:

- production ticket-ID representation, entropy evidence, issuance or creation handshake;
- ledger serialization/blinding placement, leaf ordering, odd/empty/single tree conventions;
- settlement-plan hashing, export encoding or status-read authorization;
- chain close mapping, receipts/aggregation/overshoot and payment exceptions;
- fee allocation, claimable states, pause, expiry, terminal or zero-output rules;
- any other economic policy or optional public counts/batching.

The six frozen documents and SPIKE_RESULTS remain unchanged. FROST remains
DEFERRED/inactive; the demonstrated isolated signer + PCZT path is retained.
This implementation introduces no Phase 3 schema or Phase 3+ application work.

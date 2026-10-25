# Claim encoding proposal — awaiting user approval

**Status: UNPINNED / NOT ENABLED.** This is a review artifact, not a frozen
protocol or executable conformance vector. SPEC §2 fixes market/ticket binding
and the default BLAKE2b-256 formula; TEST_PLAN §3 says exact bytes require review.

Proposed claim encoding profile:

```text
encode(id) = 0x01 || u32_big_endian(UTF8(id).byte_length) || UTF8(id)
preimage = ASCII("DARKPOOL_CLAIM_V1") || encode(market_id)
           || encode(ticket_id) || raw_32_byte_claim_secret
commitment = BLAKE2b(preimage, output_length=32_bytes)
```

The version byte belongs to each ID frame. No additional implicit prefix,
terminator, salt, hash personalization or JSON encoding. BLAKE2b-256 means the
32-byte output parameterization, never truncated BLAKE2b-512. The IDs are exact
Unicode strings encoded as UTF-8, without normalization or case folding;
ill-formed Unicode must be rejected rather than silently replaced. IDs cannot
exceed the frame's unsigned 32-bit length. Encoding changes require a new reviewed
version. The function must know the final market and ticket IDs; no unbound
commitment or dropped ticket binding is permitted.

For TEST_PLAN V01's synthetic m1/t1 fixture, the proposed frames are:

```text
domain:     4441524b504f4f4c5f434c41494d5f5631
market m1:  01000000026d31
ticket t1:  01000000027431
secret:     000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

After approval, use a maintained browser-compatible BLAKE2b implementation;
produce literal digests with an independent implementation, and test repeatability,
bit flips, changed market/ticket, ambiguous concatenation, field order independence,
wrong version, and 31/33-byte secrets. The current package has not enabled this
encoding or claimed any of these commitment cases PASS.

This proposal does **not** choose production ticket-ID representation or issuance
handshake, ledger serialization/blinding placement, Merkle conventions, plan hash,
export encoding, server creation flow or any economic policy. Approval of these
claim bytes would not authorize Phase 3 or any later phase. Frozen documents remain
unchanged; an approved profile would be recorded in a separate implementation note.

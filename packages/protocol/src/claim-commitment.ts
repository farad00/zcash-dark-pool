import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ClaimCommitment } from "./domain.js";

/** Approved claim-only encoding; does not choose ticket issuance or any other encoding. */
export const CLAIM_ENCODING_VERSION = 1;
export const CLAIM_COMMITMENT_DOMAIN = "DARKPOOL_CLAIM_V1";
const encoder = new TextEncoder();
const domainBytes = encoder.encode(CLAIM_COMMITMENT_DOMAIN);

export interface ClaimCommitmentInputV1 {
  readonly version: 1;
  /** Final IDs must already be known. Their production issuance/format is separate. */
  readonly market_id: string;
  readonly ticket_id: string;
  readonly claim_secret: Uint8Array;
}

function requireVersion(version: number): void {
  if (version !== CLAIM_ENCODING_VERSION) {
    throw new RangeError("Unsupported claim encoding version");
  }
}

/** 0x01 || unsigned u32 big-endian UTF-8 BYTE length || exact UTF-8 bytes. */
export function encodeClaimId(
  id: string,
  version: 1 = CLAIM_ENCODING_VERSION,
): Uint8Array {
  requireVersion(version);
  if (typeof id !== "string") throw new TypeError("Invalid claim identifier");
  // TextEncoder silently replaces lone UTF-16 surrogates. Reject them beforehand.
  // Valid pairs are yielded as one non-surrogate Unicode code point.
  for (const character of id) {
    const point = character.codePointAt(0);
    if (point !== undefined && point >= 0xd800 && point <= 0xdfff) {
      throw new TypeError("Ill-formed claim identifier Unicode");
    }
  }
  const bytes = encoder.encode(id);
  if (bytes.length > 0xffff_ffff)
    throw new RangeError("Claim identifier too long");
  const frame = new Uint8Array(5 + bytes.length);
  frame[0] = CLAIM_ENCODING_VERSION;
  new DataView(frame.buffer).setUint32(1, bytes.length, false);
  frame.set(bytes, 5);
  return frame;
}

/**
 * SPEC §2 and user-approved V1 profile. Returns lowercase hexadecimal digest
 * for the existing in-memory commitment type; no wire/export format is implied.
 * Pure calculation only: not claim verification/reservation or a creation flow.
 */
export function deriveClaimCommitment(
  input: ClaimCommitmentInputV1,
): ClaimCommitment {
  requireVersion(input.version);
  if (
    !(input.claim_secret instanceof Uint8Array) ||
    input.claim_secret.length !== 32
  ) {
    throw new TypeError("Claim secret must be exactly 32 bytes");
  }
  const market = encodeClaimId(input.market_id, input.version);
  const ticket = encodeClaimId(input.ticket_id, input.version);
  // Streaming avoids allocating a second full secret-bearing preimage.
  const hash = blake2b.create({ dkLen: 32 }); // Native BLAKE2b-256, never truncation.
  try {
    return bytesToHex(
      hash
        .update(domainBytes)
        .update(market)
        .update(ticket)
        .update(input.claim_secret)
        .digest(),
    ) as ClaimCommitment;
  } finally {
    hash.destroy();
  }
}

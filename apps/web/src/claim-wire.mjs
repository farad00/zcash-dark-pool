// Transport bounds only; original bearer profile and native address validation remain authoritative.
export const CLAIM_MAX_BYTES = 16384;
const fail = () => {
  throw new Error("CLAIM_NOT_CONFIRMED");
};
export function payoutText(value) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(value)
  )
    fail();
  return value;
}
export function validateClaimPacket(value) {
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      "claim_secret,idempotency_key,market_id,payout_ua,ticket_id" ||
    typeof value.market_id !== "string" ||
    !value.market_id.isWellFormed() ||
    !value.market_id.length ||
    /[\u0000-\u001f\u007f]/u.test(value.market_id) ||
    new TextEncoder().encode(value.market_id).length > 8192 ||
    typeof value.ticket_id !== "string" ||
    typeof value.claim_secret !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.ticket_id) ||
    !/^[0-9a-f]{64}$/.test(value.claim_secret) ||
    value.idempotency_key !== `participant_v1_${value.ticket_id}`
  )
    fail();
  payoutText(value.payout_ua);
  return value;
}
export function parseClaimJson(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length > CLAIM_MAX_BYTES)
      fail();
    const text = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(
      bytes,
    );
    const value = JSON.parse(text);
    // One canonical JSON transport: rejects duplicate/escaped duplicate keys and trailing data.
    if (JSON.stringify(value) !== text) fail();
    return value;
  } catch {
    fail();
  }
}

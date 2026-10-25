import { payoutText, validateClaimPacket } from "./claim-wire.mjs";
const fail = () => {
  throw new Error("CLAIM_NOT_CONFIRMED");
};
export async function privatePost(path, packet) {
  if (!["/api/claim", "/api/claim-address"].includes(path)) fail();
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(packet),
    });
    if (!response.ok) fail();
    return await response.json();
  } catch {
    fail();
  } finally {
    clearTimeout(timer);
  }
}
export async function submitTicket(vault, localId, payout_ua) {
  let credential;
  try {
    payoutText(payout_ua);
    if (!(await vault.canExport(localId))) fail();
    credential = await vault.readCredential(localId);
    const packet = validateClaimPacket({
      market_id: credential.market_id,
      ticket_id: credential.ticket_id,
      claim_secret: Array.from(credential.claim_secret, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
      payout_ua,
      idempotency_key: `participant_v1_${credential.ticket_id}`,
    });
    const result = await privatePost("/api/claim", packet);
    if (
      !["RESERVED", "PREPARED"].includes(result.status) ||
      result.payment !== "NOT_SENT"
    )
      fail();
    return { status: result.status, environment: result.environment };
  } finally {
    credential?.claim_secret.fill(0);
  }
}

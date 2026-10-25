// Private status transport only. The existing issuance capability is NOT a claim credential.
export const statusUnavailable = () => {
  throw new Error("PAYMENT_STATUS_UNAVAILABLE");
};
export function paymentStatusPacket(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "issuance_token,market_id,ticket_id" ||
    typeof value.market_id !== "string" ||
    !value.market_id.length ||
    !value.market_id.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(value.market_id) ||
    new TextEncoder().encode(value.market_id).length > 8192 ||
    ![value.ticket_id, value.issuance_token].every(
      (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
    )
  )
    statusUnavailable();
  return value;
}
export function paymentStatusResult(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      "environment,financial_authorization,status" ||
    !["SYNTHETIC_TEST_ONLY", "DISPOSABLE_TEST", "TESTNET_OBSERVATION"].includes(
      value.environment,
    ) ||
    value.financial_authorization !== "NOT_GRANTED" ||
    ![
      "AWAITING_PAYMENT",
      "CONFIRMED",
      "UNAVAILABLE",
      ...(value.environment === "SYNTHETIC_TEST_ONLY" ? [] : ["DETECTED"]),
    ].includes(value.status)
  )
    statusUnavailable();
  return Object.freeze({
    status: value.status,
    environment: value.environment,
    financial_authorization: value.financial_authorization,
  });
}
export function paymentStatusText(value) {
  const result = paymentStatusResult(value);
  const synthetic = result.environment === "SYNTHETIC_TEST_ONLY";
  const text = {
    AWAITING_PAYMENT:
      "Not yet accepted. This does not prove that no payment was received.",
    CONFIRMED: synthetic
      ? "Accepted by the synthetic watcher at the declared confirmation threshold."
      : "Accepted in the watcher records at the declared three-confirmation threshold.",
    DETECTED:
      "A payment was detected. It is not accepted; canonical confirmation or exception review is pending.",
    UNAVAILABLE: "Payment status unavailable; acceptance must not be assumed.",
  }[result.status];
  return (
    (synthetic
      ? "SYNTHETIC TEST ONLY. "
      : result.environment === "DISPOSABLE_TEST"
        ? "DISPOSABLE TEST FIXTURE. "
        : "ZCASH TESTNET OBSERVATION. ") +
    text +
    " Financial authorization NOT_GRANTED. This is not claim eligibility."
  );
}

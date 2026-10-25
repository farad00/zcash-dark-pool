/** SPEC §2: client-only primitive, independent of the unresolved creation handshake. */
export function generateClaimSecret(): Uint8Array {
  // No injected RNG or fallback: production always calls the platform CSPRNG.
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure randomness unavailable");
  }
  const secret = new Uint8Array(32);
  try {
    globalThis.crypto.getRandomValues(secret);
    return secret;
  } catch {
    secret.fill(0);
    // Do not propagate an external error that could contain sensitive data.
    throw new Error("Secure randomness failed");
  }
}

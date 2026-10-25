export function matchesCredential(
  market: string,
  ticket: string,
  secret: Uint8Array,
  expected: string,
): boolean;
export function validateDestination(
  ua: string,
): Promise<Readonly<{ payout_ua: string; orchard_receiver_hex: string }>>;

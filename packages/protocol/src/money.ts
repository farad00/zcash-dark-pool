/** SPEC §§1, 6, 18. All bounds are caller-supplied; no demo limits are chosen here. */
export const ZATOSHIS_PER_ZEC = 100_000_000n;

export interface AmountBounds {
  readonly min: bigint;
  readonly max: bigint;
}

function nonnegative(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError("Expected nonnegative integer zatoshis");
  }
}

function validateBounds(bounds: AmountBounds): void {
  nonnegative(bounds.min);
  nonnegative(bounds.max);
  if (bounds.min > bounds.max) throw new RangeError("Invalid amount bounds");
}

/** Strict ASCII decimal grammar. No whitespace, sign, exponent, separators or rounding. */
export function parseZecToZatoshi(value: string, bounds: AmountBounds): bigint {
  validateBounds(bounds);
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value)
  ) {
    throw new TypeError("Invalid ZEC decimal");
  }
  const [whole, fraction = ""] = value.split(".");
  // Reject oversized input before conversion, without imposing an economic maximum.
  if (
    whole === undefined ||
    whole.length > (bounds.max / ZATOSHIS_PER_ZEC).toString().length
  ) {
    throw new RangeError("Amount outside configured bounds");
  }
  const amount =
    BigInt(whole) * ZATOSHIS_PER_ZEC + BigInt(fraction.padEnd(8, "0"));
  if (amount < bounds.min || amount > bounds.max) {
    throw new RangeError("Amount outside configured bounds");
  }
  return amount;
}

/** Exact display string with eight decimal places; never converts value to Number. */
export function formatZatoshi(value: bigint): string {
  nonnegative(value);
  return `${value / ZATOSHIS_PER_ZEC}.${(value % ZATOSHIS_PER_ZEC).toString().padStart(8, "0")}`;
}

/** Caller supplies the applicable storage/accounting bound. No wraparound. */
export function checkedAdd(left: bigint, right: bigint, max: bigint): bigint {
  nonnegative(left);
  nonnegative(right);
  nonnegative(max);
  if (left > max || right > max || left > max - right) {
    throw new RangeError("Integer addition exceeds bound");
  }
  return left + right;
}

/** Use a suitably wide caller-supplied bound for stake * distributable-pool intermediates. */
export function checkedMultiply(
  left: bigint,
  right: bigint,
  max: bigint,
): bigint {
  nonnegative(left);
  nonnegative(right);
  nonnegative(max);
  if (left > max || right > max || (right !== 0n && left > max / right)) {
    throw new RangeError("Integer multiplication exceeds bound");
  }
  return left * right;
}

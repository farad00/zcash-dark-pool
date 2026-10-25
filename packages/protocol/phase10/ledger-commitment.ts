/** Approved DARKPOOL_LEDGER_V1_BIN1_B2B256. Pure, private protocol operations.
 * Acceptance/freeze, storage, historic publication, oracle and solvency remain
 * caller responsibilities. No wallet, database, logging or publication authority.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { LedgerRecord, LedgerCommitment } from "../src/domain.ts";
import type { AmountBounds } from "../src/money.ts";

export const LEDGER_PROFILE = "DARKPOOL_LEDGER_V1_BIN1_B2B256";
export const LEDGER_DOMAINS = Object.freeze({
  leaf: "DARKPOOL_LEDGER_LEAF_V1",
  node: "DARKPOOL_LEDGER_NODE_V1",
  empty: "DARKPOOL_LEDGER_EMPTY_V1",
  root: "DARKPOOL_LEDGER_ROOT_V1",
});
export interface LedgerContext {
  readonly profile: typeof LEDGER_PROFILE;
  readonly version: 1;
  readonly network: "testnet";
  readonly market_id: LedgerRecord["market_id"];
  readonly locked_at: LedgerCommitment["locked_at"];
}
/** Resource limits affect admission, never accepted encodings or financial rules. */
export interface LedgerLimits {
  readonly stake_bounds: AmountBounds;
  readonly max_tickets: bigint;
  readonly max_text_bytes: number;
  readonly max_amount_bytes: number;
  readonly max_ledger_bytes: number;
}
export type UnblindedLedgerRecord = Omit<LedgerRecord, "record_blinding">;
/** The ONLY public result. Count is a decimal string for lossless JSON transport. */
export interface PublicLedgerCommitment {
  readonly market_id: LedgerCommitment["market_id"];
  readonly ledger_version: 1;
  readonly accepted_ticket_count: string;
  readonly merkle_root: string;
  readonly locked_at: LedgerCommitment["locked_at"];
}

const encoder = new TextEncoder();
// ignoreBOM=true preserves a literal U+FEFF, rather than removing committed text.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const u64Max = (1n << 64n) - 1n;
const contextKeys = ["profile", "version", "network", "market_id", "locked_at"];
const recordKeys = [
  "version",
  "network",
  "market_id",
  "ticket_id",
  "side",
  "accepted_amount_zat",
  "accepted_payment_ref",
  "receiver_ref",
];
const publicKeys = [
  "market_id",
  "ledger_version",
  "accepted_ticket_count",
  "merkle_root",
  "locked_at",
];

function invalid(): never {
  throw new TypeError("Invalid ledger commitment input");
}
function exceeded(): never {
  throw new RangeError("Ledger commitment limit exceeded");
}

/** Closed, plain data objects only; do not invoke accessor properties. */
function exact(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== "object") invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid();
  }
}

function validateLimits(limits: LedgerLimits): void {
  exact(limits, [
    "stake_bounds",
    "max_tickets",
    "max_text_bytes",
    "max_amount_bytes",
    "max_ledger_bytes",
  ]);
  exact(limits.stake_bounds, ["min", "max"]);
  const { min, max } = limits.stake_bounds;
  if (
    typeof min !== "bigint" ||
    typeof max !== "bigint" ||
    min < 0n ||
    max < min
  )
    invalid();
  if (
    typeof limits.max_tickets !== "bigint" ||
    limits.max_tickets < 0n ||
    limits.max_tickets > u64Max
  )
    invalid();
  for (const size of [limits.max_text_bytes, limits.max_amount_bytes]) {
    if (!Number.isSafeInteger(size) || size < 1 || size > 0xffff_ffff)
      invalid();
  }
  if (
    !Number.isSafeInteger(limits.max_ledger_bytes) ||
    limits.max_ledger_bytes < 1
  )
    invalid();
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (!Number.isSafeInteger(length)) exceeded();
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint(value: bigint, width: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) exceeded();
  const result = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    result[i] = Number(value & 255n);
    value >>= 8n;
  }
  return result;
}

function frame(bytes: Uint8Array): Uint8Array {
  return concat(uint(BigInt(bytes.length), 4), bytes);
}

function text(value: string, limit: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    invalid();
  if (value.length > limit) exceeded();
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) invalid();
  }
  const bytes = encoder.encode(value);
  if (bytes.length > limit) exceeded();
  return frame(bytes);
}

function validateTimestamp(value: string): void {
  if (typeof value !== "string" || value.length !== 27) invalid();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
  if (!match) invalid();
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    invalid();
}

function contextBytes(
  context: LedgerContext,
  limits: LedgerLimits,
): Uint8Array {
  exact(context, contextKeys);
  if (
    context.profile !== LEDGER_PROFILE ||
    context.version !== 1 ||
    context.network !== "testnet"
  )
    invalid();
  validateTimestamp(context.locked_at);
  return concat(
    text(LEDGER_PROFILE, limits.max_text_bytes),
    uint(1n, 2),
    Uint8Array.of(1),
    text(context.market_id, limits.max_text_bytes),
  );
}

function checkBudget(length: number, limits: LedgerLimits): void {
  if (!Number.isSafeInteger(length) || length > limits.max_ledger_bytes)
    exceeded();
}

/** Canonical context bytes; contains only public context, not a private record. */
export function encodeLedgerContext(
  context: LedgerContext,
  limits: LedgerLimits,
): Uint8Array {
  validateLimits(limits);
  const bytes = contextBytes(context, limits);
  checkBudget(bytes.length, limits);
  return bytes;
}

function body(
  context: LedgerContext,
  record: UnblindedLedgerRecord,
  limits: LedgerLimits,
): Uint8Array {
  if (
    record.version !== 1 ||
    record.network !== "testnet" ||
    record.market_id !== context.market_id
  )
    invalid();
  if (
    typeof record.ticket_id !== "string" ||
    record.ticket_id.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(record.ticket_id)
  )
    invalid();
  if (record.side !== "YES" && record.side !== "NO") invalid();
  const amount = record.accepted_amount_zat;
  if (
    typeof amount !== "bigint" ||
    amount <= 0n ||
    amount < limits.stake_bounds.min ||
    amount > limits.stake_bounds.max
  )
    invalid();
  let hex = amount.toString(16);
  if (Math.ceil(hex.length / 2) > limits.max_amount_bytes) exceeded();
  if (hex.length % 2) hex = "0" + hex;
  const pieces = [
    contextBytes(context, limits),
    hexToBytes(record.ticket_id),
    Uint8Array.of(record.side === "YES" ? 1 : 2),
    frame(hexToBytes(hex)),
    text(record.accepted_payment_ref, limits.max_text_bytes),
    text(record.receiver_ref, limits.max_text_bytes),
  ];
  const length = pieces.reduce((sum, piece) => sum + piece.length, 32); // suffix blinding
  checkBudget(length, limits);
  return concat(...pieces);
}

function blinding(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) invalid();
  return new Uint8Array(value);
}

/** PRIVATE bytes B_i || blinding_i. Never publish, log or return through public APIs. */
export function encodePrivateLedgerRecord(
  context: LedgerContext,
  record: LedgerRecord,
  limits: LedgerLimits,
): Uint8Array {
  validateLimits(limits);
  exact(record, [...recordKeys, "record_blinding"]);
  return concat(
    body(context, record, limits),
    blinding(record.record_blinding),
  );
}

/** Strict inverse of private record encoding; rejects invalid UTF-8/nonminimal data. */
export function decodePrivateLedgerRecord(
  context: LedgerContext,
  bytes: Uint8Array,
  limits: LedgerLimits,
): LedgerRecord {
  validateLimits(limits);
  contextBytes(context, limits);
  if (!(bytes instanceof Uint8Array)) invalid();
  checkBudget(bytes.length, limits);
  const source = new Uint8Array(bytes);
  let offset = 0;
  function take(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > bytes.length - offset
    )
      invalid();
    const part = source.slice(offset, offset + length);
    offset += length;
    return part;
  }
  function framed(limit: number): Uint8Array {
    const count = new DataView(take(4).buffer).getUint32(0, false);
    if (count > limit) exceeded();
    return take(count);
  }
  function readText(): string {
    const encoded = framed(limits.max_text_bytes);
    let value: string;
    try {
      value = decoder.decode(encoded);
    } catch {
      invalid();
    }
    text(value, limits.max_text_bytes);
    return value;
  }
  if (
    readText() !== LEDGER_PROFILE ||
    bytesToHex(take(2)) !== "0001" ||
    take(1)[0] !== 1 ||
    readText() !== context.market_id
  )
    invalid();
  const ticket_id = bytesToHex(take(32)) as LedgerRecord["ticket_id"];
  const sideByte = take(1)[0];
  if (sideByte !== 1 && sideByte !== 2) invalid();
  const magnitude = framed(limits.max_amount_bytes);
  if (!magnitude.length || magnitude[0] === 0) invalid();
  const amount = BigInt("0x" + bytesToHex(magnitude));
  const record: LedgerRecord = {
    version: 1,
    network: "testnet",
    market_id: context.market_id,
    ticket_id,
    side: sideByte === 1 ? "YES" : "NO",
    accepted_amount_zat: amount,
    accepted_payment_ref: readText() as LedgerRecord["accepted_payment_ref"],
    receiver_ref: readText() as LedgerRecord["receiver_ref"],
    record_blinding: take(32),
  };
  if (offset !== bytes.length) invalid();
  encodePrivateLedgerRecord(context, record, limits);
  return Object.freeze(record);
}

function hash(label: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const state = blake2b.create({ dkLen: 32 });
  try {
    state.update(encoder.encode(label)).update(Uint8Array.of(0));
    for (const part of parts) state.update(part);
    return state.digest();
  } finally {
    state.destroy();
  }
}

export function hashPrivateLedgerLeaf(
  context: LedgerContext,
  record: LedgerRecord,
  limits: LedgerLimits,
): Uint8Array {
  return hash(
    LEDGER_DOMAINS.leaf,
    encodePrivateLedgerRecord(context, record, limits),
  );
}

function canonicalRecords(
  context: LedgerContext,
  records: readonly LedgerRecord[],
  limits: LedgerLimits,
): Uint8Array[] {
  validateLimits(limits);
  const ctx = contextBytes(context, limits);
  if (!Array.isArray(records)) invalid();
  if (BigInt(records.length) > limits.max_tickets) exceeded();
  const ids = new Set<string>(),
    blinds = new Set<string>();
  let budget =
    ctx.length + text(context.locked_at, limits.max_text_bytes).length + 8 + 32;
  checkBudget(budget, limits);
  const entries = Array.from(records, (record) => {
    const encoded = encodePrivateLedgerRecord(context, record, limits);
    const blind = bytesToHex(record.record_blinding);
    if (ids.has(record.ticket_id) || blinds.has(blind)) invalid();
    ids.add(record.ticket_id);
    blinds.add(blind);
    budget += encoded.length;
    checkBudget(budget, limits);
    return { ticket_id: record.ticket_id, encoded };
  });
  // Fixed-width lowercase hex comparison equals unsigned decoded-byte ordering.
  entries.sort((a, b) =>
    a.ticket_id < b.ticket_id ? -1 : a.ticket_id > b.ticket_id ? 1 : 0,
  );
  return entries.map((entry) => entry.encoded);
}

/** PRIVATE audit utility. No openings/proofs/public leaf publication are provided. */
export function computePrivateLedgerTreeHash(
  context: LedgerContext,
  records: readonly LedgerRecord[],
  limits: LedgerLimits,
): Uint8Array {
  const encoded = canonicalRecords(context, records, limits);
  const ctx = contextBytes(context, limits);
  let level: Uint8Array[] = encoded.map((bytes) =>
    hash(LEDGER_DOMAINS.leaf, bytes),
  );
  if (!level.length) return hash(LEDGER_DOMAINS.empty, ctx);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!,
        right = level[i + 1];
      next.push(
        right === undefined
          ? left
          : hash(LEDGER_DOMAINS.node, ctx, left, right),
      );
    }
    level = next;
  }
  return level[0]!;
}

/** Deterministic recomputation ONLY: never calls randomness, never persists. */
export function recomputeLedgerCommitment(
  context: LedgerContext,
  records: readonly LedgerRecord[],
  limits: LedgerLimits,
): PublicLedgerCommitment {
  const tree = computePrivateLedgerTreeHash(context, records, limits);
  const root = hash(
    LEDGER_DOMAINS.root,
    contextBytes(context, limits),
    uint(BigInt(records.length), 8),
    text(context.locked_at, limits.max_text_bytes),
    tree,
  );
  return Object.freeze({
    market_id: context.market_id,
    ledger_version: 1,
    accepted_ticket_count: BigInt(records.length).toString(),
    merkle_root: bytesToHex(root),
    locked_at: context.locked_at,
  });
}

/** False on malformed/missing private material or any historical-object mismatch. */
export function verifyLedgerCommitment(
  context: LedgerContext,
  records: readonly LedgerRecord[],
  expected: PublicLedgerCommitment,
  limits: LedgerLimits,
): boolean {
  try {
    exact(expected, publicKeys);
    if (
      expected.ledger_version !== 1 ||
      expected.market_id !== context.market_id ||
      expected.locked_at !== context.locked_at ||
      typeof expected.accepted_ticket_count !== "string" ||
      expected.accepted_ticket_count.length > 20 ||
      !/^(0|[1-9][0-9]*)$/.test(expected.accepted_ticket_count) ||
      BigInt(expected.accepted_ticket_count) > u64Max ||
      typeof expected.merkle_root !== "string" ||
      expected.merkle_root.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(expected.merkle_root)
    )
      return false;
    const actual = recomputeLedgerCommitment(context, records, limits);
    return (
      actual.accepted_ticket_count === expected.accepted_ticket_count &&
      actual.merkle_root === expected.merkle_root
    );
  } catch {
    return false;
  }
}

/** INITIAL FREEZE ONLY. PRIVATE result must be durably sealed before publication.
 * Refuses already/partially blinded input. Never use for retry or verification.
 * Mutable blinding buffers are owned copies, not magically immutable JS memory.
 */
export function createPrivateBlindedLedger(
  context: LedgerContext,
  records: readonly UnblindedLedgerRecord[],
  limits: LedgerLimits,
): readonly LedgerRecord[] {
  validateLimits(limits);
  const ctx = contextBytes(context, limits);
  if (!Array.isArray(records)) invalid();
  if (BigInt(records.length) > limits.max_tickets) exceeded();
  // Validate the complete unblinded ledger before requesting any entropy.
  let budget =
    ctx.length + text(context.locked_at, limits.max_text_bytes).length + 8 + 32;
  checkBudget(budget, limits);
  const ids = new Set<string>();
  const canonical = Array.from(records, (record) => {
    exact(record, recordKeys);
    const encodedBody = body(context, record, limits);
    if (ids.has(record.ticket_id)) invalid();
    ids.add(record.ticket_id);
    budget += encodedBody.length + 32;
    checkBudget(budget, limits);
    return { ...record };
  });
  canonical.sort((a, b) =>
    a.ticket_id < b.ticket_id ? -1 : a.ticket_id > b.ticket_id ? 1 : 0,
  );
  const generated: LedgerRecord[] = [];
  try {
    for (const record of canonical) {
      const bytes = new Uint8Array(32);
      generated.push(Object.freeze({ ...record, record_blinding: bytes }));
      globalThis.crypto.getRandomValues(bytes);
    }
    canonicalRecords(context, generated, limits); // Duplicate RNG outputs fail closed.
    return Object.freeze(generated);
  } catch {
    for (const record of generated) record.record_blinding.fill(0);
    throw new Error("Ledger blinding generation failed");
  }
}

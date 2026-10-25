/** Private, calculation-only. No persistence, lifecycle or spending authority. */
import type { Market, Resolution, LedgerRecord } from "../src/domain.ts";
import {
  decodePrivateLedgerRecord,
  encodePrivateLedgerRecord,
  encodeLedgerContext,
  verifyLedgerCommitment,
} from "../phase10/ledger-commitment.ts";
import type {
  LedgerContext,
  LedgerLimits,
  PublicLedgerCommitment,
} from "../phase10/ledger-commitment.ts";
import { calculateSubsidizedSettlement } from "../phase10/settlement.ts";
import type {
  SettlementPolicy,
  SettlementCalculation,
} from "../phase10/settlement.ts";

export type FrozenOracleRule = Readonly<
  Pick<
    Market,
    | "question"
    | "yes_definition"
    | "no_definition"
    | "resolution_rule"
    | "resolution_sources"
    | "void_conditions"
  > & { readonly rule_version: Resolution["rule_version"] }
>;
export interface LockedSnapshot {
  readonly status: "LOCKED";
  readonly revision: bigint;
  readonly frozen_at: LedgerContext["locked_at"];
  readonly safety_hold_ref: string | null;
  readonly context: LedgerContext;
  readonly records: readonly LedgerRecord[];
}
export interface PreparationRequest {
  readonly request_key: string;
  readonly expected_revision: bigint;
  readonly resolution: Resolution;
}
/** Trusted configuration, NEVER assembled from a public preparation request. */
export interface PreparationConfiguration {
  /** Historical Phase 11 seal from trusted immutable storage, not a new root. */
  readonly commitment: PublicLedgerCommitment;
  /** Pre-OPEN rule, ordered sources, observation point (in rule), void conditions. */
  readonly oracle_rule: FrozenOracleRule;
  readonly ledger_limits: LedgerLimits;
  readonly settlement_policy: SettlementPolicy;
  /** Required trusted manual review seam. No default oracle authority is supplied.
   * Must check existing actor authorization, objective proposition, observation
   * eligibility, source hierarchy and retained evidence. Must be deterministic,
   * synchronous, and not log sensitive inputs. Ambiguity permits only VOID.
   */
  readonly review_oracle: (
    rule: FrozenOracleRule,
    resolution: Resolution,
  ) => "DEFENSIBLE" | "AMBIGUOUS";
}
export interface SettlementPreparation {
  readonly kind: "PRIVATE_PREPARATION_ONLY";
  readonly lifecycle_authorized: false;
  readonly binding: {
    readonly request_key: string;
    readonly revision: bigint;
    readonly context: LedgerContext;
    readonly commitment: PublicLedgerCommitment;
    readonly oracle_rule: FrozenOracleRule;
    readonly resolution: Resolution;
    readonly policy: SettlementPolicy;
  };
  readonly calculation: SettlementCalculation;
}

function reject(code = "PREPARATION_INPUT_INVALID"): never {
  throw new TypeError(code);
}
function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object") reject();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) reject();
  const found = Reflect.ownKeys(value);
  if (
    found.length !== keys.length ||
    found.some((k) => typeof k !== "string" || !keys.includes(k))
  )
    reject();
  for (const k of keys)
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, "value"))
      reject();
}
/** Copies closed plain data without invoking getters or retaining caller objects. */
function copy<T>(value: T, depth = 0): T {
  if (depth > 8) reject();
  if (value === null || typeof value !== "object") {
    if (
      !["string", "bigint", "number", "boolean"].includes(typeof value) &&
      value !== null
    )
      reject();
    return value;
  }
  if (Array.isArray(value)) {
    const keys = Array.from({ length: value.length }, (_, i) => String(i));
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length + 1) reject();
    const rows = keys.map((k) => {
      const d = descriptors[k];
      if (!d || !("value" in d)) reject();
      return copy(d.value as unknown, depth + 1);
    });
    return Object.freeze(rows) as T;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== "string")) reject();
  exact(value, keys as string[]);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const k of keys as string[])
    result[k] = copy(
      Object.getOwnPropertyDescriptor(value, k)!.value as unknown,
      depth + 1,
    );
  return Object.freeze(result) as T;
}
function text(value: unknown, max: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > max
  )
    reject();
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) reject();
  }
}
function references(value: readonly string[], max: number): void {
  if (!Array.isArray(value) || value.length === 0) reject();
  for (const v of value) text(v, max);
  if (new Set(value).size !== value.length) reject();
}
/** Compare bounded expected output shape; getters/extra fields on saved data reject. */
function same(expected: unknown, saved: unknown): boolean {
  if (expected === null || typeof expected !== "object")
    return expected === saved;
  if (!saved || typeof saved !== "object") return false;
  const keys = Reflect.ownKeys(expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(saved) || expected.length !== saved.length) return false;
  } else if (Array.isArray(saved)) return false;
  const proto = Object.getPrototypeOf(saved);
  if (!Array.isArray(saved) && proto !== Object.prototype && proto !== null)
    return false;
  if (Reflect.ownKeys(saved).length !== keys.length) return false;
  return keys.every((k) => {
    const descriptor = Object.getOwnPropertyDescriptor(saved, k);
    return (
      descriptor &&
      "value" in descriptor &&
      same(
        Object.getOwnPropertyDescriptor(expected, k)!.value,
        descriptor.value,
      )
    );
  });
}

/** Pure with a deterministic trusted review adapter. Returned entitlements are
 * confidential previews, not SPEC §26 signed plans, claims or spendable outputs.
 * saved must be the caller's authoritative prior preparation, when one exists;
 * null is for a confirmed first preparation, never permission to replace history.
 */
export function prepareResolutionSettlement(
  snapshot: LockedSnapshot,
  request: PreparationRequest,
  configuration: PreparationConfiguration,
  saved: SettlementPreparation | null,
): SettlementPreparation {
  exact(snapshot, [
    "status",
    "revision",
    "frozen_at",
    "safety_hold_ref",
    "context",
    "records",
  ]);
  exact(request, ["request_key", "expected_revision", "resolution"]);
  exact(configuration, [
    "commitment",
    "oracle_rule",
    "ledger_limits",
    "settlement_policy",
    "review_oracle",
  ]);
  if (snapshot.status !== "LOCKED" || snapshot.safety_hold_ref !== null)
    reject("LOCKED_SNAPSHOT_REQUIRED");
  if (
    typeof snapshot.revision !== "bigint" ||
    snapshot.revision < 1n ||
    request.expected_revision !== snapshot.revision
  )
    reject("PREPARATION_REVISION_CONFLICT");
  if (
    typeof request.request_key !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.request_key)
  )
    reject();
  const revision = snapshot.revision,
    requestKey = request.request_key;
  if (typeof configuration.review_oracle !== "function")
    reject("ORACLE_REVIEW_REQUIRED");
  const context = copy(snapshot.context),
    commitment = copy(configuration.commitment),
    rule = copy(configuration.oracle_rule),
    resolution = copy(request.resolution),
    policy = copy(configuration.settlement_policy),
    limits = copy(configuration.ledger_limits);
  exact(policy, [
    "fee_mode",
    "stake_bounds",
    "max_total_zat",
    "max_numerator_zat_squared",
  ]);
  exact(policy.stake_bounds, ["min", "max"]);
  calculateSubsidizedSettlement([], "VOID", policy); // Validate even empty books.
  encodeLedgerContext(context, limits); // Validate original Phase 10 context/limits.
  if (
    limits.stake_bounds.min !== policy.stake_bounds.min ||
    limits.stake_bounds.max !== policy.stake_bounds.max
  )
    reject("FROZEN_BOUNDS_MISMATCH");
  if (snapshot.frozen_at !== context.locked_at)
    reject("LOCKED_SNAPSHOT_REQUIRED");
  if (
    !Array.isArray(snapshot.records) ||
    BigInt(snapshot.records.length) > limits.max_tickets
  )
    reject();
  // Own all private bytes before review; neither inputs nor blinds escape below.
  const records = Array.from(snapshot.records, (r) =>
    decodePrivateLedgerRecord(
      context,
      encodePrivateLedgerRecord(context, r, limits),
      limits,
    ),
  );
  if (!verifyLedgerCommitment(context, records, commitment, limits))
    reject("LOCKED_ROOT_VERIFICATION_FAILED");
  exact(rule, [
    "question",
    "yes_definition",
    "no_definition",
    "resolution_rule",
    "resolution_sources",
    "void_conditions",
    "rule_version",
  ]);
  for (const v of [
    rule.question,
    rule.yes_definition,
    rule.no_definition,
    rule.resolution_rule,
    rule.rule_version,
  ])
    text(v, limits.max_text_bytes);
  references(rule.resolution_sources, limits.max_text_bytes);
  references(rule.void_conditions, limits.max_text_bytes);
  exact(resolution, [
    "version",
    "network",
    "market_id",
    "outcome",
    "resolved_at",
    "evidence",
    "rule_version",
    "actor",
  ]);
  if (
    resolution.version !== 1 ||
    resolution.network !== "testnet" ||
    resolution.market_id !== context.market_id ||
    resolution.rule_version !== rule.rule_version ||
    !["YES", "NO", "VOID"].includes(resolution.outcome)
  )
    reject("ORACLE_BINDING_INVALID");
  text(resolution.actor, limits.max_text_bytes);
  references(resolution.evidence, limits.max_text_bytes);
  // Internal PostgreSQL projection uses the existing UTC-microsecond form.
  encodeLedgerContext(
    { ...context, locked_at: resolution.resolved_at },
    limits,
  );
  if (resolution.resolved_at < context.locked_at)
    reject("PREMATURE_RESOLUTION");
  let review: unknown;
  try {
    review = configuration.review_oracle(rule, resolution);
  } catch {
    reject("ORACLE_REVIEW_REJECTED");
  }
  if (
    review !== "DEFENSIBLE" &&
    !(review === "AMBIGUOUS" && resolution.outcome === "VOID")
  )
    reject("ORACLE_REVIEW_REJECTED");
  const calculation = calculateSubsidizedSettlement(
    records,
    resolution.outcome,
    policy,
  );
  const result: SettlementPreparation = Object.freeze({
    kind: "PRIVATE_PREPARATION_ONLY",
    lifecycle_authorized: false,
    binding: Object.freeze({
      request_key: requestKey,
      revision,
      context,
      commitment,
      oracle_rule: rule,
      resolution,
      policy,
    }),
    calculation,
  });
  if (saved !== null && !same(result, saved))
    reject("PREPARATION_RETRY_CONFLICT");
  return result;
}

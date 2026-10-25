import { createHash } from "node:crypto";

export const PROFILE = "DARKPOOL_PUBLICATION_GIT_WITNESS_RFC3161_V1";
export const DOMAIN = Buffer.from("DARKPOOL_PUBLICATION_WITNESS_V1\0", "ascii");
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const reject = () => {
  throw new Error("PUBLICATION_REJECTED");
};

// RFC 8785 subset: objects, arrays, strings and safe integers only. No coercion,
// lone surrogates, accessors, prototypes with behavior or unknown transport keys.
export function canonical(value) {
  if (typeof value === "string") {
    if (!value.isWellFormed()) reject();
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    reject();
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => {
        if (
          !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")
        )
          reject();
        return canonical(key) + ":" + canonical(value[key]);
      })
      .join(",") +
    "}"
  );
}
export function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    reject();
  canonical(value);
}
export function hex(value, size) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value)
  )
    reject();
  return value;
}
export function utc(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString().slice(0, 19) !==
      value.slice(0, 19)
  )
    reject();
  return Date.parse(value);
}
export function envelopeBytes(envelope) {
  exact(envelope, [
    "accepted_ticket_count",
    "ledger_version",
    "locked_at",
    "market_id",
    "merkle_root",
  ]);
  if (
    envelope.ledger_version !== 1 ||
    typeof envelope.market_id !== "string" ||
    !envelope.market_id.length ||
    Buffer.byteLength(envelope.market_id) > 8192 ||
    typeof envelope.accepted_ticket_count !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(envelope.accepted_ticket_count) ||
    BigInt(envelope.accepted_ticket_count) > (1n << 64n) - 1n
  )
    reject();
  hex(envelope.merkle_root, 32);
  utc(envelope.locked_at);
  return Buffer.from(canonical(envelope), "utf8");
}
export function decode64(value, limit = 262144) {
  if (typeof value !== "string" || value.length > limit * 2 || !value.length)
    reject();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== value) reject();
  return bytes;
}

// Trust is provisioned internally, never accepted as part of an HTTP receipt.
// A null/missing trust configuration is an explicit unavailable capability.
export function trustProfile(trust) {
  if (!trust || trust.status !== "READY")
    throw new Error("PUBLICATION_UNAVAILABLE");
  exact(trust, [
    "status",
    "policy_ref",
    "evidence_class",
    "repository",
    "path",
    "archive_origin",
    "witness_spki",
    "ca_bundle",
    "tsa_policy_oid",
    "max_clock_skew_seconds",
    "max_witness_lag_seconds",
    "tsa_verification",
  ]);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(trust.policy_ref) ||
    !["EXTERNAL", "SYNTHETIC_TEST"].includes(trust.evidence_class) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      trust.repository,
    ) ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(trust.path) ||
    trust.path.split("/").some((x) => x === "." || x === "..") ||
    !/^https:\/\/[A-Za-z0-9.-]+$/.test(trust.archive_origin) ||
    !/^\d+(?:\.\d+)+$/.test(trust.tsa_policy_oid) ||
    !Number.isSafeInteger(trust.max_clock_skew_seconds) ||
    trust.max_clock_skew_seconds < 0 ||
    trust.max_clock_skew_seconds > 3600 ||
    !Number.isSafeInteger(trust.max_witness_lag_seconds) ||
    trust.max_witness_lag_seconds < 0 ||
    trust.max_witness_lag_seconds > 86400
  )
    reject();
  decode64(trust.witness_spki, 1024);
  if (!trust.tsa_verification || typeof trust.tsa_verification !== "object")
    reject();
  if (
    typeof trust.ca_bundle !== "string" ||
    trust.ca_bundle.length > 131072 ||
    !trust.ca_bundle.includes("-----BEGIN X509 CRL-----") ||
    !trust.ca_bundle.includes("-----BEGIN CERTIFICATE-----")
  )
    reject();
  return JSON.parse(canonical(trust));
}

// Inspection of bounded, definite DER only. Signature/type/nonce/imprint and all
// remaining RFC3161 semantics are verified by OpenSSL, not by this parser.
import { reject } from "./profile.mjs";
export function numericOid(value) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^(0|1|2)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))*$/.test(value)
  )
    reject();
  const a = value.split(".");
  if (a[0] !== "2" && BigInt(a[1]) > 39n) reject();
  return value;
}
export function signedPolicyOid(input) {
  if (!Buffer.isBuffer(input) || input.length > 65536) reject();
  const bytes = Buffer.from(input);
  function item(start, limit) {
    let p = start;
    if (p + 2 > limit) reject();
    const tag = bytes[p++];
    let size = bytes[p++];
    if (size & 128) {
      const width = size & 127;
      if (!width || width > 3 || p + width > limit || !bytes[p]) reject();
      size = 0;
      for (let i = 0; i < width; i++) size = size * 256 + bytes[p++];
      if (size < 128) reject();
    }
    if (p + size > limit) reject();
    return { tag, start: p, end: p + size };
  }
  const root = item(0, bytes.length);
  if (root.tag !== 48 || root.end !== bytes.length) reject();
  const version = item(root.start, root.end);
  if (
    version.tag !== 2 ||
    version.end - version.start !== 1 ||
    bytes[version.start] !== 1
  )
    reject();
  const oid = item(version.end, root.end);
  if (oid.tag !== 6 || oid.end === oid.start || oid.end - oid.start > 128)
    reject();
  // Reject truncated/trailing TLVs even though OpenSSL owns TSTInfo semantics.
  for (let p = oid.end; p < root.end;) {
    const field = item(p, root.end);
    if (!field.tag || (field.tag & 31) === 31) reject();
    p = field.end;
  }
  const arcs = [];
  let value = 0n,
    first = true;
  for (const b of bytes.subarray(oid.start, oid.end)) {
    if (first && b === 128) reject();
    value = (value << 7n) | BigInt(b & 127);
    first = !(b & 128);
    if (first) {
      arcs.push(value);
      value = 0n;
    }
  }
  if (!first) reject();
  const combined = arcs.shift();
  const head = combined < 40n ? 0n : combined < 80n ? 1n : 2n;
  return numericOid([head, combined - head * 40n, ...arcs].join("."));
}

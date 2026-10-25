// Approved portable V1 credential. This module has no storage or network access.
import { deriveClaimCommitment } from "./claim-commitment.js";

export const BACKUP_MAX_BYTES = 64 * 1024;
export const BACKUP_PROFILE = "DARKPOOL_CLAIM_V1_ID_FRAME_1";
const keys = [
  "format",
  "backup_version",
  "version",
  "network",
  "claim_commitment_profile",
  "market_id",
  "ticket_id",
  "claim_secret_hex",
  "claim_commitment",
];
const fail = () => {
  throw new Error("INVALID_TICKET_BACKUP");
};
const hex = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const bytesHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function validateBackupIdentity(value) {
  if (
    value.version !== 1 ||
    value.network !== "testnet" ||
    typeof value.market_id !== "string" ||
    !value.market_id.length ||
    !value.market_id.isWellFormed() ||
    value.market_id.includes("\0") ||
    new TextEncoder().encode(value.market_id).length > 8192 ||
    !hex(value.ticket_id)
  )
    fail();
}

export function encodeTicketBackup(credential) {
  validateBackupIdentity(credential);
  if (
    !(credential.claim_secret instanceof Uint8Array) ||
    credential.claim_secret.length !== 32
  )
    fail();
  return (
    JSON.stringify(
      {
        format: "darkpool-ticket-backup",
        backup_version: 1,
        version: 1,
        network: "testnet",
        claim_commitment_profile: BACKUP_PROFILE,
        market_id: credential.market_id,
        ticket_id: credential.ticket_id,
        claim_secret_hex: bytesHex(credential.claim_secret),
        claim_commitment: deriveClaimCommitment(credential),
      },
      null,
      2,
    ) + "\n"
  );
}

// The approved schema is flat and primitive-only. Parse that grammar directly so
// duplicate decoded property names cannot disappear through JSON.parse.
function parseObject(text) {
  let cursor = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(text[cursor] ?? "x")) cursor++;
  };
  const string =
    /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const token = (regex) => {
    regex.lastIndex = cursor;
    const match = regex.exec(text);
    if (!match) fail();
    cursor = regex.lastIndex;
    return JSON.parse(match[0]);
  };
  const result = Object.create(null);
  ws();
  if (text[cursor++] !== "{") fail();
  ws();
  if (text[cursor] !== "}") {
    for (;;) {
      const key = token(string);
      if (Object.hasOwn(result, key)) fail();
      ws();
      if (text[cursor++] !== ":") fail();
      ws();
      result[key] = token(text[cursor] === '"' ? string : number);
      ws();
      if (text[cursor] === "}") break;
      if (text[cursor++] !== ",") fail();
      ws();
    }
  }
  cursor++;
  ws();
  if (cursor !== text.length) fail();
  return result;
}

export function decodeTicketBackup(bytes) {
  let secret;
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > BACKUP_MAX_BYTES)
      fail();
    const value = parseObject(
      new globalThis.TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    );
    if (
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      value.format !== "darkpool-ticket-backup" ||
      value.backup_version !== 1 ||
      value.claim_commitment_profile !== BACKUP_PROFILE ||
      !hex(value.claim_secret_hex) ||
      !hex(value.claim_commitment)
    )
      fail();
    validateBackupIdentity(value);
    secret = Uint8Array.from(value.claim_secret_hex.match(/../g), (byte) =>
      Number.parseInt(byte, 16),
    );
    const credential = {
      version: 1,
      network: "testnet",
      market_id: value.market_id,
      ticket_id: value.ticket_id,
      claim_secret: secret,
    };
    if (deriveClaimCommitment(credential) !== value.claim_commitment) fail();
    return credential;
  } catch {
    secret?.fill(0);
    fail(); // Never propagate parser diagnostics, input excerpts or secret material.
  }
}

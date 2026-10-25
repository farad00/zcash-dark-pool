import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  createPrivateBlindedLedger,
  recomputeLedgerCommitment,
  verifyLedgerCommitment,
} from "../../packages/protocol/phase10/ledger-commitment.ts";
import type {
  LedgerContext,
  LedgerLimits,
  PublicLedgerCommitment,
  UnblindedLedgerRecord,
} from "../../packages/protocol/phase10/ledger-commitment.ts";
import type { LedgerRecord } from "../../packages/protocol/src/domain.ts";
import { openLockSession } from "./db-session.mjs";
import type { LockSession } from "./db-session.mjs";

export type LockResources = Omit<LedgerLimits, "stake_bounds">;
interface Snapshot {
  result: "READY" | "SEALED";
  context: LedgerContext;
  records: Record<string, unknown>[];
  min_stake_zat: string;
  max_stake_zat: string;
  response?: {
    result: "LOCKED";
    commitment: PublicLedgerCommitment;
    publication: "PENDING";
    revision: string;
  };
}

function reject(): never {
  throw new Error("LOCK_SNAPSHOT_INVALID");
}
function integer(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    reject();
  return BigInt(value);
}
function snapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") reject();
  const data = value as Snapshot;
  if (
    (data.result !== "READY" && data.result !== "SEALED") ||
    !Array.isArray(data.records) ||
    !data.context
  )
    reject();
  return data;
}
function privateRecords(data: Snapshot): LedgerRecord[] {
  return data.records.map((row) => {
    if (
      typeof row.record_blinding !== "string" ||
      row.record_blinding.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(row.record_blinding)
    )
      reject();
    return {
      ...row,
      accepted_amount_zat: integer(row.accepted_amount_zat),
      record_blinding: hexToBytes(row.record_blinding),
    } as unknown as LedgerRecord;
  });
}
function limits(data: Snapshot, resources: LockResources): LedgerLimits {
  return {
    ...resources,
    stake_bounds: {
      min: integer(data.min_stake_zat),
      max: integer(data.max_stake_zat),
    },
  };
}
/** Hex transports private JSON through stdin only; never argv or ordinary logs. */
function json(value: unknown): string {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  if (raw.length > 4 * 1024 * 1024) throw new Error("LOCK_INPUT_LIMIT");
  return `convert_from(decode('${bytesToHex(raw)}','hex'),'UTF8')::jsonb`;
}
function verified(data: Snapshot, configured: LedgerLimits) {
  const records = privateRecords(data),
    response = data.response;
  if (
    !response ||
    response.result !== "LOCKED" ||
    response.publication !== "PENDING" ||
    typeof response.revision !== "string" ||
    !/^[1-9][0-9]*$/.test(response.revision) ||
    !verifyLedgerCommitment(
      data.context,
      records,
      response.commitment,
      configured,
    )
  )
    reject();
  return Object.freeze({
    result: "LOCKED" as const,
    commitment: recomputeLedgerCommitment(data.context, records, configured),
    publication: "PENDING" as const,
    revision: response.revision,
  });
}

/** Trusted coordinator boundary. Caller owns session close/rollback on any error. */
export async function finalizeInSession(
  session: LockSession,
  request: unknown,
  resources: LockResources,
) {
  const started = await session.query(`BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL TIME ZONE 'UTC'; SET LOCAL synchronous_commit=on;
SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s';
SELECT jsonb_build_object('authorized',current_user=session_user);`);
  if (
    !started ||
    typeof started !== "object" ||
    (started as { authorized?: unknown }).authorized !== true
  )
    throw new Error("LOCK_AUTHORIZATION_FAILED");
  const data = snapshot(
    await session.query(`SELECT darkpool_lock.begin_lock(${json(request)});`),
  );
  const configured = limits(data, resources);
  let result;
  if (data.result === "SEALED") result = verified(data, configured);
  else {
    const records = data.records.map((row) => ({
      ...row,
      accepted_amount_zat: integer(row.accepted_amount_zat),
    })) as unknown as UnblindedLedgerRecord[];
    const blinded = createPrivateBlindedLedger(
      data.context,
      records,
      configured,
    );
    const commitment = recomputeLedgerCommitment(
      data.context,
      blinded,
      configured,
    );
    const wire = blinded.map((row) => ({
      ...row,
      accepted_amount_zat: row.accepted_amount_zat.toString(),
      record_blinding: bytesToHex(row.record_blinding),
    }));
    const sealed = snapshot(
      await session.query(
        `SELECT darkpool_lock.finish_lock(${json(request)},${json(wire)},${json(commitment)});`,
      ),
    );
    if (JSON.stringify(sealed.context) !== JSON.stringify(data.context))
      reject();
    result = verified(sealed, configured);
    if (result.commitment.merkle_root !== commitment.merkle_root) reject();
  }
  const acknowledgement = await session.query(
    `COMMIT; SELECT jsonb_build_object('committed',true);`,
  );
  if (
    !acknowledgement ||
    typeof acknowledgement !== "object" ||
    (acknowledgement as { committed?: unknown }).committed !== true
  )
    throw new Error("LOCK_COMMIT_UNCONFIRMED");
  return result;
}

/** TEST-only executable service API. No automatic retry after an unknown commit. */
export async function finalizeLock(
  request: unknown,
  resources: LockResources,
  env: Record<string, string | undefined>,
) {
  const session = await openLockSession(env);
  try {
    return await finalizeInSession(session, request, resources);
  } finally {
    await session.close();
  } // Disconnect rolls back an uncommitted attempt.
}

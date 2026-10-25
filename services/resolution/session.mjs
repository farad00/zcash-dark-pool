import { openLockSession } from "../lock/db-session.mjs";
// Internal JSON storage comparison, NOT a ledger/claim/publication encoding.
export function canonicalData(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string" && value.isWellFormed())
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalData).join(",") + "]";
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("RESOLUTION_INPUT_REJECTED");
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => canonicalData(key) + ":" + canonicalData(value[key]))
      .join(",") +
    "}"
  );
}
export const wire = (v) =>
  JSON.parse(
    JSON.stringify(v, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
export const json = (v) => {
  const raw = canonicalData(wire(v));
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
    throw new Error("RESOLUTION_INPUT_LIMIT");
  return `convert_from(decode('${Buffer.from(raw).toString("hex")}','hex'),'UTF8')::jsonb`;
};
export const begin = `BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL TIME ZONE 'UTC'; SET LOCAL synchronous_commit=on;
SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SELECT '{}'::jsonb;`;
export async function commit(session) {
  if (
    (
      await session.query(
        "COMMIT; SELECT jsonb_build_object('committed',true);",
      )
    )?.committed !== true
  )
    throw new Error("RESOLUTION_COMMIT_UNCONFIRMED");
}
export async function withResolutionSession(env, work) {
  const session = await openLockSession(env); // Existing physical TEST fence, no LIVE transport.
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

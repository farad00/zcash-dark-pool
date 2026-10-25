import { openLockSession } from "../lock/db-session.mjs";
export {
  begin,
  commit,
  json,
  wire,
  canonicalData,
} from "../resolution/session.mjs";
export async function withPayoutSession(env, work) {
  const session = await openLockSession(env); // Existing physical TEST fence only.
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}
export function sqlText(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    !value.isWellFormed() ||
    value.includes("\0")
  )
    throw new Error("PAYOUT_PLAN_REJECTED");
  return `convert_from(decode('${Buffer.from(value).toString("hex")}','hex'),'UTF8')`;
}

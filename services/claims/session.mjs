import { openLockSession } from "../lock/db-session.mjs";
export {
  begin,
  commit,
  json,
  wire,
  canonicalData,
} from "../resolution/session.mjs";
export async function withClaimSession(env, work) {
  // Same physical TEST control-file/cluster fence, not the finalizer's grants.
  const session = await openLockSession(env);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

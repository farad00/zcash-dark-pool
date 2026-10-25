import { begin, commit, json, withResolutionSession } from "./session.mjs";
// Internal authenticated oracle entrypoint. A caller-provided actor string or
// preparation boolean is never identity; PostgreSQL session_user is the actor.
export async function approveResolution(request, env) {
  return withResolutionSession(env, async (session) => {
    await session.query(begin);
    const result = await session.query(
      `SELECT darkpool_resolution.approve(${json(request)});`,
    );
    await commit(session);
    return result;
  });
}

import { openLockSession } from "../lock/db-session.mjs";
import { PROFILE, canonical, reject } from "./profile.mjs";
import { verifyPublication } from "./verify.mjs";

const json = (value) =>
  `convert_from(decode('${Buffer.from(canonical(value)).toString("hex")}','hex'),'UTF8')::jsonb`;

/** Trusted internal verifier service. Verification completes outside database
 * locks; persistence then rechecks exact immutable outbox and policy bindings. */
export async function persistPublication(
  marketId,
  evidence,
  trust,
  executable,
  env,
  retrieve,
  runtimeEvidence = {},
) {
  if (
    typeof marketId !== "string" ||
    !marketId.length ||
    marketId.length > 8192
  )
    reject();
  // Reuses the existing physical TEST target guard, not the finalizer's grants.
  const session = await openLockSession(env);
  let envelope;
  try {
    envelope = await session.query(
      `SELECT darkpool_publication.outbox(convert_from(decode('${Buffer.from(marketId).toString("hex")}','hex'),'UTF8'));`,
    );
  } finally {
    await session.close();
  }
  if (!envelope) reject();
  const verified = await verifyPublication(
    envelope,
    evidence,
    trust,
    executable,
    retrieve,
    Date.now(),
    runtimeEvidence,
  );
  const writer = await openLockSession(env);
  try {
    return await persistVerifiedInSession(writer, verified);
  } finally {
    await writer.close();
  }
}

// Internal capability boundary: ONLY the separately credentialed verifier owns
// this session. Never route this function or its JSON to a public/admin endpoint.
export async function persistVerifiedInSession(session, verified) {
  await session.query(`BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL TIME ZONE 'UTC'; SET LOCAL synchronous_commit=on;
SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s';
SELECT jsonb_build_object('started',true);`);
  const result = await session.query(
    `SELECT darkpool_publication.persist(${json({ ...verified, profile: PROFILE })});`,
  );
  const committed = await session.query(
    `COMMIT; SELECT jsonb_build_object('committed',true);`,
  );
  if (committed?.committed !== true)
    throw new Error("PUBLICATION_COMMIT_UNCONFIRMED");
  return result;
}

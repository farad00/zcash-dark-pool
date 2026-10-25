// Internal, single-purpose TEST transport. This module grants no capability.
import { fileURLToPath } from "node:url";
import { loadEnvironmentGuard } from "../../db/environment.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { finalizeLock } from "../lock/finalize.mts";
import { persistPublication } from "../publication/persist.mjs";
import { trustProfile } from "../publication/profile.mjs";
import { approveResolution } from "../resolution/approve.mjs";
import { finalizeResolution } from "../resolution/prepare.mjs";
import {
  reserveDurableClaim,
  prepareDurablePayout,
} from "../claims/reserve.mjs";
import { planPayoutIntent } from "../payout/plan.mjs";

export const MAX_COMMAND_BYTES = 1024 * 1024;
export const commands = Object.freeze({
  admin: Object.freeze(["create", "edit", "validate", "inspect", "open"]),
  lock: Object.freeze(["finalize-lock"]),
  publication: Object.freeze(["verify-publication"]),
  oracle: Object.freeze(["approve-resolution"]),
  settlement: Object.freeze(["finalize-resolution"]),
  claim: Object.freeze(["reserve-claim", "prepare-payout"]),
  planner: Object.freeze(["plan-payout"]),
});
const deny = () => {
  throw new Error("OPERATIONS_REJECTED");
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    deny();
};
export function parseOperationsCommand(text, purpose) {
  if (
    !Object.hasOwn(commands, purpose) ||
    typeof text !== "string" ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > MAX_COMMAND_BYTES
  )
    deny();
  let command;
  try {
    command = JSON.parse(text);
  } catch {
    deny();
  }
  exact(command, ["operation", "request"]);
  if (!commands[purpose].includes(command.operation)) deny();
  if (
    !command.request ||
    typeof command.request !== "object" ||
    Array.isArray(command.request)
  )
    deny();
  return command;
}
export function assertOperationsEnvironment(env, purpose) {
  if (
    !Object.hasOwn(commands, purpose) ||
    env.DARKPOOL_OPERATIONS_INTERNAL !== "1" ||
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.DARKPOOL_PG_ENV !== "TEST" ||
    env.DARKPOOL_TEST_ONLY !== "TEST_ONLY" ||
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "55433" ||
    !/^darkpool_phase9_[a-f0-9]{16}$/.test(env.PGDATABASE ?? "") ||
    !/^darkpool_[a-z0-9_]+_[a-f0-9]{16}$/.test(env.PGUSER ?? "") ||
    (!env.PGPASSWORD && !env.PGPASSFILE) ||
    !env.DARKPOOL_PG_PROFILE ||
    env.DARKPOOL_LIVE_INSTANCE !== undefined ||
    env.WALLET_DB_PATH !== undefined ||
    env.DATABASE_URL ||
    env.PGOPTIONS ||
    env.PGSERVICE ||
    env.PGSERVICEFILE ||
    env.PGHOSTADDR
  )
    deny();
}
function resources(value) {
  exact(value, [
    "max_tickets",
    "max_text_bytes",
    "max_amount_bytes",
    "max_ledger_bytes",
  ]);
  if (typeof value.max_tickets !== "bigint" || value.max_tickets < 1n) deny();
  for (const key of ["max_text_bytes", "max_amount_bytes", "max_ledger_bytes"])
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) deny();
  return Object.freeze({ ...value });
}
export function lockResourcesFromEnvironment(env) {
  const names = {
    max_tickets: "DARKPOOL_LOCK_MAX_TICKETS",
    max_text_bytes: "DARKPOOL_LOCK_MAX_TEXT_BYTES",
    max_amount_bytes: "DARKPOOL_LOCK_MAX_AMOUNT_BYTES",
    max_ledger_bytes: "DARKPOOL_LOCK_MAX_LEDGER_BYTES",
  };
  if (Object.values(names).every((k) => env[k] === undefined)) return undefined;
  const value = {};
  for (const [key, name] of Object.entries(names)) {
    if (!/^[1-9][0-9]{0,19}$/.test(env[name] ?? "")) deny();
    value[key] = key === "max_tickets" ? BigInt(env[name]) : Number(env[name]);
  }
  return resources(value);
}
const project = (value, keys) =>
  Object.freeze(
    Object.fromEntries(
      keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]),
    ),
  );
const unfinished = () =>
  Object.freeze({
    result: "UNCONFIRMED",
    code: "OPERATION_NOT_CONFIRMED",
    recovery: "RECONCILE_SAME_REQUEST",
  });
const rejected = () =>
  Object.freeze({ result: "REJECTED", code: "INVALID_OPERATION_OR_REQUEST" });

/** Trusted startup configuration only, NEVER fields from the command packet.
 * One retained login and purpose; no role switching, owner fallback or retries.
 * The publication callback is supplied by the dedicated verifier integration.
 * The CLI has no such callback and therefore explicitly blocks that operation.
 */
export async function createOperationsAdapter({
  purpose,
  env,
  lockResources,
  publication,
}) {
  env = { ...env };
  assertOperationsEnvironment(env, purpose);
  const connection = {};
  for (const key of [
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "DARKPOOL_PG_ENV",
    "DARKPOOL_PG_PROFILE",
    "DARKPOOL_TEST_ONLY",
  ])
    if (env[key] !== undefined) connection[key] = env[key];
  Object.assign(connection, {
    APP_ENV: "development",
    ZCASH_NETWORK: "testnet",
    PSQL_PATH: fileURLToPath(
      new URL("../../.tools/pgsql/bin/psql.exe", import.meta.url),
    ),
    ...(purpose === "admin"
      ? { DARKPOOL_ADMIN_INTERNAL: "1" }
      : { DARKPOOL_LOCK_INTERNAL: "1" }),
  });
  // The existing local control-file/profile/marker guard is repeated by services.
  await loadEnvironmentGuard(connection, { requireKind: "TEST" });
  Object.freeze(connection);
  const limits =
    lockResources === undefined ? undefined : resources(lockResources);
  const verifier =
    publication === undefined
      ? undefined
      : Object.freeze({
          trust: trustProfile(publication.trust),
          executable: publication.executable,
          retrieve: publication.retrieve,
        });
  return async (text) => {
    let command;
    try {
      command = parseOperationsCommand(text, purpose);
    } catch {
      return rejected();
    }
    const { operation, request } = command;
    let secret;
    try {
      if (purpose === "admin") {
        // Reuse the exact existing admin transport and runtime privilege check.
        const result = await runBounded(
          process.execPath,
          [
            fileURLToPath(
              new URL("../../apps/web/src/admin-cli.mjs", import.meta.url),
            ),
          ],
          {
            timeoutMs: 15000,
            env: connection,
            input: JSON.stringify(command),
            maxBytes: 131072,
          },
        );
        if (
          result.stderr ||
          ![0, 1].includes(boundedExit(result)) ||
          result.timedOut ||
          result.spawnFailed
        )
          return unfinished();
        const response = JSON.parse(result.stdout);
        if (
          !["APPLIED", "VALID", "INSPECTED", "REJECTED", "BLOCKED"].includes(
            response.result,
          )
        ) {
          // Inspect/validate have established response shapes; no opaque projection.
          if (!response.control && !response.validation) return unfinished();
        }
        return response;
      }
      if (purpose === "lock") {
        if (!limits)
          return { result: "BLOCKED", code: "LOCK_RESOURCES_UNAVAILABLE" };
        const result = await finalizeLock(request, limits, connection);
        return project(result, [
          "result",
          "commitment",
          "publication",
          "revision",
        ]);
      }
      if (purpose === "publication") {
        exact(request, ["market_id", "evidence"]);
        if (!verifier || typeof verifier.retrieve !== "function")
          return {
            result: "BLOCKED",
            code: "PUBLICATION_VERIFIER_UNAVAILABLE",
          };
        const result = await persistPublication(
          request.market_id,
          request.evidence,
          verifier.trust,
          verifier.executable,
          connection,
          verifier.retrieve,
        );
        return project(result, [
          "receipt_id",
          "market_id",
          "merkle_root",
          "content_sha256",
          "policy_ref",
          "evidence_class",
          "publication",
          "timestamp_at",
          "recorded_at",
        ]);
      }
      if (purpose === "oracle")
        return project(await approveResolution(request, connection), [
          "result",
          "request_key",
          "execution_class",
        ]);
      if (purpose === "settlement") {
        exact(request, ["request_key"]);
        return project(
          await finalizeResolution(request.request_key, connection),
          [
            "result",
            "market_id",
            "resolution_id",
            "merkle_root",
            "outcome",
            "recorded_state",
            "revision",
            "execution_class",
            "spending_authorized",
          ],
        );
      }
      if (purpose === "claim") {
        exact(request, [
          "market_id",
          "ticket_id",
          "claim_secret",
          "payout_ua",
          "idempotency_key",
        ]);
        if (
          typeof request.claim_secret !== "string" ||
          !/^[0-9a-f]{64}$/.test(request.claim_secret)
        )
          deny();
        // Wire representation of the ORIGINAL 32-byte credential, not a new profile.
        secret = new Uint8Array(Buffer.from(request.claim_secret, "hex"));
        const input = { ...request, claim_secret: secret };
        const result =
          operation === "reserve-claim"
            ? await reserveDurableClaim(input, connection)
            : await prepareDurablePayout(input, connection);
        return project(result, [
          "result",
          "reservation_id",
          "state",
          "revision",
          "execution_class",
          "spending_authorized",
        ]);
      }
      exact(request, ["claim_id"]);
      return project(await planPayoutIntent(request.claim_id, connection), [
        "result",
        "intent_id",
        "planning_state",
        "execution_class",
        "spending_authorized",
        "submission_enabled",
      ]);
    } catch {
      // An exception/lost acknowledgement is not proof the transaction rolled back.
      // Never echo request/secret/SQL diagnostics or automatically choose a new key.
      return unfinished();
    } finally {
      secret?.fill(0);
    }
  };
}

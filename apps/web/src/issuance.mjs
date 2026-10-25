import { randomBytes, createHash } from "node:crypto";
import { connect } from "node:net";
import { issuanceQuery, sqlText } from "../../../db/issuance-runtime.mjs";
import { assertLiveComponent } from "../../../db/target-registry.mjs";

const hex = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k))
  );
}
export function parseIssuance(value) {
  const fields =
    value?.operation === "reserve"
      ? [
          "operation",
          "issuance_token",
          "market_id",
          "side",
          "requested_amount_zat",
        ]
      : [
          "operation",
          "issuance_token",
          "ticket_id",
          "claim_commitment",
          "claim_commitment_profile",
        ];
  if (
    !exact(value, fields) ||
    !hex(value.issuance_token) ||
    !["reserve", "complete"].includes(value.operation)
  )
    throw new Error("INVALID_REQUEST");
  if (value.operation === "reserve") {
    if (
      typeof value.market_id !== "string" ||
      !value.market_id.length ||
      !value.market_id.isWellFormed() ||
      value.market_id.includes("\0") ||
      Buffer.byteLength(value.market_id) > 8192 ||
      !["YES", "NO"].includes(value.side) ||
      typeof value.requested_amount_zat !== "string" ||
      value.requested_amount_zat.length > 1024 ||
      !/^[1-9][0-9]*$/.test(value.requested_amount_zat)
    )
      throw new Error("INVALID_REQUEST");
  } else if (
    !hex(value.ticket_id) ||
    !hex(value.claim_commitment) ||
    value.claim_commitment_profile !== "DARKPOOL_CLAIM_V1_ID_FRAME_1"
  )
    throw new Error("INVALID_REQUEST");
  return value;
}
export function allocateInternal(context, env = process.env) {
  assertLiveComponent(env, "issue");
  if (
    !hex(env.ALLOCATION_AUTH) ||
    !/^[0-9]{1,5}$/.test(env.ALLOCATION_PORT ?? "") ||
    +env.ALLOCATION_PORT < 1 ||
    +env.ALLOCATION_PORT > 65535
  )
    throw new Error("ISSUANCE_UNAVAILABLE");
  const fields = [
    env.ALLOCATION_AUTH,
    context.market_id,
    context.vault_context_ref,
    context.ticket_id,
    context.claim_commitment,
    ...(env.DARKPOOL_PG_ENV === "LIVE_EVIDENCE"
      ? [env.DARKPOOL_LIVE_INSTANCE]
      : []),
  ];
  const frame = Buffer.concat(
    fields.map((f) => {
      const bytes = Buffer.from(f, "utf8"),
        size = Buffer.alloc(4);
      size.writeUInt32BE(bytes.length);
      return Buffer.concat([size, bytes]);
    }),
  );
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: "127.0.0.1",
      port: +env.ALLOCATION_PORT,
      allowHalfOpen: true,
    });
    let response = Buffer.alloc(0);
    const fail = () => {
      socket.destroy();
      reject(new Error("ISSUANCE_RECONCILE_REQUIRED"));
    };
    socket.setTimeout(12000, fail);
    socket.on("error", fail);
    socket.on("connect", () => socket.end(frame));
    socket.on("data", (data) => {
      response = Buffer.concat([response, data]);
      if (response.length > 2048) fail();
    });
    socket.on("end", () => {
      socket.destroy();
      try {
        let offset = 0;
        const read = () => {
          const n = response.readUInt32BE(offset);
          offset += 4;
          if (!n || n > 1024 || offset + n > response.length) throw new Error();
          const s = response.subarray(offset, offset + n).toString("utf8");
          offset += n;
          return s;
        };
        const ua = read(),
          diversifier = read();
        if (
          offset !== response.length ||
          !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(ua) ||
          !/^[0-9a-f]{22}$/.test(diversifier)
        )
          throw new Error();
        resolve({ ua, diversifier });
      } catch {
        fail();
      }
    });
  });
}
export function createIssuer({
  query = issuanceQuery,
  allocate = allocateInternal,
} = {}) {
  return async (request) => {
    const input = parseIssuance(request);
    // Raw token only in request memory; SQL/product state receives SHA-256 bytes.
    const bytes = Buffer.from(input.issuance_token, "hex");
    const hash = createHash("sha256").update(bytes).digest("hex");
    bytes.fill(0);
    const h = `decode('${hash}','hex')`;
    if (input.operation === "reserve")
      return query(
        `SELECT darkpool_issuance.reserve(${h},${sqlText(input.market_id)},${sqlText(input.side)},${sqlText(input.requested_amount_zat)},'${randomBytes(32).toString("hex")}');`,
      );
    const digest = `decode('${input.claim_commitment}','hex')`;
    const state = await query(
      `SELECT darkpool_issuance.begin_completion(${h},'${input.ticket_id}',${digest});`,
    );
    if (state.status === "ISSUED") return state;
    const allocated = await allocate({
      ...state,
      claim_commitment: input.claim_commitment,
    });
    // A failed/uncertain DB finish leaves COMPLETING; retry always consults wallet journal.
    return query(
      `SELECT darkpool_issuance.finish(${h},'${input.ticket_id}',${digest},${sqlText(allocated.ua)},${sqlText(allocated.diversifier)});`,
    );
  };
}

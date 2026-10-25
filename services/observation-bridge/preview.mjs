// Private observation preview only. It cannot persist receipts, accept tickets or advance lifecycle.
import { framedWalletProcess, identity, MAX_FRAME } from "../watcher/main.mjs";
const fail = () => {
  throw new Error("OBSERVATION_UNAVAILABLE");
};
const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const text = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.isWellFormed() &&
  !/[\u0000-\u001f\u007f]/u.test(v) &&
  Buffer.byteLength(v) <= 8192;
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 4294967295;
const keys = [
  "version",
  "network",
  "market_id",
  "vault_context_ref",
  "account_ref",
  "endpoint_ref",
  "revision",
  "hold",
  "profile_ref",
  "closes_at_us",
  "anchor_height",
  "anchor_hash",
];
function binding(c) {
  if (
    !c ||
    Object.keys(c).sort().join() !==
      [...keys, "receipts", "unmapped"].sort().join() ||
    c.version !== 1 ||
    c.network !== "testnet" ||
    ![c.market_id, c.vault_context_ref, c.account_ref, c.endpoint_ref].every(
      text,
    ) ||
    c.profile_ref !== "phase9-exact-chainclock-3-v1" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(c.revision ?? "") ||
    typeof c.revision !== "string" ||
    typeof c.hold !== "boolean" ||
    typeof c.closes_at_us !== "string" ||
    !/^[1-9][0-9]{0,19}(?:\.0+)?$/.test(c.closes_at_us) ||
    c.closes_at_us.length > 48 ||
    !uint(c.anchor_height) ||
    !hex(c.anchor_hash) ||
    !Array.isArray(c.receipts) ||
    !Array.isArray(c.unmapped) ||
    c.receipts.length > 4096 ||
    c.unmapped.length > 4096 ||
    Buffer.byteLength(JSON.stringify(c)) > MAX_FRAME
  )
    fail();
  const endpoint = new URL(c.endpoint_ref);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    fail();
  return JSON.stringify(keys.map((k) => c[k]));
}
export function validateObservations(value) {
  if (
    !value ||
    Object.keys(value).join() !== "outputs" ||
    !Array.isArray(value.outputs) ||
    value.outputs.length > 4096 ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_FRAME
  )
    fail();
  const seen = new Set();
  const fields =
    "amount_zat,block_hash,block_height,block_time,canonical,diversifier_ref,is_change,journal_commitment,key_scope,output_index,pool,present,receiver_ref,receiver_verified,ticket_id,tx_index,txid";
  for (const o of value.outputs) {
    if (
      !o ||
      Object.keys(o).sort().join() !== fields ||
      !hex(o.txid) ||
      !["SAPLING", "ORCHARD", "IRONWOOD"].includes(o.pool) ||
      !uint(o.output_index) ||
      typeof o.amount_zat !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/.test(o.amount_zat) ||
      BigInt(o.amount_zat) > 9223372036854775807n ||
      ![null, 0, 1].includes(o.key_scope) ||
      typeof o.is_change !== "boolean" ||
      typeof o.receiver_verified !== "boolean" ||
      typeof o.present !== "boolean" ||
      o.canonical !== false ||
      ![o.block_height, o.block_time, o.tx_index].every(
        (v) => v === null || uint(v),
      ) ||
      (o.block_hash !== null && !hex(o.block_hash))
    )
      fail();
    const mapped = [
      o.receiver_ref,
      o.diversifier_ref,
      o.ticket_id,
      o.journal_commitment,
    ];
    if (
      !mapped.every((v) => v === null) &&
      !(
        text(o.receiver_ref) &&
        typeof o.diversifier_ref === "string" &&
        /^external:[0-9a-f]{22}$/.test(o.diversifier_ref) &&
        hex(o.ticket_id) &&
        hex(o.journal_commitment)
      )
    )
      fail();
    if (
      o.receiver_verified &&
      (mapped.some((v) => v === null) ||
        o.is_change ||
        o.key_scope !== 0 ||
        !["ORCHARD", "IRONWOOD"].includes(o.pool))
    )
      fail();
    const id = identity(o);
    if (seen.has(id)) fail();
    seen.add(id);
  }
  return value;
}
/** Caller owns an ALREADY reviewed child. No wallet path, executable override,
 * process spawning, key loading, sync, rescan, network or DB writer is exposed here.
 * The existing native observe command still requires separately approved RW opening.
 */
export function observeOnlyTransport(child) {
  const framed = framedWalletProcess(child);
  return Object.freeze({
    async observe(context) {
      try {
        binding(context);
        return validateObservations(await framed.request("observe", context));
      } catch {
        fail();
      }
    },
    close: () => framed.close(),
  });
}
export function createObservationPreview({ readContext, observe }) {
  if (typeof readContext !== "function" || typeof observe !== "function")
    fail();
  return Object.freeze({
    async check() {
      try {
        const context = await readContext(),
          before = binding(context);
        let status = "SAFETY_HOLD";
        if (!context.hold) {
          const observation = validateObservations(await observe(context));
          if (binding(await readContext()) !== before)
            throw Error("OBSERVATION_RETRY_REQUIRED");
          status = observation.outputs.length
            ? "OBSERVED_UNVERIFIED"
            : "NO_OBSERVATION";
        }
        return Object.freeze({
          mode: "OBSERVATION_ONLY",
          status,
          acceptance: "NOT_EVALUATED",
          financial_authorization: "NOT_GRANTED",
          spending_enabled: false,
        });
      } catch (e) {
        if (e?.message === "OBSERVATION_RETRY_REQUIRED")
          throw Error("OBSERVATION_RETRY_REQUIRED");
        fail();
      }
    },
  });
}

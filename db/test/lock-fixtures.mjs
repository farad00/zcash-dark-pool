import { randomBytes } from "node:crypto";
export const id = (n) => n.toString(16).padStart(64, "0");
export const json = (v) =>
  `convert_from(decode('${Buffer.from(JSON.stringify(v)).toString("hex")}','hex'),'UTF8')::jsonb`;
export const resources = {
  max_tickets: 4096n,
  max_text_bytes: 8192,
  max_amount_bytes: 128,
  max_ledger_bytes: 4 * 1024 * 1024,
};
export function fixture(
  close = Math.floor(Date.now() / 1000) + 3,
  count = 2,
  tip = 114,
) {
  const account = "11111111-1111-4111-8111-111111111111",
    mid = "phase11-synthetic";
  const headers = Array.from({ length: tip - 89 }, (_, i) => ({
    height: 90 + i,
    hash: id(90 + i),
    prev_hash: id(89 + i),
    time: close - 6 + (90 + i - 100),
  }));
  const outputs = Array.from({ length: count }, (_, i) => {
    const n = i + 1,
      h = 101 + i;
    return {
      txid: id(1000 + n),
      pool: "IRONWOOD",
      output_index: 0,
      amount_zat: "1000",
      ticket_id: id(n),
      receiver_ref: `synthetic-receiver-${n}`,
      diversifier_ref: `external:${n.toString(16).padStart(22, "0")}`,
      journal_commitment: "ab".repeat(32),
      key_scope: 0,
      is_change: false,
      receiver_verified: true,
      present: true,
      canonical: true,
      block_height: h,
      block_hash: id(h),
      block_time: close - 6 + (h - 100),
      tx_index: n,
    };
  });
  const request = {
    version: 1,
    request_id: randomBytes(32).toString("hex"),
    network: "testnet",
    market_id: mid,
    vault_context_ref: "synthetic-vault",
    account_ref: account,
    endpoint_ref: "https://testnet.zec.rocks:443",
    mode: "snapshot",
    outputs,
    chain: {
      complete: true,
      verified: true,
      tip_height: tip,
      tip_hash: id(tip),
      scanned_height: tip,
      scanned_hash: id(tip),
      anchor_hash: id(100),
      verified_at: new Date().toISOString(),
      close_proof: {
        version: 2,
        profile: "phase9-exact-chainclock-3-v1",
        status: "FOUND",
        boundary_height: 112,
        anchor_window: headers.filter((x) => x.height <= 100),
        window: headers.filter((x) => x.height >= 100 && x.height <= 112),
        target: headers.at(-1),
      },
      inclusion_blocks: outputs.map((o) =>
        headers.find((x) => x.height === o.block_height),
      ),
    },
  };
  const setup = `BEGIN; SET LOCAL search_path=darkpool_private,pg_catalog;
INSERT INTO markets VALUES('${mid}',1,'testnet','synthetic-vault','Synthetic Phase 11 question','Yes','No',to_timestamp(${close}-7200),to_timestamp(${close}),
 'phase9-exact-chainclock-3-v1','Rule',ARRAY['synthetic-source'],ARRAY['void'],1,100000000,'phase9-exact-chainclock-3-v1','phase9-zero-platform-fee-v1','NO_WINNER_REFUND',3,NULL,'DRAFT',now(),now());
INSERT INTO market_policy_refs VALUES('${mid}','receiving','phase9-orchard-receiving-v1'),('${mid}','close-proof','phase9-bounded-close-proof-v2'),('${mid}','payout','phase9-payout-deferred-v1');
INSERT INTO admin_revisions VALUES('${mid}',1);
INSERT INTO watcher_state VALUES('${mid}','phase9-exact-chainclock-3-v1','${account}','https://testnet.zec.rocks:443',100,decode('${id(100)}','hex'),to_timestamp(${close}),0,NULL,NULL,now());
UPDATE markets SET status='OPEN';
${outputs
  .map(
    (
      o,
      i,
    ) => `INSERT INTO tickets VALUES('${o.ticket_id}',1,'${mid}','synthetic-vault','${i % 2 === 0 ? "YES" : "NO"}',1000,0,'${o.receiver_ref}','${o.diversifier_ref}',decode(repeat('ab',32),'hex'),'DARKPOOL_CLAIM_V1_ID_FRAME_1','market-close:${mid}','AWAITING_PAYMENT','phase7-issued-unpaid-v1',NULL,now(),NULL);
INSERT INTO issuance_attempts VALUES(decode('${o.ticket_id}','hex'),'${o.ticket_id}','${mid}','synthetic-vault','${i % 2 === 0 ? "YES" : "NO"}',1000,decode(repeat('ab',32),'hex'),'ISSUED');`,
  )
  .join("\n")}
SELECT darkpool_watcher.reconcile(0,${json(request)}); COMMIT;`;
  const lockRequest = {
    request_key: "phase11_synthetic_lock",
    market_id: mid,
    expected_revision: "1",
    expected_watcher_revision: "1",
    checkpoint_ref: "reconcile:" + request.request_id,
    profile: "DARKPOOL_LEDGER_V1_BIN1_B2B256",
  };
  return { setup, request, lockRequest, close, mid };
}

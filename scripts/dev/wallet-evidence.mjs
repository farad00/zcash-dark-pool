// Phase 1 diagnostic only. Read-only SQLite; no key, memo, or note-secret columns.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [walletDir, txid, invoicePath] = process.argv.slice(2);
if (!walletDir || !/^[0-9a-f]{64}$/.test(txid ?? '')) {
  throw new Error('wallet directory and canonical public TXID required');
}
const db = new DatabaseSync(join(walletDir, 'data.sqlite'), { readOnly: true });
try {
  const hash = Buffer.from(txid, 'hex').reverse();
  const tx = db.prepare(`
    SELECT mined_height, tx_index, expiry_height, fee FROM transactions WHERE txid = ?
  `).get(hash);
  const query = db.prepare(`
    SELECT r.pool, r.output_index, r.value, r.is_change,
           a.key_scope, a.diversifier_index_be, a.address,
           r.account_id
      FROM v_received_outputs r
      JOIN transactions t ON t.id_tx = r.transaction_id
      LEFT JOIN addresses a ON a.id = r.address_id
     WHERE t.txid = ? ORDER BY r.pool, r.output_index
  `);
  query.setReadBigInts(true);
  const expected = invoicePath
    ? readFileSync(invoicePath, 'utf8').trim().replace(/^zcash:/, '').split('?')[0]
    : undefined;
  const notes = query.all(hash).map((r) => ({
    pool: r.pool.toString(), output_index: r.output_index.toString(),
    value_zat: r.value.toString(), is_change: r.is_change.toString(),
    address_mapping_present: r.address !== null,
    key_scope: r.key_scope?.toString() ?? null,
    invoice_address_matches: expected === undefined ? null : r.address === expected,
  }));
  const block = tx?.mined_height === null || tx === undefined ? null
    : db.prepare('SELECT height, hash, time FROM blocks WHERE height = ?').get(tx.mined_height);
  console.log(JSON.stringify({
    txid, detected: tx !== undefined, transaction: tx ?? null, notes,
    scanned_block: block ? {
      height: block.height, hash: Buffer.from(block.hash).reverse().toString('hex'), time: block.time,
    } : null,
  }));
} finally {
  db.close();
}

// Phase 1 fixture only. No market schema, claim protocol, settlement, or public API.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const [mode, walletDir, fixturePath, ...inputs] = process.argv.slice(2);
const privateRoot = resolve(process.env.LOCALAPPDATA, 'ZcashDarkPoolDev', 'phase1');
for (const path of [walletDir, fixturePath, ...(mode === 'prepare' ? inputs : [])]) {
  if (!resolve(path).toLowerCase().startsWith(`${privateRoot}${sep}`.toLowerCase())) {
    throw new Error('protected Phase 1 storage required');
  }
}
const wallet = new DatabaseSync(join(walletDir, 'data.sqlite'), { readOnly: true });
const fixture = new DatabaseSync(fixturePath);
try {
  if (wallet.prepare('SELECT COUNT(*) AS n FROM accounts').get().n !== 1) {
    throw new Error('one isolated vault account required');
  }
  fixture.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS context (wallet_path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS receiver_tickets (
      ticket_id TEXT PRIMARY KEY,
      key_scope INTEGER NOT NULL,
      diversifier_index_be BLOB NOT NULL,
      UNIQUE(key_scope, diversifier_index_be)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      txid TEXT NOT NULL, pool INTEGER NOT NULL, output_index INTEGER NOT NULL,
      ticket_id TEXT NOT NULL REFERENCES receiver_tickets(ticket_id),
      value_zat TEXT NOT NULL,
      PRIMARY KEY(txid, pool, output_index)
    );
  `);
  const context = fixture.prepare('SELECT wallet_path FROM context').get();
  if (context && context.wallet_path !== resolve(walletDir)) {
    throw new Error('fixture belongs to a different wallet context');
  }
  if (!context) fixture.prepare('INSERT INTO context VALUES (?)').run(resolve(walletDir));
  if (mode === 'prepare') {
    if (inputs.length !== 2) throw new Error('two private invoices required');
    fixture.exec('BEGIN IMMEDIATE');
    for (const path of inputs) {
      const invoice = readFileSync(path, 'utf8').trim();
      if (!invoice.startsWith('zcash:utest')) throw new Error('testnet UA invoice required');
      const address = invoice.slice(6).split('?')[0];
      const receiver = wallet.prepare(`
        SELECT key_scope, diversifier_index_be FROM addresses WHERE address = ?
      `).get(address);
      if (!receiver || receiver.key_scope !== 0) throw new Error('persisted external receiver required');
      fixture.prepare('INSERT OR IGNORE INTO receiver_tickets VALUES (?, ?, ?)')
        .run(randomBytes(16).toString('hex'), receiver.key_scope, receiver.diversifier_index_be);
    }
    fixture.exec('COMMIT');
    const count = fixture.prepare('SELECT COUNT(*) AS n FROM receiver_tickets').get().n;
    if (count !== 2) throw new Error('two distinct persisted ticket receivers required');
    console.log(JSON.stringify({ phase: 'D', prepared_receivers: count, mapping_persisted_before_payment: true }));
  } else if (mode === 'map') {
    const [txid] = inputs;
    if (!/^[0-9a-f]{64}$/.test(txid ?? '')) throw new Error('canonical public TXID required');
    const query = wallet.prepare(`
      SELECT r.pool, r.output_index, r.value, a.key_scope, a.diversifier_index_be
      FROM v_received_outputs r JOIN transactions t ON t.id_tx = r.transaction_id
      JOIN addresses a ON a.id = r.address_id
      WHERE t.txid = ? AND t.mined_height IS NOT NULL AND r.is_change = 0 ORDER BY r.pool, r.output_index
    `);
    query.setReadBigInts(true);
    const notes = query.all(Buffer.from(txid, 'hex').reverse());
    if (notes.length !== 2) throw new Error('two real received notes required');
    let inserted = 0;
    let replayed = 0;
    const ticketIds = new Set();
    fixture.exec('BEGIN IMMEDIATE');
    for (const note of notes) {
      if (note.pool !== 4n || note.value !== 100000n || note.key_scope !== 0n) {
        throw new Error('unexpected live spike note shape');
      }
      // Amount and TXID filter select this test's evidence; only scope/diversifier
      // within the bound vault context determines the ticket association.
      const match = fixture.prepare(`
        SELECT ticket_id FROM receiver_tickets WHERE key_scope = ? AND diversifier_index_be = ?
      `).get(note.key_scope, note.diversifier_index_be);
      if (!match) throw new Error('unmapped receiver');
      ticketIds.add(match.ticket_id);
      const old = fixture.prepare('SELECT ticket_id, value_zat FROM receipts WHERE txid=? AND pool=? AND output_index=?')
        .get(txid, note.pool, note.output_index);
      if (old) {
        if (old.ticket_id !== match.ticket_id || old.value_zat !== note.value.toString()) {
          throw new Error('receipt identity conflict');
        }
        replayed++;
      } else {
        fixture.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)')
          .run(txid, note.pool, note.output_index, match.ticket_id, note.value.toString());
        inserted++;
      }
    }
    if (ticketIds.size !== 2) throw new Error('equal amounts did not map to distinct tickets');
    fixture.exec('COMMIT');
    const count = fixture.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
    if (count !== 2) throw new Error('receipt count changed unexpectedly');
    console.log(JSON.stringify({ phase: 'D', txid, matched_distinct_tickets: ticketIds.size,
      inserted, replayed, persisted_receipts: count, receipt_identity: 'txid,pool,output_index' }));
  } else {
    throw new Error('prepare or map mode required');
  }
} finally {
  fixture.close();
  wallet.close();
}

//! Read-only testnet receiver equivalence diagnostic; never reads viewing keys.
use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec};
use zcash_protocol::{TxId, consensus::Network};
use zip321::TransactionRequest;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let db_path = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("wallet DB required"))?,
    );
    let txid = TxId::from_hex(
        &args
            .next()
            .ok_or_else(|| anyhow::anyhow!("TXID required"))?,
    )
    .ok_or_else(|| anyhow::anyhow!("invalid TXID"))?;
    let invoice = std::fs::read_to_string(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("invoice required"))?,
    )?;
    let request = TransactionRequest::from_uri(invoice.trim())
        .map_err(|_| anyhow::anyhow!("invalid private invoice"))?;
    anyhow::ensure!(
        request.payments().len() == 1,
        "one invoice recipient required"
    );
    let expected = UnifiedAddress::decode(
        &Network::TestNetwork,
        &request
            .payments()
            .values()
            .next()
            .unwrap()
            .recipient_address()
            .to_string(),
    )
    .map_err(|_| anyhow::anyhow!("invalid testnet invoice UA"))?;
    anyhow::ensure!(
        expected.orchard().is_some()
            && expected.sapling().is_none()
            && expected.transparent().is_none(),
        "invoice must be Orchard-only"
    );
    let db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = db.prepare(
        "SELECT a.address FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id
         JOIN addresses a ON a.id=r.address_id WHERE t.txid=? AND r.pool=4 AND r.is_change=0",
    )?;
    let addresses = query
        .query_map([txid.as_ref()], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut matches = 0;
    for address in &addresses {
        let actual = UnifiedAddress::decode(&Network::TestNetwork, address)
            .map_err(|_| anyhow::anyhow!("invalid persisted testnet UA"))?;
        if actual.orchard() == expected.orchard() {
            matches += 1;
        }
    }
    anyhow::ensure!(
        matches == 1,
        "expected Orchard receiver not uniquely detected"
    );
    println!(
        "{}",
        serde_json::json!({"txid":txid.to_string(), "orchard_receiver_match":true, "matching_notes":matches, "received_note_count":addresses.len()})
    );
    Ok(())
}

//! Read-only Phase 1 diagnostic. Run as an example in the locked upstream devtool.
//! Never opens a wallet or reads keys; emits public transaction shape only.
use std::time::Duration;

use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{
    self, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    TxId,
    consensus::{BlockHeight, BranchId, Network},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let txid = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("txid required"))?;
    let requested = TxId::from_hex(&txid).ok_or_else(|| anyhow::anyhow!("invalid txid"))?;
    let host = match std::env::args().nth(2).as_deref() {
        None | Some("zecrocks") => "testnet.zec.rocks",
        Some("zaino") => "zaino.testnet.unsafe.zec.rocks",
        Some("zecpro") => "lwd.testnet.zec.pro",
        _ => anyhow::bail!("unsupported testnet endpoint"),
    };
    let channel = Channel::from_shared(format!("https://{host}:443"))?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .tls_config(
            ClientTlsConfig::new()
                .domain_name(host)
                .assume_http2(true)
                .with_webpki_roots(),
        )?
        .connect()
        .await?;
    let mut client = CompactTxStreamerClient::new(channel);
    let info = client
        .get_lightd_info(service::Empty {})
        .await?
        .into_inner();
    anyhow::ensure!(info.chain_name == "test", "endpoint is not testnet");
    let raw = match client
        .get_transaction(service::TxFilter {
            hash: requested.as_ref().to_vec(),
            ..Default::default()
        })
        .await
    {
        Ok(response) => response.into_inner(),
        Err(status) if status.code() == tonic::Code::NotFound => {
            println!(
                "{}",
                serde_json::json!({
                    "endpoint": host, "txid": requested.to_string(), "chain": info.chain_name,
                    "tip": info.block_height, "found": false, "rpc_code": "NotFound",
                })
            );
            anyhow::bail!("transaction not found in this testnet endpoint's mempool or chain");
        }
        Err(status) => return Err(status.into()),
    };
    let mined = (raw.height > 0 && raw.height <= u64::from(u32::MAX)).then_some(raw.height);
    let height = BlockHeight::from_u32(u32::try_from(mined.unwrap_or(info.block_height))?);
    let tx = Transaction::read(
        raw.data.as_slice(),
        BranchId::for_height(&Network::TestNetwork, height),
    )?;
    anyhow::ensure!(tx.txid() == requested, "returned transaction ID mismatch");
    let block_evidence = if let Some(mined_height) = mined {
        let block = client
            .get_block(service::BlockId {
                height: mined_height,
                ..Default::default()
            })
            .await?
            .into_inner();
        anyhow::ensure!(
            block.height == mined_height,
            "returned block height mismatch"
        );
        anyhow::ensure!(block.hash.len() == 32, "invalid compact block hash length");
        let matches = block
            .vtx
            .iter()
            .filter(|compact| compact.txid.as_slice() == requested.as_ref())
            .collect::<Vec<_>>();
        anyhow::ensure!(
            matches.len() == 1,
            "transaction not unique in mined compact block"
        );
        Some(serde_json::json!({
            "hash": block.hash().to_string(), "height": block.height,
            "time": block.time, "tx_index": matches[0].index,
            "contains_txid": true,
        }))
    } else {
        None
    };
    println!(
        "{}",
        serde_json::json!({
            "endpoint": host, "found": true, "txid": tx.txid().to_string(), "chain": info.chain_name,
            "tip": info.block_height, "mined_height": mined,
            "confirmations": mined.filter(|h| *h <= info.block_height).map(|h| info.block_height - h + 1),
            "version": format!("{:?}", tx.version()),
            "block": block_evidence,
            "transparent_inputs": tx.transparent_bundle().map_or(0, |b| b.vin.len()),
            "transparent_outputs": tx.transparent_bundle().map_or(0, |b| b.vout.len()),
            "sapling_spends": tx.sapling_bundle().map_or(0, |b| b.shielded_spends().len()),
            "sapling_outputs": tx.sapling_bundle().map_or(0, |b| b.shielded_outputs().len()),
            "orchard_actions": tx.orchard_bundle().map_or(0, |b| b.actions().len()),
            "ironwood_actions": tx.ironwood_bundle().map_or(0, |b| b.actions().len()),
        })
    );
    Ok(())
}

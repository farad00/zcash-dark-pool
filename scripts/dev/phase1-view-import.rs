//! Phase 1 capability transfer. Never reads signer config, seed, or age identity.
//! Build as an example under the recorded upstream devtool lockfile.
use std::{fs::OpenOptions, io::Write, path::PathBuf, time::Duration};

use rand::rngs::OsRng;
use rusqlite::{Connection, OpenFlags};
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::{
    data_api::{AccountBirthday, AccountPurpose, WalletWrite, Zip32Derivation},
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
};
use zcash_client_sqlite::{
    FsBlockDb, WalletDb, chain::init::init_blockmeta_db, util::SystemClock,
    wallet::init::init_wallet_db,
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{BlockHeight, Network};
use zip32::fingerprint::SeedFingerprint;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let first = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("source DB required"))?;
    if first == "--init-cache" {
        let directory = PathBuf::from(
            args.next()
                .ok_or_else(|| anyhow::anyhow!("wallet directory required"))?,
        );
        anyhow::ensure!(
            directory.join("data.sqlite").exists(),
            "existing wallet DB required"
        );
        let mut cache = FsBlockDb::for_path(directory)
            .map_err(|error| anyhow::anyhow!("block cache initialization failed: {error:?}"))?;
        init_blockmeta_db(&mut cache)?;
        println!("wallet-root block cache initialized; viewing account unchanged");
        return Ok(());
    }
    let constructor = first == "--constructor";
    let source = PathBuf::from(if constructor {
        args.next()
            .ok_or_else(|| anyhow::anyhow!("source DB required"))?
    } else {
        first
    });
    let destination = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("watcher directory required"))?,
    );
    anyhow::ensure!(!destination.exists(), "watcher directory already exists");

    // Explicitly read-only; export only viewing capability and birthday in memory.
    let source_db = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let count: u32 = source_db.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
    anyhow::ensure!(count == 1, "exactly one source account required");
    let (encoded, birthday_height): (String, u32) =
        source_db.query_row("SELECT ufvk, birthday_height FROM accounts", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let ufvk = UnifiedFullViewingKey::decode(&Network::TestNetwork, &encoded)
        .map_err(|_| anyhow::anyhow!("invalid testnet viewing capability"))?;
    let purpose = if constructor {
        // These are key-location hints for the external signer, not signing keys.
        let (fingerprint, account_index): (Vec<u8>, u32) = source_db.query_row(
            "SELECT hd_seed_fingerprint, hd_account_index FROM accounts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        AccountPurpose::Spending {
            derivation: Some(Zip32Derivation::new(
                SeedFingerprint::from_bytes(
                    fingerprint
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("invalid derivation fingerprint length"))?,
                ),
                zip32::AccountId::try_from(account_index)?,
            )),
        }
    } else {
        AccountPurpose::ViewOnly
    };
    drop(source_db);

    let channel = Channel::from_static("https://testnet.zec.rocks:443")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .tls_config(
            ClientTlsConfig::new()
                .domain_name("testnet.zec.rocks")
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
    let tree = client
        .get_tree_state(service::BlockId {
            height: u64::from(
                birthday_height
                    .checked_sub(1)
                    .ok_or_else(|| anyhow::anyhow!("invalid birthday"))?,
            ),
            ..Default::default()
        })
        .await?
        .into_inner();
    let birthday = AccountBirthday::from_treestate(
        tree,
        Some(BlockHeight::from_u32(u32::try_from(info.block_height)?)),
    )?;
    std::fs::create_dir(&destination)?;
    let mut cache = FsBlockDb::for_path(&destination)
        .map_err(|error| anyhow::anyhow!("block cache initialization failed: {error:?}"))?;
    init_blockmeta_db(&mut cache)?;
    let mut db = WalletDb::for_path(
        destination.join("data.sqlite"),
        Network::TestNetwork,
        SystemClock,
        OsRng,
    )?;
    init_wallet_db(&mut db, None)?;
    db.import_account_ufvk("phase1-view-only", &ufvk, &birthday, purpose, None)?;
    let mut config = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination.join("keys.toml"))?;
    writeln!(config, "network = \"test\"\nbirthday = {birthday_height}")?;
    config.sync_all()?;
    if constructor {
        println!(
            "UFVK-only constructor initialized with external signer derivation hints; no seed, spending key, or age identity loaded or copied"
        );
    } else {
        println!(
            "view-only wallet initialized; no seed, spending key, or age identity loaded or copied"
        );
    }
    Ok(())
}

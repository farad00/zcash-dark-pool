//! Private, view-only Phase 7 allocation journal. No side, stake or claim secret.
use std::{path::Path, time::Duration};

use rand_core::OsRng;
use rusqlite::{Connection, OptionalExtension, params};
use zcash_client_backend::data_api::{
    Account, AccountPurpose, AccountSource, WalletRead, WalletWrite,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec, keys::UnifiedAddressRequest};
use zcash_protocol::consensus::Network;

use crate::SpikeResult;

pub struct Allocation {
    pub ua: String,
    pub diversifier: String,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// This setup may only create application-owned extension tables, never wallet schema.
/// The same configured wallet is required for recovery. Restored backups require
/// operator reconciliation before this service is started, not automatic reissuance.
pub fn allocate(
    path: &Path,
    market: &str,
    vault: &str,
    ticket: &str,
    commitment: &str,
) -> SpikeResult<Allocation> {
    allocate_inner(path, market, vault, ticket, commitment, false)
}

fn allocate_inner(
    path: &Path,
    market: &str,
    vault: &str,
    ticket: &str,
    commitment: &str,
    rollback: bool,
) -> SpikeResult<Allocation> {
    if !id(ticket) || !id(commitment) || market.is_empty() || vault.is_empty() {
        return Err("invalid allocation context".into());
    }
    // Open an existing provisioned database; never create a missing/restored wallet.
    if !path.is_file() {
        return Err("provisioned wallet required".into());
    }
    // Set durability on the actual wallet transaction connection, including WAL
    // deployments; do not rely on a pragma on a separate setup connection.
    let wallet_conn =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    wallet_conn.busy_timeout(Duration::from_secs(5))?;
    wallet_conn.execute_batch("PRAGMA synchronous=FULL;")?;
    rusqlite::vtab::array::load_module(&wallet_conn)?;
    let mut wallet =
        WalletDb::from_connection(wallet_conn, Network::TestNetwork, SystemClock, OsRng);
    init_wallet_db(&mut wallet, None)?;
    let accounts = wallet.get_account_ids()?;
    let [account] = accounts.as_slice() else {
        return Err("one wallet account required".into());
    };
    let imported = wallet.get_account(*account)?.ok_or("account missing")?;
    if !matches!(
        imported.source(),
        AccountSource::Imported {
            purpose: AccountPurpose::ViewOnly,
            ..
        }
    ) {
        return Err("view-only allocator required".into());
    }
    let account_ref = account.expose_uuid().to_string();
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS ext_darkpool_context (singleton INTEGER PRIMARY KEY CHECK(singleton=1), market TEXT NOT NULL, vault TEXT NOT NULL, account TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ext_darkpool_allocations (ticket TEXT PRIMARY KEY, commitment TEXT NOT NULL, ua TEXT NOT NULL UNIQUE, diversifier TEXT NOT NULL UNIQUE);")?;
    drop(conn);
    // BEGIN is supplied by the maintained API. SQLite serializes writes; BUSY
    // fails safely and caller reconciles by replaying the same journal lookup.
    wallet.transactionally_with_extension(|w, ext| -> SpikeResult<Allocation> {
        let context = ext
            .query_row(
                "SELECT market,vault,account FROM ext_darkpool_context WHERE singleton=1",
                [],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        match context {
            Some(c) if c != (market.to_owned(), vault.to_owned(), account_ref.clone()) => {
                return Err("wallet context conflict".into());
            }
            None => {
                ext.execute(
                    "INSERT INTO ext_darkpool_context VALUES (1,?1,?2,?3)",
                    params![market, vault, account_ref],
                )?;
            }
            _ => (),
        }
        if let Some((bound, ua, diversifier)) = ext
            .query_row(
                "SELECT commitment,ua,diversifier FROM ext_darkpool_allocations WHERE ticket=?1",
                [ticket],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if bound != commitment {
                return Err("allocation commitment conflict".into());
            }
            let decoded = UnifiedAddress::decode(&Network::TestNetwork, &ua)?;
            if decoded.orchard().is_none()
                || decoded.transparent().is_some()
                || decoded.sapling().is_some()
            {
                return Err("invalid journal receiver".into());
            }
            return Ok(Allocation { ua, diversifier });
        }
        let (address, index) = w
            .get_next_available_address(*account, UnifiedAddressRequest::ORCHARD)?
            .ok_or("account missing")?;
        if address.orchard().is_none()
            || address.transparent().is_some()
            || address.sapling().is_some()
        {
            return Err("Orchard-only receiver required".into());
        }
        let result = Allocation {
            ua: address.encode(&Network::TestNetwork),
            diversifier: hex(index.as_bytes()),
        };
        ext.execute(
            "INSERT INTO ext_darkpool_allocations VALUES (?1,?2,?3,?4)",
            params![ticket, commitment, result.ua, result.diversifier],
        )?;
        if rollback {
            return Err("test rollback".into());
        }
        Ok(result)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_view_only_account;
    use crate::open_testnet_wallet;
    use crate::tests::ephemeral_viewing_key;
    use std::collections::HashSet;
    use tempfile::tempdir;
    use zcash_client_backend::data_api::{AccountBirthday, chain::ChainState};
    use zcash_primitives::block::BlockHash;
    use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

    #[test]
    fn journal_recovery_freshness_and_atomic_failure() -> SpikeResult<()> {
        let dir = tempdir()?;
        let path = dir.path().join("unfunded.sqlite");
        let mut w = open_testnet_wallet(&path)?;
        let height = Network::TestNetwork
            .activation_height(NetworkUpgrade::Sapling)
            .ok_or("height")?;
        let birthday =
            AccountBirthday::from_parts(ChainState::empty(height - 1, BlockHash([0; 32])), None);
        import_view_only_account(&mut w, &ephemeral_viewing_key()?, &birthday)?;
        w.update_chain_tip(height)?;
        drop(w);
        let mut addresses = HashSet::new();
        let mut indices = HashSet::new();
        for n in 0..101 {
            let ticket = format!("{n:064x}");
            let result = allocate(&path, "m", "v", &ticket, &"ab".repeat(32))?;
            assert!(addresses.insert(result.ua.clone()));
            assert!(indices.insert(result.diversifier.clone()));
            let decoded = UnifiedAddress::decode(&Network::TestNetwork, &result.ua)?;
            assert!(decoded.orchard().is_some());
            assert!(decoded.transparent().is_none());
            let retry = allocate(&path, "m", "v", &ticket, &"ab".repeat(32))?;
            assert_eq!(retry.ua, result.ua);
            assert_eq!(retry.diversifier, result.diversifier);
        }
        assert!(allocate(&path, "m", "v", &format!("{:064x}", 0), &"cd".repeat(32)).is_err());
        assert!(
            allocate(
                &path,
                "wrong",
                "v",
                &format!("{:064x}", 0),
                &"ab".repeat(32)
            )
            .is_err()
        );
        let before: i64 =
            Connection::open(&path)?
                .query_row("SELECT count(*) FROM addresses", [], |r| r.get(0))?;
        assert!(
            allocate_inner(
                &path,
                "m",
                "v",
                &format!("{:064x}", 999),
                &"ab".repeat(32),
                true
            )
            .is_err()
        );
        let conn = Connection::open(&path)?;
        assert_eq!(
            conn.query_row("SELECT count(*) FROM addresses", [], |r| r.get::<_, i64>(0))?,
            before
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ext_darkpool_allocations", [], |r| r
                .get::<_, i64>(
                0
            ))?,
            101
        );
        drop(conn);
        let workers: Vec<_> = (200..208)
            .map(|n| {
                let p = path.clone();
                std::thread::spawn(move || {
                    allocate(&p, "m", "v", &format!("{n:064x}"), &"ab".repeat(32))
                        .map(|a| a.ua)
                        .map_err(|_| ())
                })
            })
            .collect();
        for (n, worker) in (200..208).zip(workers) {
            // BUSY is allowed, then identical retry must reconcile safely.
            let observed = worker.join().map_err(|_| "thread")?;
            let recovered = allocate(&path, "m", "v", &format!("{n:064x}"), &"ab".repeat(32))?;
            if let Ok(ua) = observed {
                assert_eq!(ua, recovered.ua);
            }
            assert!(addresses.insert(recovered.ua));
        }
        Ok(())
    }
}

//! Offline in-memory unfunded fixtures only: no real wallets, signing or network.
fn main() -> std::process::ExitCode {
    // Deliberately no operational command or configurable wallet path.
    std::process::ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use rand_core::OsRng;
    use rusqlite::Connection;
    use std::num::NonZeroU32;
    use zcash_client_backend::data_api::{
        chain::ChainState,
        wallet::{ConfirmationsPolicy, TargetHeight},
        AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
    };
    use zcash_client_sqlite::{
        error::SqliteClientError, util::SystemClock, wallet::init::init_wallet_db, WalletDb,
    };
    use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
    use zcash_primitives::block::BlockHash;
    use zcash_protocol::{
        consensus::{BlockHeight, Network, NetworkUpgrade, Parameters},
        PoolType,
    };

    fn unfunded_viewing_fixture() -> (UnifiedFullViewingKey, AccountBirthday) {
        let key =
            UnifiedSpendingKey::from_seed(&Network::TestNetwork, &[19; 32], zip32::AccountId::ZERO)
                .unwrap();
        let viewing = key.to_unified_full_viewing_key();
        let height = Network::TestNetwork
            .activation_height(NetworkUpgrade::Sapling)
            .unwrap();
        let birthday =
            AccountBirthday::from_parts(ChainState::empty(height - 1, BlockHash([0; 32])), None);
        (viewing, birthday)
    }

    #[test]
    fn defaults_distinguish_trusted_three_from_external_ten() {
        let p = ConfirmationsPolicy::default();
        assert_eq!(p.trusted().get(), 3);
        assert_eq!(p.untrusted().get(), 10);
    }

    #[test]
    fn three_is_supported_and_includes_the_mining_block() {
        // Test the proposed depth in isolation, not a change to wallet defaults.
        let p = ConfirmationsPolicy::new_symmetrical(NonZeroU32::new(3).unwrap());
        for (tip, remaining) in [(100, 2), (101, 1), (102, 0)] {
            assert_eq!(
                p.confirmations_until_spendable(
                    TargetHeight::from(tip + 1),
                    PoolType::ORCHARD,
                    Some(zip32::Scope::External),
                    Some(BlockHeight::from_u32(100)),
                    false,
                    None,
                    false,
                ),
                remaining
            );
        }
    }

    #[test]
    fn external_default_is_not_reduced_by_proposed_payout_depth() {
        let p = ConfirmationsPolicy::default();
        assert_eq!(
            p.confirmations_until_spendable(
                TargetHeight::from(103),
                PoolType::ORCHARD,
                Some(zip32::Scope::External),
                Some(BlockHeight::from_u32(100)),
                false,
                None,
                false,
            ),
            7
        );
        assert_eq!(
            p.confirmations_until_spendable(
                TargetHeight::from(103),
                PoolType::ORCHARD,
                Some(zip32::Scope::External),
                None,
                false,
                None,
                false,
            ),
            10
        );
    }

    #[test]
    fn wallet_and_extension_commit_atomically_in_memory() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE ext_payout_fixture (id INTEGER PRIMARY KEY);")
            .unwrap();
        let mut wallet =
            WalletDb::from_connection(&mut conn, Network::TestNetwork, SystemClock, OsRng);
        init_wallet_db(&mut wallet, None).unwrap();
        let (viewing, birthday) = unfunded_viewing_fixture();
        wallet
            .transactionally_with_extension::<_, _, SqliteClientError>(|w, ext| {
                w.import_account_ufvk(
                    "unfunded-compatibility",
                    &viewing,
                    &birthday,
                    AccountPurpose::ViewOnly,
                    None,
                )?;
                ext.execute("INSERT INTO ext_payout_fixture VALUES (1)", [])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(wallet.get_account_ids().unwrap().len(), 1);
        drop(wallet);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ext_payout_fixture", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn wallet_and_extension_roll_back_together() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE ext_payout_fixture (id INTEGER PRIMARY KEY);")
            .unwrap();
        let mut wallet =
            WalletDb::from_connection(&mut conn, Network::TestNetwork, SystemClock, OsRng);
        init_wallet_db(&mut wallet, None).unwrap();
        let (viewing, birthday) = unfunded_viewing_fixture();
        let result: Result<(), SqliteClientError> =
            wallet.transactionally_with_extension(|w, ext| {
                w.import_account_ufvk(
                    "unfunded-compatibility",
                    &viewing,
                    &birthday,
                    AccountPurpose::ViewOnly,
                    None,
                )?;
                ext.execute("INSERT INTO ext_payout_fixture VALUES (1)", [])?;
                Err(SqliteClientError::AccountUnknown)
            });
        assert!(result.is_err());
        assert!(wallet.get_account_ids().unwrap().is_empty());
        drop(wallet);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ext_payout_fixture", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn extension_cannot_commit_or_write_wallet_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        let mut wallet =
            WalletDb::from_connection(&mut conn, Network::TestNetwork, SystemClock, OsRng);
        init_wallet_db(&mut wallet, None).unwrap();
        for sql in ["COMMIT", "DELETE FROM accounts"] {
            let result: Result<(), SqliteClientError> =
                wallet.transactionally_with_extension(|_, ext| {
                    ext.execute(sql, [])?;
                    Ok(())
                });
            assert!(result.is_err());
        }
        assert!(wallet.get_account_ids().unwrap().is_empty());
    }
}

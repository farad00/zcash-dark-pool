//! Maintained testnet wallet capabilities and private Phase 7 allocation journal.
use std::{error::Error, path::Path};

use rand_core::OsRng;
use rusqlite::Connection;
use zcash_client_backend::data_api::{Account, AccountBirthday, AccountPurpose, WalletWrite};
use zcash_client_sqlite::{AccountUuid, WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::{
    address::UnifiedAddress,
    keys::{UnifiedAddressRequest, UnifiedFullViewingKey},
};
use zcash_protocol::{consensus::Network, value::Zatoshis};
use zip32::DiversifierIndex;
use zip321::{Payment, TransactionRequest};

pub type TestnetWallet = WalletDb<Connection, Network, SystemClock, OsRng>;
pub type SpikeResult<T> = Result<T, Box<dyn Error>>;
pub mod allocation_server;
pub mod issuance;
pub mod live_target;
pub mod payment_request;
pub mod unfunded;
pub mod watcher;

/// Always binds the database handle to testnet. Does not create or accept seeds.
pub fn open_testnet_wallet(path: &Path) -> SpikeResult<TestnetWallet> {
    let mut wallet = WalletDb::for_path(path, Network::TestNetwork, SystemClock, OsRng)?;
    // Fail if a migration needs a seed. The watcher must never request one.
    init_wallet_db(&mut wallet, None)?;
    Ok(wallet)
}

/// The caller must supply an actual verified testnet birthday for a live scan.
/// Viewing capability must remain inside the restricted wallet boundary.
pub fn import_view_only_account(
    wallet: &mut TestnetWallet,
    viewing_key: &UnifiedFullViewingKey,
    birthday: &AccountBirthday,
) -> SpikeResult<AccountUuid> {
    let account = wallet.import_account_ufvk(
        "phase-1-vault",
        viewing_key,
        birthday,
        AccountPurpose::ViewOnly,
        None,
    )?;
    Ok(account.id())
}

/// The maintained wallet API persists each exposed diversifier. A current chain
/// tip must have been supplied before allocation; no fabricated tip is used here.
pub fn allocate_orchard_receiver(
    wallet: &mut TestnetWallet,
    account: AccountUuid,
) -> SpikeResult<(UnifiedAddress, DiversifierIndex)> {
    let (address, diversifier) = wallet
        .get_next_available_address(account, UnifiedAddressRequest::ORCHARD)?
        .ok_or("unknown wallet account")?;
    if address.orchard().is_none() || address.sapling().is_some() || address.transparent().is_some()
    {
        return Err("wallet did not return an Orchard-only Unified Address".into());
    }
    Ok((address, diversifier))
}

/// Exact testnet Orchard invoice. No memo, side, ticket ID, label or message.
pub fn orchard_payment_request(address: &UnifiedAddress, amount: Zatoshis) -> SpikeResult<String> {
    if address.orchard().is_none() || address.sapling().is_some() || address.transparent().is_some()
    {
        return Err("spike invoices require an Orchard-only Unified Address".into());
    }
    let recipient = address.to_zcash_address(zcash_protocol::consensus::NetworkType::Test);
    let payment = Payment::new(recipient, Some(amount), None, None, None, vec![])?;
    Ok(TransactionRequest::new(vec![payment])?.to_uri())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rand_core::RngCore;
    use secrecy::{ExposeSecret, SecretVec};
    use tempfile::tempdir;
    use zcash_client_backend::data_api::{AccountSource, WalletRead, chain::ChainState};
    use zcash_keys::keys::UnifiedSpendingKey;
    use zcash_primitives::block::BlockHash;
    use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

    use super::*;

    pub(crate) fn ephemeral_viewing_key() -> SpikeResult<UnifiedFullViewingKey> {
        // Test-only, unfunded authority. Seed is zeroized by SecretVec on return;
        // the spending key stays within this scope and is never serialized.
        let mut bytes = vec![0_u8; 32];
        OsRng.try_fill_bytes(&mut bytes)?;
        let seed = SecretVec::new(bytes);
        let spending = UnifiedSpendingKey::from_seed(
            &Network::TestNetwork,
            seed.expose_secret(),
            zip32::AccountId::ZERO,
        )?;
        Ok(spending.to_unified_full_viewing_key())
    }

    #[test]
    fn orchard_allocation_survives_reopen() -> SpikeResult<()> {
        let dir = tempdir()?;
        let path = dir.path().join("ephemeral-wallet.sqlite");

        // Random ephemeral unfunded authority, never serialized or printed.
        // This generator exists only in tests, outside the watcher library API.
        let viewing = ephemeral_viewing_key()?;

        // Synthetic local chain fixture ONLY. Never use it for live sync/funding.
        let height = Network::TestNetwork
            .activation_height(NetworkUpgrade::Sapling)
            .ok_or("testnet Sapling activation missing")?;
        let birthday =
            AccountBirthday::from_parts(ChainState::empty(height - 1, BlockHash([0_u8; 32])), None);
        let mut wallet = open_testnet_wallet(&path)?;
        let account = import_view_only_account(&mut wallet, &viewing, &birthday)?;
        drop(viewing);
        wallet.update_chain_tip(height)?;

        let mut receivers = HashSet::new();
        let mut indices = HashSet::new();
        let mut allocations = Vec::new();
        for _ in 0..100 {
            let (ua, index) = allocate_orchard_receiver(&mut wallet, account)?;
            assert!(receivers.insert(ua.encode(&Network::TestNetwork)));
            assert!(indices.insert(*index.as_bytes()));
            allocations.push((ua, index));
        }
        drop(wallet);

        let mut reopened = open_testnet_wallet(&path)?;
        assert_eq!(reopened.get_account_ids()?, vec![account]);
        let restored = reopened.get_account(account)?.ok_or("account missing")?;
        assert!(matches!(
            restored.source(),
            AccountSource::Imported {
                purpose: AccountPurpose::ViewOnly,
                ..
            }
        ));
        // Read persisted address state via the supported WalletRead API.
        let last = reopened
            .get_last_generated_address_matching(account, UnifiedAddressRequest::ORCHARD)?;
        assert_eq!(last, allocations.last().map(|(ua, _)| ua.clone()));
        for (ua, index) in allocations {
            assert_eq!(
                reopened.get_address_for_index(account, index, UnifiedAddressRequest::ORCHARD)?,
                Some(ua)
            );
        }
        let (next, index) = allocate_orchard_receiver(&mut reopened, account)?;
        assert!(receivers.insert(next.encode(&Network::TestNetwork)));
        assert!(indices.insert(*index.as_bytes()));
        Ok(())
    }

    #[test]
    fn zip321_preserves_exact_amount_and_orchard_receiver() -> SpikeResult<()> {
        let viewing = ephemeral_viewing_key()?;
        let (ua, _) = viewing.default_address(UnifiedAddressRequest::ORCHARD)?;
        drop(viewing);

        for zat in [1_u64, 1_000_000, 2_000_000, 100_000_000] {
            let amount = Zatoshis::from_u64(zat)?;
            let uri = orchard_payment_request(&ua, amount)?;
            let parsed = TransactionRequest::from_uri(&uri)?;
            assert_eq!(parsed.payments().len(), 1);
            let payment = parsed.payments().get(&0).ok_or("payment missing")?;
            assert_eq!(payment.amount(), Some(amount));
            assert_eq!(
                payment.recipient_address().to_string(),
                ua.encode(&Network::TestNetwork)
            );
            assert!(payment.memo().is_none());
            assert!(payment.label().is_none());
            assert!(payment.message().is_none());
        }
        // Network-aware parser must refuse treating this invoice's UA as mainnet.
        assert!(
            zcash_keys::address::Address::decode(
                &Network::MainNetwork,
                &ua.encode(&Network::TestNetwork)
            )
            .is_none()
        );
        Ok(())
    }
}

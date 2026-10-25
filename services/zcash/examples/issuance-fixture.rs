//! Unfunded synthetic test fixture ONLY. No live birthday, network I/O or funds.
use darkpool_zcash::{SpikeResult, import_view_only_account, open_testnet_wallet};
use rand_core::{OsRng, RngCore};
use secrecy::{ExposeSecret, SecretVec};
use std::{env, path::Path};
use zcash_client_backend::data_api::{AccountBirthday, WalletWrite, chain::ChainState};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::{Network, NetworkUpgrade, Parameters};
fn main() -> SpikeResult<()> {
    if env::var("DARKPOOL_SYNTHETIC_TEST").as_deref() != Ok("1") {
        return Err("test fixture only".into());
    }
    let path = env::args().nth(1).ok_or("new test path required")?;
    if Path::new(&path).exists() {
        return Err("never overwrite a wallet".into());
    }
    let mut bytes = vec![0; 32];
    OsRng.try_fill_bytes(&mut bytes)?;
    let seed = SecretVec::new(bytes);
    let viewing = {
        let spending = UnifiedSpendingKey::from_seed(
            &Network::TestNetwork,
            seed.expose_secret(),
            zip32::AccountId::ZERO,
        )?;
        spending.to_unified_full_viewing_key()
    };
    let height = Network::TestNetwork
        .activation_height(NetworkUpgrade::Sapling)
        .ok_or("height")?;
    let birthday =
        AccountBirthday::from_parts(ChainState::empty(height - 1, BlockHash([0; 32])), None);
    let mut wallet = open_testnet_wallet(Path::new(&path))?;
    import_view_only_account(&mut wallet, &viewing, &birthday)?;
    wallet.update_chain_tip(height)?;
    Ok(())
}

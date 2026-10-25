//! Public deterministic, unfunded synthetic address. Never a live wallet.
use darkpool_zcash::SpikeResult;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;

fn main() -> SpikeResult<()> {
    if std::env::var("DARKPOOL_SYNTHETIC_TEST").as_deref() != Ok("1") {
        return Err("synthetic fixture only".into());
    }
    let key =
        UnifiedSpendingKey::from_seed(&Network::TestNetwork, &[42; 32], zip32::AccountId::ZERO)?;
    let (ua, _) = key
        .to_unified_full_viewing_key()
        .default_address(UnifiedAddressRequest::ORCHARD)?;
    println!("{}", ua.encode(&Network::TestNetwork));
    Ok(())
}

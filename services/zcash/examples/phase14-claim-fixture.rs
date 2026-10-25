//! Deterministic unfunded TEST addresses. No wallet files, network or signing.
use darkpool_zcash::SpikeResult;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;
fn main() -> SpikeResult<()> {
    if std::env::var("DARKPOOL_SYNTHETIC_TEST").as_deref() != Ok("1") {
        return Err("synthetic fixture only".into());
    }
    let mut addresses = vec![];
    for n in 50..56 {
        let key =
            UnifiedSpendingKey::from_seed(&Network::TestNetwork, &[n; 32], zip32::AccountId::ZERO)?;
        let (ua, _) = key
            .to_unified_full_viewing_key()
            .default_address(UnifiedAddressRequest::ORCHARD)?;
        addresses.push(ua.encode(&Network::TestNetwork));
    }
    println!("{}", serde_json::to_string(&addresses)?);
    Ok(())
}

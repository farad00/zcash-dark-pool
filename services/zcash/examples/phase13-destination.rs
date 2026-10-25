//! Stateless address decoder only. No wallet, keys, database, network or spending.
use std::io::{Read, Write};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec};
use zcash_protocol::consensus::Network;

fn validate(ua: &str) -> Result<[u8; 43], ()> {
    if ua.is_empty() || ua.len() > 1024 {
        return Err(());
    }
    let address = UnifiedAddress::decode(&Network::TestNetwork, ua).map_err(|_| ())?;
    if address.encode(&Network::TestNetwork) != ua {
        return Err(());
    }
    Ok(address.orchard().ok_or(())?.to_raw_address_bytes())
}
fn pipe(input: &mut impl Read, output: &mut impl Write) -> Result<(), ()> {
    let mut size = [0; 4];
    input.read_exact(&mut size).map_err(|_| ())?;
    let n = u32::from_be_bytes(size) as usize;
    if n == 0 || n > 1024 {
        return Err(());
    }
    let mut data = vec![0; n];
    input.read_exact(&mut data).map_err(|_| ())?;
    let mut tail = [0; 1];
    if input.read(&mut tail).map_err(|_| ())? != 0 {
        return Err(());
    }
    let ua = std::str::from_utf8(&data).map_err(|_| ())?;
    output.write_all(&validate(ua)?).map_err(|_| ())
}
fn main() -> std::process::ExitCode {
    if std::env::args().len() != 1 || std::env::var("ZCASH_NETWORK").as_deref() != Ok("testnet") {
        return std::process::ExitCode::FAILURE;
    }
    match pipe(&mut std::io::stdin().lock(), &mut std::io::stdout().lock()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(()) => std::process::ExitCode::FAILURE, // No address/parser diagnostics.
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use zcash_keys::keys::{ReceiverRequirement, UnifiedAddressRequest, UnifiedSpendingKey};
    fn fixture() -> UnifiedAddress {
        UnifiedSpendingKey::from_seed(&Network::TestNetwork, &[42; 32], zip32::AccountId::ZERO)
            .unwrap()
            .to_unified_full_viewing_key()
            .default_address(UnifiedAddressRequest::ORCHARD)
            .unwrap()
            .0
    }
    #[test]
    fn orchard_and_mixed_select_only_orchard() {
        let ua = fixture();
        let expected = validate(&ua.encode(&Network::TestNetwork)).unwrap();
        let t = zcash_keys::address::Address::decode(
            &Network::TestNetwork,
            "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
        )
        .unwrap();
        if let zcash_keys::address::Address::Transparent(t) = t {
            let mixed =
                UnifiedAddress::from_receivers(ua.orchard().cloned(), None, Some(t)).unwrap();
            assert_eq!(validate(&mixed.encode(&Network::TestNetwork)), Ok(expected));
        } else {
            panic!("synthetic fixture");
        }
    }
    #[test]
    fn wrong_network_transparent_sapling_and_corruption_reject() {
        let ua = fixture();
        let key =
            UnifiedSpendingKey::from_seed(&Network::TestNetwork, &[43; 32], zip32::AccountId::ZERO)
                .unwrap();
        let sapling = key
            .to_unified_full_viewing_key()
            .default_address(
                UnifiedAddressRequest::custom(
                    ReceiverRequirement::Omit,
                    ReceiverRequirement::Require,
                    ReceiverRequirement::Omit,
                )
                .unwrap(),
            )
            .unwrap()
            .0;
        for bad in [
            ua.encode(&Network::MainNetwork),
            sapling.encode(&Network::TestNetwork),
            "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU".to_owned(),
            "utest1invalid".to_owned(),
            ua.encode(&Network::TestNetwork).to_uppercase(),
        ] {
            assert!(validate(&bad).is_err());
        }
    }
    #[test]
    fn exact_frame_and_invalid_utf8() {
        let ua = fixture().encode(&Network::TestNetwork);
        let mut frame = (ua.len() as u32).to_be_bytes().to_vec();
        frame.extend(ua.as_bytes());
        let mut out = vec![];
        assert!(pipe(&mut &frame[..], &mut out).is_ok());
        assert_eq!(out.len(), 43);
        frame.push(0);
        assert!(pipe(&mut &frame[..], &mut vec![]).is_err());
        for bad in [
            vec![0, 0, 0, 1, 0xff],
            vec![0, 0, 0, 0],
            vec![0, 0, 4, 1],
            vec![0, 0, 0, 4, 1],
        ] {
            assert!(pipe(&mut &bad[..], &mut vec![]).is_err());
        }
    }
}

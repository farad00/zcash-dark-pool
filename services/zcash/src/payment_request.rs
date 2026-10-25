//! Stateless Phase 8 validation. No wallet, database, key or chain access.
use std::io::{Read, Write};

use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec};
use zcash_protocol::{consensus::Network, value::Zatoshis};

use crate::{SpikeResult, orchard_payment_request};

pub fn validate_and_format(receiving_ua: &str, requested_amount_zat: &str) -> SpikeResult<String> {
    if receiving_ua.len() > 1024
        || requested_amount_zat.is_empty()
        || requested_amount_zat.len() > 16
        || !requested_amount_zat.bytes().all(|b| b.is_ascii_digit())
        || requested_amount_zat.starts_with('0')
    {
        return Err("invalid payment request".into());
    }
    let amount = Zatoshis::from_u64(requested_amount_zat.parse()?)?;
    let address = UnifiedAddress::decode(&Network::TestNetwork, receiving_ua)?;
    if address.encode(&Network::TestNetwork) != receiving_ua {
        return Err("noncanonical payment destination".into());
    }
    orchard_payment_request(&address, amount)
}

/// Two bounded length-framed UTF-8 inputs, EOF, then one length-framed URI.
/// All values travel through pipes, never arguments or diagnostic output.
pub fn format_pipe(mut input: impl Read, mut output: impl Write) -> SpikeResult<()> {
    fn field(input: &mut impl Read, max: usize) -> SpikeResult<String> {
        let mut size = [0; 4];
        input.read_exact(&mut size)?;
        let n = u32::from_be_bytes(size) as usize;
        if n == 0 || n > max {
            return Err("invalid formatter frame".into());
        }
        let mut bytes = vec![0; n];
        input.read_exact(&mut bytes)?;
        Ok(String::from_utf8(bytes)?)
    }
    let ua = field(&mut input, 1024)?;
    let amount = field(&mut input, 16)?;
    let mut extra = [0; 1];
    if input.read(&mut extra)? != 0 {
        return Err("unexpected formatter field".into());
    }
    let uri = validate_and_format(&ua, &amount)?;
    output.write_all(&u32::try_from(uri.len())?.to_be_bytes())?;
    output.write_all(uri.as_bytes())?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::ephemeral_viewing_key;
    use zcash_keys::keys::{ReceiverRequirement, UnifiedAddressRequest};
    use zip321::TransactionRequest;

    #[test]
    fn exact_literals_and_round_trips() -> SpikeResult<()> {
        let (ua, _) = ephemeral_viewing_key()?.default_address(UnifiedAddressRequest::ORCHARD)?;
        let encoded = ua.encode(&Network::TestNetwork);
        for (zat, decimal) in [
            ("1", "0.00000001"),
            ("9", "0.00000009"),
            ("10", "0.0000001"),
            ("100000", "0.001"),
            ("1000000", "0.01"),
            ("99999999", "0.99999999"),
            ("100000000", "1"),
            ("100000001", "1.00000001"),
            ("2099999999999999", "20999999.99999999"),
            ("2100000000000000", "21000000"),
        ] {
            let uri = validate_and_format(&encoded, zat)?;
            assert_eq!(uri, format!("zcash:{encoded}?amount={decimal}"));
            let parsed = TransactionRequest::from_uri(&uri)?;
            assert_eq!(parsed.payments().len(), 1);
            let p = &parsed.payments()[&0];
            assert_eq!(p.recipient_address().to_string(), encoded);
            assert_eq!(p.amount(), Some(Zatoshis::from_u64(zat.parse()?)?));
            assert!(p.memo().is_none() && p.label().is_none() && p.message().is_none());
            assert!(p.other_params().is_empty());
        }
        for zat in [
            "",
            "0",
            "00",
            "01",
            "-1",
            "+1",
            "1.0",
            "1e8",
            " 1",
            "1 ",
            "1,000",
            "NaN",
            "Infinity",
            "2100000000000001",
            "9007199254740993",
            "999999999999999999999",
        ] {
            assert!(validate_and_format(&encoded, zat).is_err());
        }
        Ok(())
    }

    #[test]
    fn full_network_receiver_and_canonical_validation() -> SpikeResult<()> {
        let viewing = ephemeral_viewing_key()?;
        let (ua, _) = viewing.default_address(UnifiedAddressRequest::ORCHARD)?;
        let encoded = ua.encode(&Network::TestNetwork);
        let mut corrupt = encoded.clone().into_bytes();
        let last = corrupt.last_mut().unwrap();
        *last = if *last == b'q' { b'p' } else { b'q' };
        for bad in [
            "utest1qqqq".to_owned(),
            String::from_utf8(corrupt)?,
            encoded[..encoded.len() - 1].to_owned(),
            encoded.to_uppercase(),
            format!(" {encoded}"),
            format!("{encoded}?memo=x"),
            ua.encode(&Network::MainNetwork),
        ] {
            assert!(validate_and_format(&bad, "1").is_err());
        }
        let (sapling, _) = viewing.default_address(
            UnifiedAddressRequest::custom(
                ReceiverRequirement::Omit,
                ReceiverRequirement::Require,
                ReceiverRequirement::Omit,
            )
            .map_err(|_| "invalid synthetic receiver request")?,
        )?;
        assert!(validate_and_format(&sapling.encode(&Network::TestNetwork), "1").is_err());
        let mixed =
            UnifiedAddress::from_receivers(ua.orchard().cloned(), sapling.sapling().cloned(), None)
                .unwrap();
        assert!(validate_and_format(&mixed.encode(&Network::TestNetwork), "1").is_err());
        // Maintained constructor creates a valid mixed transparent/Orchard UA.
        let transparent = zcash_keys::address::Address::decode(
            &Network::TestNetwork,
            "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
        )
        .unwrap();
        if let zcash_keys::address::Address::Transparent(t) = transparent {
            let mixed =
                UnifiedAddress::from_receivers(ua.orchard().cloned(), None, Some(t)).unwrap();
            assert!(validate_and_format(&mixed.encode(&Network::TestNetwork), "1").is_err());
        } else {
            panic!("synthetic transparent fixture invalid");
        }
        assert!(validate_and_format("tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU", "1").is_err());
        Ok(())
    }

    #[test]
    fn bounded_pipe_rejects_invalid_utf8_extra_and_truncated_input() -> SpikeResult<()> {
        let (ua, _) = ephemeral_viewing_key()?.default_address(UnifiedAddressRequest::ORCHARD)?;
        let encoded = ua.encode(&Network::TestNetwork);
        let mut frame = vec![];
        for f in [encoded.as_bytes(), b"1000000"] {
            frame.extend_from_slice(&(f.len() as u32).to_be_bytes());
            frame.extend_from_slice(f);
        }
        let mut out = vec![];
        format_pipe(frame.as_slice(), &mut out)?;
        let expected = format!("zcash:{encoded}?amount=0.01");
        assert_eq!(&out[4..], expected.as_bytes());
        assert_eq!(
            u32::from_be_bytes(out[..4].try_into()?),
            expected.len() as u32
        );
        for invalid in [
            vec![],
            vec![0, 0, 4, 1],
            vec![0, 0, 0, 1, 255],
            frame[..frame.len() - 1].to_vec(),
            [frame, vec![0]].concat(),
        ] {
            let mut out = vec![];
            assert!(format_pipe(invalid.as_slice(), &mut out).is_err());
            assert!(out.is_empty());
        }
        Ok(())
    }
}

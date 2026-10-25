//! Independent, synthetic-only golden-vector generator. Never reads user IDs/secrets.
//! Uses Rust blake2b_simd 1.0.5, not the production TypeScript encoder or noble hash.
use std::fmt::Write;

fn hex(bytes: &[u8]) -> String {
    let mut result = String::new();
    for byte in bytes {
        write!(result, "{byte:02x}").expect("write to string");
    }
    result
}

fn frame(id: &str) -> Vec<u8> {
    let bytes = id.as_bytes();
    let length = u32::try_from(bytes.len()).expect("synthetic fixture fits u32");
    let mut output = vec![1];
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(bytes);
    output
}

fn main() {
    assert_eq!(
        std::env::args().len(),
        1,
        "synthetic-only generator accepts no input"
    );
    let secret: Vec<u8> = (0..32).collect(); // Explicitly synthetic TEST_PLAN V01 bytes.
    let fixtures = [
        ("V01", "m1", "t1"),
        ("UTF8", "é", "票😀"),
        ("BOUNDARY_A", "ab", "c"),
        ("BOUNDARY_B", "a", "bc"),
        ("LONG_LENGTH", "m1", ""),
    ];
    println!(
        "{{\"schema_version\":1,\"profile_id\":\"DARKPOOL_CLAIM_V1_ID_FRAME_1\",\"network\":\"testnet\",\"source\":\"SPEC section 2; TEST_PLAN U05/U06/V01/V02; approved claim encoding profile\",\"independent_implementation\":\"Rust blake2b_simd 1.0.5 Params::hash_length(32), independently written Rust ID framing\",\"vectors\":["
    );
    for (index, (name, market, ticket)) in fixtures.iter().enumerate() {
        let long_ticket = "a".repeat(256);
        let ticket = if *name == "LONG_LENGTH" {
            long_ticket.as_str()
        } else {
            ticket
        };
        let market_frame = frame(market);
        let ticket_frame = frame(ticket);
        let mut preimage = b"DARKPOOL_CLAIM_V1".to_vec();
        preimage.extend_from_slice(&market_frame);
        preimage.extend_from_slice(&ticket_frame);
        preimage.extend_from_slice(&secret);
        let digest = blake2b_simd::Params::new().hash_length(32).hash(&preimage);
        let full = blake2b_simd::Params::new().hash_length(64).hash(&preimage);
        let mut alternate = preimage.clone();
        alternate[b"DARKPOOL_CLAIM_V1".len() - 1] = b'2'; // DARKPOOL_CLAIM_V2.
        let alternate_digest = blake2b_simd::Params::new().hash_length(32).hash(&alternate);
        println!(
            "{{\"name\":\"{name}\",\"input\":{{\"version\":1,\"market_id\":\"{market}\",\"ticket_id\":\"{ticket}\",\"claim_secret_hex\":\"{}\"}},\"domain_hex\":\"{}\",\"market_frame_hex\":\"{}\",\"ticket_frame_hex\":\"{}\",\"preimage_hex\":\"{}\",\"expected_digest_hex\":\"{}\",\"truncated_blake2b512_hex\":\"{}\",\"alternate_domain_digest_hex\":\"{}\"}}{}",
            hex(&secret),
            hex(b"DARKPOOL_CLAIM_V1"),
            hex(&market_frame),
            hex(&ticket_frame),
            hex(&preimage),
            digest.to_hex(),
            hex(&full.as_bytes()[..32]),
            alternate_digest.to_hex(),
            if index + 1 == fixtures.len() { "" } else { "," }
        );
    }
    println!("]}}");
}

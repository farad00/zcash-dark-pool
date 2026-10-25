//! Spike D test input only; no product batching interface or protocol format.
use std::{fs::OpenOptions, io::Write};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec};
use zcash_protocol::consensus::Network;
use zip321::TransactionRequest;

fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    anyhow::ensure!(
        args.len() == 3,
        "two invoice paths and output path required"
    );
    let mut payments = Vec::new();
    for path in &args[..2] {
        let input = std::fs::read_to_string(path)?;
        let request = TransactionRequest::from_uri(input.trim())
            .map_err(|_| anyhow::anyhow!("invalid private invoice"))?;
        anyhow::ensure!(
            request.payments().len() == 1,
            "single-recipient invoice required"
        );
        let payment = request.payments().values().next().unwrap();
        let ua = UnifiedAddress::decode(
            &Network::TestNetwork,
            &payment.recipient_address().to_string(),
        )
        .map_err(|_| anyhow::anyhow!("invalid testnet invoice UA"))?;
        anyhow::ensure!(
            ua.orchard().is_some() && ua.sapling().is_none() && ua.transparent().is_none(),
            "Orchard-only invoices required"
        );
        anyhow::ensure!(payment.memo().is_none(), "memo-free invoice required");
        payments.push(payment.clone());
    }
    anyhow::ensure!(
        payments[0].recipient_address() != payments[1].recipient_address(),
        "distinct receivers required"
    );
    anyhow::ensure!(
        payments[0].amount() == payments[1].amount(),
        "equal test amounts required"
    );
    let request = TransactionRequest::new(payments)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&args[2])?;
    writeln!(output, "{}", request.to_uri())?;
    output.sync_all()?;
    println!("two distinct shielded receivers, equal amounts, no memos; private ZIP-321 written");
    Ok(())
}

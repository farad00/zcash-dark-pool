//! Technical-spike signer review. No product settlement-plan format is defined.
//! Reads UFVK privately to verify inputs/change; never reads spending authority.
use pczt::{Pczt, roles::verifier::Verifier};
use rusqlite::{Connection, OpenFlags};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec, keys::UnifiedFullViewingKey};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
use zip321::TransactionRequest;

fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    anyhow::ensure!(
        args.len() == 5 || args.len() == 6,
        "PCZT, invoice, wallet DB, expected fee, unsigned/signed mode, optional amount override required"
    );
    let pczt = Pczt::parse(&std::fs::read(&args[0])?)
        .map_err(|_| anyhow::anyhow!("invalid private PCZT"))?;
    let request = TransactionRequest::from_uri(std::fs::read_to_string(&args[1])?.trim())
        .map_err(|_| anyhow::anyhow!("invalid private invoice"))?;
    anyhow::ensure!(
        request.payments().len() == 1,
        "one approved output required"
    );
    let payment = request.payments().values().next().unwrap();
    let expected = UnifiedAddress::decode(
        &Network::TestNetwork,
        &payment.recipient_address().to_string(),
    )
    .map_err(|_| anyhow::anyhow!("invalid testnet invoice UA"))?;
    anyhow::ensure!(
        expected.orchard().is_some()
            && expected.sapling().is_none()
            && expected.transparent().is_none(),
        "Orchard-only approved output required"
    );
    let expected_receiver = expected.orchard().unwrap();
    let expected_amount = if let Some(amount) = args.get(5) {
        amount.parse::<u64>()?
    } else {
        payment
            .amount()
            .ok_or_else(|| anyhow::anyhow!("exact approved amount required"))?
            .into_u64()
    };
    let expected_fee = args[3].parse::<u64>()?;
    anyhow::ensure!(
        args[4] == "unsigned" || args[4] == "signed",
        "invalid review mode"
    );
    let db = Connection::open_with_flags(&args[2], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let encoded: String = db.query_row("SELECT ufvk FROM accounts", [], |r| r.get(0))?;
    let ufvk = UnifiedFullViewingKey::decode(&Network::TestNetwork, &encoded)
        .map_err(|_| anyhow::anyhow!("invalid private testnet viewing capability"))?;
    let fvk = ufvk
        .orchard()
        .ok_or_else(|| anyhow::anyhow!("Orchard viewing capability required"))?;
    anyhow::ensure!(
        *pczt.global().tx_version() == 6,
        "current testnet V6 required"
    );
    let branch = BranchId::for_height(
        &Network::TestNetwork,
        BlockHeight::from_u32(*pczt.global().expiry_height()),
    );
    anyhow::ensure!(
        *pczt.global().consensus_branch_id() == u32::from(branch),
        "official-testnet branch mismatch"
    );
    anyhow::ensure!(
        pczt.transparent().inputs().is_empty() && pczt.transparent().outputs().is_empty(),
        "transparent component rejected"
    );
    anyhow::ensure!(
        pczt.sapling().spends().is_empty()
            && pczt.sapling().outputs().is_empty()
            && pczt.orchard().actions().is_empty(),
        "unexpected value pool"
    );
    anyhow::ensure!(
        *pczt.ironwood().value_sum() == (expected_fee, false),
        "fee mismatch"
    );
    let mut real_spends = 0;
    let mut signed_spends = 0;
    let mut approved_outputs = 0;
    let mut total_spent = 0_u64;
    let mut total_output = 0_u64;
    let pczt = Verifier::new(pczt)
        .with_ironwood::<anyhow::Error, _>(|bundle| {
            let review = (|| -> anyhow::Result<()> {
                bundle.verify_cross_address_restriction()?;
                for action in bundle.actions() {
                    anyhow::ensure!(
                        action.spend().dummy_sk().is_none(),
                        "dummy spending key must be removed before signer boundary"
                    );
                    action.verify_cv_net()?;
                    action.spend().verify_nullifier(Some(fvk))?;
                    action.spend().verify_rk(Some(fvk))?;
                    action.output().verify_note_commitment(action.spend())?;
                    let spent = action
                        .spend()
                        .value()
                        .ok_or_else(|| anyhow::anyhow!("input value missing"))?
                        .inner();
                    let output = action
                        .output()
                        .value()
                        .ok_or_else(|| anyhow::anyhow!("output value missing"))?
                        .inner();
                    total_spent = total_spent
                        .checked_add(spent)
                        .ok_or_else(|| anyhow::anyhow!("input sum overflow"))?;
                    total_output = total_output
                        .checked_add(output)
                        .ok_or_else(|| anyhow::anyhow!("output sum overflow"))?;
                    if spent > 0 {
                        real_spends += 1;
                        if action.spend().spend_auth_sig().is_some() {
                            signed_spends += 1;
                        }
                    }
                    if output > 0 {
                        let recipient = action
                            .output()
                            .recipient()
                            .ok_or_else(|| anyhow::anyhow!("output receiver missing"))?;
                        if recipient == *expected_receiver {
                            anyhow::ensure!(
                                output == expected_amount,
                                "approved output amount mismatch"
                            );
                            approved_outputs += 1;
                        } else {
                            anyhow::ensure!(
                                fvk.scope_for_address(&recipient) == Some(zip32::Scope::Internal),
                                "non-approved output is not internal vault change"
                            );
                        }
                    }
                }
                Ok(())
            })();
            review.map_err(pczt::roles::verifier::OrchardError::Custom)
        })
        .map_err(|error| anyhow::anyhow!("PCZT semantic review failed: {error:?}"))?
        .finish();
    anyhow::ensure!(
        approved_outputs == 1 && real_spends > 0,
        "approved output/real spend count mismatch"
    );
    anyhow::ensure!(
        total_spent.checked_sub(total_output) == Some(expected_fee),
        "input/output/fee reconciliation failed"
    );
    if args[4] == "signed" {
        anyhow::ensure!(
            pczt.ironwood().zkproof().is_some(),
            "Ironwood proof missing"
        );
        anyhow::ensure!(
            signed_spends == real_spends,
            "real Ironwood spend authorization signatures missing"
        );
    } else {
        anyhow::ensure!(
            signed_spends == 0,
            "constructor already possesses authorization"
        );
    }
    println!(
        "{}",
        serde_json::json!({"phase":"F", "plan_review":"PASS", "mode":args[4], "real_spends":real_spends, "signed_real_spends":signed_spends, "approved_outputs":approved_outputs, "proof_present":pczt.ironwood().zkproof().is_some(), "transparent_inputs":0, "transparent_outputs":0})
    );
    Ok(())
}

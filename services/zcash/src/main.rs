use std::{env, fs::OpenOptions, io::Write, process::ExitCode};

use zcash_client_backend::data_api::WalletRead;
use zcash_protocol::value::Zatoshis;

fn generate_invoice() -> darkpool_zcash::SpikeResult<()> {
    if env::var("DARKPOOL_PG_ENV").as_deref() == Ok("LIVE_EVIDENCE") {
        return Err("spike invoice unavailable for LIVE".into());
    }
    let (path, _) = darkpool_zcash::live_target::configuration("watcher")?;
    let output = env::var("SPIKE_INVOICE_PATH")?;
    let amount = Zatoshis::from_u64(env::var("SPIKE_AMOUNT_ZAT")?.parse()?)?;
    // Caller must put output in the restricted non-synced wallet directory.
    // Never overwrite an existing invoice, or print receiver/URI into logs.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    let mut wallet = darkpool_zcash::open_testnet_wallet(&path)?;
    let accounts = wallet.get_account_ids()?;
    let [account] = accounts.as_slice() else {
        return Err("invoice spike requires exactly one wallet account".into());
    };
    let (ua, _) = darkpool_zcash::allocate_orchard_receiver(&mut wallet, *account)?;
    let uri = darkpool_zcash::orchard_payment_request(&ua, amount)?;
    writeln!(file, "{uri}")?;
    file.sync_all()?;
    Ok(())
}

fn main() -> ExitCode {
    if env::args().nth(1).as_deref() == Some("diagnose-connection") {
        // Endpoint-only diagnostic, before any wallet/product/network context guard.
        let mut args = env::args().skip(2);
        let endpoint = args.next();
        let endpoint = endpoint.as_deref().filter(|_| args.next().is_none());
        return ExitCode::from(darkpool_zcash::watcher::connect::run(endpoint));
    }
    if env::var("ZCASH_NETWORK").as_deref() != Ok("testnet") {
        eprintln!("ZCASH_NETWORK must explicitly be testnet");
        return ExitCode::FAILURE;
    }
    match env::args().nth(1).as_deref() {
        Some("check-unfunded-viewer") => match darkpool_zcash::unfunded::check() {
            Ok(()) => {
                println!("UNFUNDED_VIEWER_READY");
                ExitCode::SUCCESS
            }
            Err(_) => {
                eprintln!("UNFUNDED_VIEWER_NOT_READY");
                ExitCode::FAILURE
            }
        },
        Some("serve-watcher") => match darkpool_zcash::watcher::serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => {
                eprintln!("private testnet watcher unavailable");
                ExitCode::FAILURE
            }
        },
        Some("format-payment-request") => {
            // Stateless operation: no wallet path, key, database or chain configuration.
            match darkpool_zcash::payment_request::format_pipe(
                std::io::stdin().lock(),
                std::io::stdout().lock(),
            ) {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::FAILURE, // Never print parser/address diagnostics.
            }
        }
        Some("serve-allocation") => match darkpool_zcash::allocation_server::serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => {
                eprintln!("private testnet allocator unavailable");
                ExitCode::FAILURE
            }
        },
        Some("init-db") => {
            let Ok((path, _)) = darkpool_zcash::live_target::configuration("watcher") else {
                eprintln!("WALLET_DB_PATH is required (use protected non-synced storage)");
                return ExitCode::FAILURE;
            };
            match darkpool_zcash::open_testnet_wallet(&path) {
                Ok(_) => {
                    println!(
                        "testnet wallet schema initialized; no account or spending authority created"
                    );
                    ExitCode::SUCCESS
                }
                Err(_) => {
                    // Do not dump wallet/key context through library error formatting.
                    eprintln!("wallet database initialization failed");
                    ExitCode::FAILURE
                }
            }
        }
        Some("generate-invoice") => match generate_invoice() {
            Ok(()) => {
                println!("testnet Orchard-only invoice written to private file");
                ExitCode::SUCCESS
            }
            Err(_) => {
                eprintln!("invoice generation failed; no key or invoice context logged");
                ExitCode::FAILURE
            }
        },
        None => {
            println!("darkpool-zcash: testnet spike CLI; commands: init-db, generate-invoice");
            ExitCode::SUCCESS
        }
        Some(_) => {
            eprintln!("unknown spike command");
            ExitCode::FAILURE
        }
    }
}

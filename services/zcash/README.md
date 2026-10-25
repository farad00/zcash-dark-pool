# Zcash technical spike

This is a local Rust CLI, with no public HTTP listener. Only explicit testnet
configuration is accepted. Direct versions and Cargo.lock were pinned after a
successful build and local receiver/ZIP-321 tests. Live payment, isolated scanning
and payout compatibility are still separate, unpassed gates.

Run commands from repository root with activated tooling:

```powershell
$env:ZCASH_NETWORK = 'testnet'
cargo build --workspace
cargo run -p darkpool-zcash
```

Spike progression and live-test gates are recorded in docs/SPIKE_RESULTS.md.
No keys or viewing material should appear in CLI output or normal logs.

`generate-invoice` requires WALLET_DB_PATH for an already initialized/synced
single-account testnet wallet, SPIKE_AMOUNT_ZAT (integer), and SPIKE_INVOICE_PATH.
Put the output in that wallet's protected non-synced directory. The command
persists a fresh Orchard-only receiver and writes a ZIP-321 URI into a new private
file (never overwrites); only generic status appears on stdout. It does not create
tickets or send transactions. Failed generation may leave an empty reserved file;
inspect privately and use a new output filename when retrying.

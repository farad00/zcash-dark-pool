# Protocol vectors

`claim-commitment-v1.json` contains five saved literal fixtures for the user-approved
V1 claim encoding, including TEST_PLAN V01. See the approval/implementation note
in `docs/CLAIM_ENCODING_V1_IMPLEMENTATION.md`. These secrets and identifiers are
explicitly synthetic; fixture ID labels do not choose production ID representation.

Expectations were generated independently with Rust `blake2b_simd` 1.0.5 and an
independently written Rust frame encoder, not production TypeScript/noble hashes.
The primary m1/t1 digest is
`39fe1b1e0383976626942f13f1defe23504fb5c73cc2cc1c23894d70bfef1fa7`.
Tests read literal expectations; they never regenerate them at test runtime.

From the repository root, with local tooling activated, reproduce into a temporary
file for comparison rather than overwriting the reviewed fixtures:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD '.tools/phase2-claim-reference/target'
cargo build --manifest-path test-vectors/reference/Cargo.toml --locked --offline
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$lines = & ./.tools/phase2-claim-reference/target/debug/phase2-claim-reference.exe
if ($LASTEXITCODE -ne 0) { throw 'reference generator failed' }
[IO.File]::WriteAllText((Join-Path $PWD '.tools/phase2-claim-reference/reproduced.json'), ($lines -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding))
```

The standalone reference manifest and lockfile are retained for reproducibility;
they do not alter the product Cargo workspace, lockfile or wallet dependencies.
Generator source: `scripts/dev/phase2-claim-reference.rs`. It accepts no arguments
or private input, and emits synthetic data only. Native 32-byte digests, alternative
domain digests and truncated-512 negative controls are saved separately.

Merkle/ledger/plan vectors and economic exception expectations remain unpinned
or scheduled for later authorized phases. No approval is implied for those encodings
or policies by these claim fixtures.

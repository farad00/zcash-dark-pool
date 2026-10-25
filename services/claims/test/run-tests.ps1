$ErrorActionPreference='Stop'
$phase13Repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $phase13Repo 'scripts/dev/activate.ps1')
Push-Location $phase13Repo
try {
 cargo build -p darkpool-zcash --example phase13-destination --example payment-request-fixture --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Destination build failed'}
 cargo test -p darkpool-zcash --example phase13-destination --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Destination tests failed'}
 node --test services/claims/test/claim.test.mjs
 if($LASTEXITCODE -ne 0){throw 'Claim tests failed'}
} finally {Pop-Location}

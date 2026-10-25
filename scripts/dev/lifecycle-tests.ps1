param([ValidateSet('integration','regression')][string]$Action='integration')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$lifecycleRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $lifecycleRepo
$lifecyclePrior=@{}
$lifecycleNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK') } | ForEach-Object {$_.Name})
$lifecycleNames+=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIFECYCLE_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
foreach($lifecycleKey in ($lifecycleNames|Select-Object -Unique)) {
 $lifecyclePrior[$lifecycleKey]=[Environment]::GetEnvironmentVariable($lifecycleKey,'Process')
 [Environment]::SetEnvironmentVariable($lifecycleKey,$null,'Process')
}
try {
 cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Synthetic lifecycle native prerequisites failed'}
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 if($Action -eq 'regression') {
  & node --test packages/protocol/phase10/settlement.test.mjs packages/protocol/phase10/ledger-commitment.test.mjs services/lock/test/finalize.test.mjs packages/protocol/phase12/preparation.test.mjs services/claims/test/claim.test.mjs services/resolution/test/prepare.test.mjs
  # PostgreSQL admin coverage runs in the integration harness; no separate retained DB.
 } else {
  $lifecycleRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $lifecycleCredential=Import-Clixml -LiteralPath (Join-Path $lifecycleRoot 'maintenance.xml')
  if($lifecycleCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$lifecycleCredential.UserName
  $env:PGPASSWORD=$lifecycleCredential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $lifecycleRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:DARKPOOL_LIFECYCLE_TEST_ONLY='1'
  & node --test --test-concurrency=1 --test-reporter=tap db/test/lifecycle.test.mjs
 }
 if($LASTEXITCODE -ne 0){throw 'Synthetic lifecycle tests failed'}
} finally {
 foreach($lifecycleKey in $lifecyclePrior.Keys){[Environment]::SetEnvironmentVariable($lifecycleKey,$lifecyclePrior[$lifecycleKey],'Process')}
 $lifecycleCredential=$null
 Pop-Location
}

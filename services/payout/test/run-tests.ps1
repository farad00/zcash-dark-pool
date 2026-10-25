param([ValidateSet('postgres','regression')][string]$Action='postgres',[string]$NamePattern='')
$ErrorActionPreference='Stop'
$payoutRepo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $payoutRepo 'scripts/dev/activate.ps1')
Push-Location $payoutRepo
try {
 cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Synthetic payout fixtures failed to build'}
 if($Action -eq 'regression') {
  node --test packages/protocol/phase10/settlement.test.mjs packages/protocol/phase10/ledger-commitment.test.mjs services/lock/test/finalize.test.mjs packages/protocol/phase12/preparation.test.mjs services/claims/test/claim.test.mjs services/resolution/test/prepare.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Payout prerequisite regressions failed'}
 } else {
  $payoutTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $payoutCredential=Import-Clixml -LiteralPath (Join-Path $payoutTestRoot 'maintenance.xml')
  if($payoutCredential.UserName -ne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $payoutNames=@('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')
  $payoutPrevious=@{}
  foreach($name in $payoutNames){$payoutPrevious[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  try {
   $env:PGPASSWORD=$payoutCredential.GetNetworkCredential().Password
   $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
   $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $payoutTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
   Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
   $payoutArgs=@('--test','--test-concurrency=1')
   if($NamePattern){$payoutArgs+=@('--test-name-pattern',$NamePattern)}
   $payoutArgs+='db/test/payout.test.mjs'
   & node @payoutArgs
   if($LASTEXITCODE -ne 0){throw 'Payout planning PostgreSQL tests failed'}
  } finally {foreach($name in $payoutNames){[Environment]::SetEnvironmentVariable($name,$payoutPrevious[$name],'Process')}}
 }
} finally {Pop-Location}

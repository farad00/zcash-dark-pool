param([ValidateSet('postgres','regression')][string]$Action='postgres',[string]$NamePattern='')
$ErrorActionPreference='Stop'
$claimRepo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $claimRepo 'scripts/dev/activate.ps1')
Push-Location $claimRepo
try {
 cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Synthetic claim fixtures failed to build'}
 if($Action -eq 'regression') {
  node --test packages/protocol/phase10/settlement.test.mjs packages/protocol/phase10/ledger-commitment.test.mjs services/lock/test/finalize.test.mjs packages/protocol/phase12/preparation.test.mjs services/claims/test/claim.test.mjs services/resolution/test/prepare.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Claim prerequisite regressions failed'}
 } else {
  $claimTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $claimCredential=Import-Clixml -LiteralPath (Join-Path $claimTestRoot 'maintenance.xml')
  if($claimCredential.UserName -ne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $claimNames=@('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')
  $claimPrevious=@{}
  foreach($name in $claimNames){$claimPrevious[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  try {
   $env:PGPASSWORD=$claimCredential.GetNetworkCredential().Password
   $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
   $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $claimTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
   Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
   $claimArgs=@('--test','--test-concurrency=1')
   if($NamePattern){$claimArgs+=@('--test-name-pattern',$NamePattern)}
   $claimArgs+='db/test/claims.test.mjs'
   & node @claimArgs
   if($LASTEXITCODE -ne 0){throw 'Durable claim PostgreSQL tests failed'}
  } finally {foreach($name in $claimNames){[Environment]::SetEnvironmentVariable($name,$claimPrevious[$name],'Process')}}
 }
} finally {Pop-Location}

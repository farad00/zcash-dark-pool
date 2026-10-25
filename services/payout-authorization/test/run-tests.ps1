param([ValidateSet('postgres','contracts','regression')][string]$Action='contracts',[string]$NamePattern='')
$ErrorActionPreference='Stop'
$authorizationRepo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $authorizationRepo 'scripts/dev/activate.ps1')
Push-Location $authorizationRepo
try {
 if($Action -eq 'contracts') {
  cargo test -p darkpool-zcash --example payout-compatibility --offline --locked
  if($LASTEXITCODE -ne 0){throw 'Native compatibility tests failed'}
  node --test services/payout-authorization/test/contracts.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Authorization contracts failed'}
 } elseif($Action -eq 'regression') {
  & (Join-Path $authorizationRepo 'services/payout/test/run-tests.ps1') -Action regression
 } else {
  cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --offline --locked
  if($LASTEXITCODE -ne 0){throw 'Synthetic fixtures failed to build'}
  $authorizationRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $authorizationCredential=Import-Clixml -LiteralPath (Join-Path $authorizationRoot 'maintenance.xml')
  if($authorizationCredential.UserName -ne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $authorizationNames=@('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')
  $authorizationPrevious=@{}
  foreach($name in $authorizationNames){$authorizationPrevious[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  try {
   $env:PGPASSWORD=$authorizationCredential.GetNetworkCredential().Password
   $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
   $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $authorizationRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
   Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
   $authorizationArgs=@('--test','--test-concurrency=1')
   if($NamePattern){$authorizationArgs+=@('--test-name-pattern',$NamePattern)}
   $authorizationArgs+='db/test/payout-authorization.test.mjs'
   & node @authorizationArgs
   if($LASTEXITCODE -ne 0){throw 'Operator request PostgreSQL tests failed'}
  } finally {foreach($name in $authorizationNames){[Environment]::SetEnvironmentVariable($name,$authorizationPrevious[$name],'Process')}}
 }
} finally {Pop-Location}

param([ValidateSet('postgres','regression')][string]$Action='postgres',[string]$NamePattern='')
$ErrorActionPreference='Stop'
$resolutionRepo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $resolutionRepo 'scripts/dev/activate.ps1')
Push-Location $resolutionRepo
try {
 if($Action -eq 'regression') {
  node --test packages/protocol/phase10/settlement.test.mjs packages/protocol/phase10/ledger-commitment.test.mjs services/lock/test/finalize.test.mjs packages/protocol/phase12/preparation.test.mjs services/claims/test/claim.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Phase 10-13 regressions failed'}
 } else {
  $resolutionTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $resolutionCredential=Import-Clixml -LiteralPath (Join-Path $resolutionTestRoot 'maintenance.xml')
  if($resolutionCredential.UserName -ne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $resolutionNames=@('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')
  $resolutionPrevious=@{}
  foreach($name in $resolutionNames){$resolutionPrevious[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  try {
   $env:PGPASSWORD=$resolutionCredential.GetNetworkCredential().Password
   $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
   $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $resolutionTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
   Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
   $resolutionArgs=@('--test','--test-concurrency=1')
   if($NamePattern){$resolutionArgs+=@('--test-name-pattern',$NamePattern)}
   $resolutionArgs+='db/test/resolution.test.mjs'
   & node @resolutionArgs
   if($LASTEXITCODE -ne 0){throw 'Resolution PostgreSQL tests failed'}
  } finally {foreach($name in $resolutionNames){[Environment]::SetEnvironmentVariable($name,$resolutionPrevious[$name],'Process')}}
 }
} finally {Pop-Location}

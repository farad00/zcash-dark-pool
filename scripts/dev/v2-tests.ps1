param([ValidateSet('unit','postgres')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$v2TestRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $v2TestRepo
$v2TestPrior=@{}
foreach($key in @('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE','APP_ENV','ZCASH_NETWORK')) {$v2TestPrior[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try {
 if($Action -eq 'unit'){& node --test db/test/v2-unit.test.mjs}
 else {
  $testRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $testCredential=Import-Clixml -LiteralPath (Join-Path $testRoot 'maintenance.xml')
  if($testCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER=$testCredential.UserName;$env:PGDATABASE='postgres'
  $env:PGPASSWORD=$testCredential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $testRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
  $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet';Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
  & node --test --test-concurrency=1 db/test/v2-integration.test.mjs
 }
 if($LASTEXITCODE -ne 0){throw 'V2 TEST rehearsal failed'}
} finally {
 foreach($key in $v2TestPrior.Keys){[Environment]::SetEnvironmentVariable($key,$v2TestPrior[$key],'Process')}
 $testCredential=$null;Pop-Location
}

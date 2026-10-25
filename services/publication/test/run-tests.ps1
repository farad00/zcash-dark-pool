param([ValidateSet('unit','postgres')][string]$Action='unit')
$ErrorActionPreference='Stop'
$publicationRepo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $publicationRepo 'scripts/dev/activate.ps1')
Push-Location $publicationRepo
try {
 if($Action -eq 'unit') {
  node --test services/publication/test/verify.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Publication verification tests failed'}
 } else {
  $publicationTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $publicationCredential=Import-Clixml -LiteralPath (Join-Path $publicationTestRoot 'maintenance.xml')
  if($publicationCredential.UserName -ne 'darkpool_test_maintenance'){throw 'TEST credential identity rejected'}
  $publicationNames=@('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')
  $publicationPrevious=@{}
  foreach($name in $publicationNames){$publicationPrevious[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  try {
   $env:PGPASSWORD=$publicationCredential.GetNetworkCredential().Password
   $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
   $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $publicationTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
   Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
   node --test --test-concurrency=1 db/test/publication.test.mjs
   if($LASTEXITCODE -ne 0){throw 'Publication PostgreSQL tests failed'}
  } finally {
   foreach($name in $publicationNames){[Environment]::SetEnvironmentVariable($name,$publicationPrevious[$name],'Process')}
  }
 }
} finally {Pop-Location}

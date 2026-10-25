param([ValidateSet('watcher','regressions','public','inventory')][string]$Action = 'watcher')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/activate.ps1"
$repoPhase9Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$testRoot = Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
$credential = Import-Clixml -LiteralPath (Join-Path $testRoot 'maintenance.xml')
if ($credential.UserName -ne 'darkpool_test_maintenance') { throw 'TEST credential identity rejected' }
$previousPhase9Pg = @{}
foreach ($name in @('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')) {
  $previousPhase9Pg[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  $env:PGPASSWORD = $credential.GetNetworkCredential().Password
  $env:PGHOST = '127.0.0.1'
  $env:PGPORT = '55433'
  $env:PGUSER = 'darkpool_test_maintenance'
  $env:PGDATABASE = 'postgres'
  $env:DARKPOOL_PG_ENV = 'TEST'
  $env:DARKPOOL_PG_PROFILE = Join-Path $testRoot 'profile.json'
  $env:DARKPOOL_TEST_ONLY = 'TEST_ONLY'
  Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
  if ($Action -eq 'watcher') {
    & node --test --test-concurrency=1 (Join-Path $repoPhase9Root 'services/watcher/test/watcher.test.mjs') (Join-Path $repoPhase9Root 'db/test/watcher.test.mjs')
  } elseif ($Action -eq 'public') {
    & node --test --test-concurrency=1 (Join-Path $repoPhase9Root 'apps/web/test/public-db.test.mjs')
  } elseif ($Action -eq 'inventory') {
    & node --input-type=module -e "import {psql} from './db/test-fixtures.mjs'; console.log(await psql('SELECT count(*) FROM pg_database WHERE datistemplate=false;'));"
  } else {
    & node --test --test-concurrency=1 (Join-Path $repoPhase9Root 'db/test/schema.test.mjs') (Join-Path $repoPhase9Root 'apps/web/test/admin.test.mjs') (Join-Path $repoPhase9Root 'apps/web/test/public-db.test.mjs') (Join-Path $repoPhase9Root 'apps/web/test/issuance.test.mjs') (Join-Path $repoPhase9Root 'apps/web/test/payment-request.test.mjs')
  }
  if ($LASTEXITCODE -ne 0) { throw 'Disposable Phase 9 tests failed' }
} finally {
  foreach ($name in $previousPhase9Pg.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousPhase9Pg[$name], 'Process')
  }
}

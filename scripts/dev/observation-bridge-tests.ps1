param([ValidateSet('unit','integration','regression','deposit','receiver')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$observationRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $observationRepo
$observationPrior=@{}
$observationNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK','ALLOCATION_AUTH','ALLOCATION_PORT','CHAIN_ENDPOINT')} | ForEach-Object {$_.Name})
$observationNames+=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIFECYCLE_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
foreach($observationKey in ($observationNames|Select-Object -Unique)){
 $observationPrior[$observationKey]=[Environment]::GetEnvironmentVariable($observationKey,'Process')
 [Environment]::SetEnvironmentVariable($observationKey,$null,'Process')
}
try {
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 # Literal wallet-free suites, no discovery or package hooks.
 $observationFiles=@(switch($Action){
  'unit' {@('services/observation-bridge/test/preview.test.mjs')}
  'integration' {@('db/test/observation-bridge.test.mjs')}
  'deposit' {@('services/genuine-deposit/test/unit.test.mjs','services/genuine-deposit/test/integration.test.mjs','db/test/observation-bridge.test.mjs','services/test-bridge/test/payment-status.test.mjs','apps/web/test/public.test.mjs')}
  'receiver' {@('services/genuine-deposit/test/unfunded.test.mjs','services/genuine-deposit/test/unfunded-postgres.test.mjs','services/genuine-deposit/test/unit.test.mjs')}
  'regression' {@('services/test-bridge/test/payment-status.test.mjs','db/test/operational-bridge.test.mjs','packages/protocol/phase10/settlement.test.mjs','packages/protocol/phase10/ledger-commitment.test.mjs','services/lock/test/finalize.test.mjs','packages/protocol/phase12/preparation.test.mjs','services/claims/test/claim.test.mjs','services/resolution/test/prepare.test.mjs')}
 })
 if($Action -ne 'unit'){
  # Compilation and stateless address/decoder prerequisites only.
  cargo build -p darkpool-zcash --bin darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
  if($LASTEXITCODE -ne 0){throw 'Stateless prerequisites failed'}
  & node apps/web/build-vault.mjs
  if($LASTEXITCODE -ne 0){throw 'Browser assets unavailable'}
  $observationTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $observationCredential=Import-Clixml -LiteralPath (Join-Path $observationTestRoot 'maintenance.xml')
  if($observationCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$observationCredential.UserName
  $env:PGPASSWORD=$observationCredential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $observationTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:DARKPOOL_LIFECYCLE_TEST_ONLY='1'
 }
 $observationEvidence=Join-Path $observationRepo ('.tools/observation-bridge-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $observationEvidence|Out-Null
 $observationInputs=@($observationFiles)+@('services/observation-bridge/context.mjs','services/observation-bridge/preview.mjs','services/observation-bridge/review.mjs','services/observation-bridge/test/process-fixtures.mjs','services/observation-bridge/test/scanner-worker.mjs','db/test/observation-provision.mjs','db/test/lifecycle-fixtures.mjs','services/watcher/main.mjs','services/watcher/db.mjs','apps/web/src/issuance.mjs','scripts/dev/observation-bridge-tests.ps1')
 if($Action -eq 'deposit'){$observationInputs+=@('services/genuine-deposit/target.mjs','services/genuine-deposit/runtime.mjs','services/genuine-deposit/query.mjs','services/genuine-deposit/status.mjs','db/participant-status-provision.mjs','services/zcash/src/live_target.rs','apps/web/src/issuance-ui.mjs','apps/web/src/issuance.html','apps/web/src/payment-status-wire.mjs','apps/web/src/payment-ui.mjs','apps/web/src/public-market.mjs','apps/web/src/public-server.mjs','scripts/demo/product.mjs')}
 if($Action -eq 'receiver'){$observationInputs+=@('services/genuine-deposit/unfunded.mjs','services/genuine-deposit/intake.mjs','services/genuine-deposit/unfunded-runtime.mjs','services/genuine-deposit/unfunded-tools.mjs','services/genuine-deposit/unfunded-cli.mjs','services/genuine-deposit/query.mjs','services/genuine-deposit/target.mjs','services/genuine-deposit/status.mjs','apps/web/src/issuance-server.mjs','db/participant-status-provision.mjs','scripts/dev/genuine-receiver.ps1','services/genuine-deposit/test/unfunded-storage-fixture.ps1');$observationInputs+=@(Get-ChildItem -LiteralPath 'db/migrations' -Filter '*.sql'|ForEach-Object{$_.FullName})}
 if($Action -eq 'receiver'){$observationInputs+=@('services/zcash/src/unfunded.rs','services/zcash/src/lib.rs','services/zcash/src/main.rs')}
 $observationHashes=@{}
 foreach($observationInput in ($observationInputs|Select-Object -Unique)){$observationHashes[$observationInput]=(Get-FileHash -LiteralPath $observationInput -Algorithm SHA256).Hash}
 $observationStart=[DateTime]::UtcNow.ToString('o')
 $observationTap=Join-Path $observationEvidence 'tests.tap.log'
 $observationArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+@($observationFiles)
 & node @observationArguments 2>&1 | Tee-Object -FilePath $observationTap
 $observationExit=$LASTEXITCODE
 $observationUnchanged=$true
 foreach($observationInput in $observationHashes.Keys){if((Get-FileHash -LiteralPath $observationInput -Algorithm SHA256).Hash -ne $observationHashes[$observationInput]){$observationUnchanged=$false}}
 $observationReceipt=[ordered]@{version=1;scope='SYNTHETIC_PROCESS_CONTRACT_TEST_ONLY';action=$Action;started_utc=$observationStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$observationExit;inputs_unchanged=$observationUnchanged;test_files=@($observationFiles);source_sha256=$observationHashes;tap_sha256=(Get-FileHash -LiteralPath $observationTap -Algorithm SHA256).Hash;tap_encoding='PowerShell Tee-Object UTF-16LE';real_wallet_access=$false;wallet_initialization_authorized=$false;financial_authorization=$false;real_process_launch_enabled=$false}
 $observationReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $observationEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained observation bridge evidence: '+$observationEvidence)
 if($observationExit -ne 0 -or -not $observationUnchanged){throw 'Observation bridge tests failed or source changed'}
} finally {
 foreach($observationKey in $observationPrior.Keys){[Environment]::SetEnvironmentVariable($observationKey,$observationPrior[$observationKey],'Process')}
 $observationCredential=$null
 Pop-Location
}

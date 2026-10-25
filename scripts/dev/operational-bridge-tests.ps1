param([ValidateSet('unit','integration','demo','browser','regression')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$bridgeRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $bridgeRepo
$bridgePrior=@{}
$bridgeNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK')} | ForEach-Object {$_.Name})
$bridgeNames+=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIFECYCLE_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
foreach($bridgeKey in ($bridgeNames|Select-Object -Unique)){
 $bridgePrior[$bridgeKey]=[Environment]::GetEnvironmentVariable($bridgeKey,'Process')
 [Environment]::SetEnvironmentVariable($bridgeKey,$null,'Process')
}
try {
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 # Literal entrypoints only: no recursive discovery, package test hooks or wallet suites.
 $bridgeFiles=@(switch($Action){
  'unit' {@('services/test-bridge/test/payment-status.test.mjs')}
  'integration' {@('db/test/operational-bridge.test.mjs')}
  'demo' {@('db/test/operational-bridge.test.mjs')}
  'browser' {@('apps/web/test/payment-request.test.mjs')}
  'regression' {@('packages/protocol/phase10/settlement.test.mjs','packages/protocol/phase10/ledger-commitment.test.mjs','services/lock/test/finalize.test.mjs','packages/protocol/phase12/preparation.test.mjs','services/claims/test/claim.test.mjs','services/resolution/test/prepare.test.mjs')}
 })
 if($Action -ne 'unit'){
  # Compile stateless decoders and synthetic address generation only. No wallet command.
  cargo build -p darkpool-zcash --bin darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
  if($LASTEXITCODE -ne 0){throw 'Stateless bridge prerequisites failed'}
 }
 & node apps/web/build-vault.mjs
 if($LASTEXITCODE -ne 0){throw 'Browser assets unavailable'}
 if($Action -in @('integration','demo')){
  $bridgeTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $bridgeCredential=Import-Clixml -LiteralPath (Join-Path $bridgeTestRoot 'maintenance.xml')
  if($bridgeCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$bridgeCredential.UserName
  $env:PGPASSWORD=$bridgeCredential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $bridgeTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:DARKPOOL_LIFECYCLE_TEST_ONLY='1'
 }
 $bridgeEvidence=Join-Path $bridgeRepo ('.tools/operational-bridge-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $bridgeEvidence|Out-Null
 $bridgeInputs=@($bridgeFiles)+@('services/test-bridge/payment-status.mjs','db/test/bridge-provision.mjs','db/test/lifecycle-fixtures.mjs','services/operations/commands.mjs','services/watcher/db.mjs','services/lock/finalize.mts','apps/web/src/issuance.mjs','apps/web/src/issuance-server.mjs','apps/web/src/issuance-client.mjs','apps/web/src/issuance-ui.mjs','apps/web/src/payment-status-wire.mjs','apps/web/src/issuance.html','apps/web/build-vault.mjs','scripts/dev/operational-bridge-tests.ps1')
 $bridgeHashes=@{}
 foreach($bridgeInput in ($bridgeInputs|Select-Object -Unique)){$bridgeHashes[$bridgeInput]=(Get-FileHash -LiteralPath $bridgeInput -Algorithm SHA256).Hash}
 $bridgeStart=[DateTime]::UtcNow.ToString('o')
 $bridgeTap=Join-Path $bridgeEvidence 'tests.tap.log'
 $bridgeArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+@($bridgeFiles)
 & node @bridgeArguments 2>&1 | Tee-Object -FilePath $bridgeTap
 $bridgeExit=$LASTEXITCODE
 $bridgeUnchanged=$true
 foreach($bridgeInput in $bridgeHashes.Keys){if((Get-FileHash -LiteralPath $bridgeInput -Algorithm SHA256).Hash -ne $bridgeHashes[$bridgeInput]){$bridgeUnchanged=$false}}
 $bridgeReceipt=[ordered]@{version=1;scope='SYNTHETIC_TEST_ONLY';action=$Action;started_utc=$bridgeStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$bridgeExit;inputs_unchanged=$bridgeUnchanged;test_files=@($bridgeFiles);source_sha256=$bridgeHashes;tap_sha256=(Get-FileHash -LiteralPath $bridgeTap -Algorithm SHA256).Hash;tap_encoding='PowerShell Tee-Object UTF-16LE';wallet_initialization_authorized=$false;financial_authorization=$false;publication='PENDING';protected_targets_accessed=$false}
 $bridgeReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $bridgeEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained bridge evidence: '+$bridgeEvidence)
 if($bridgeExit -ne 0 -or -not $bridgeUnchanged){throw 'Bridge tests failed or source changed'}
} finally {
 foreach($bridgeKey in $bridgePrior.Keys){[Environment]::SetEnvironmentVariable($bridgeKey,$bridgePrior[$bridgeKey],'Process')}
 $bridgeCredential=$null
 Pop-Location
}

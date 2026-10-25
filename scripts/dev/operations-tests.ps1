param([ValidateSet('unit','integration','regression')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$operationsRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $operationsRepo
$operationsPrior=@{}
$operationsNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK')} | ForEach-Object {$_.Name})
$operationsNames+=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIFECYCLE_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
foreach($operationsKey in ($operationsNames|Select-Object -Unique)){
 $operationsPrior[$operationsKey]=[Environment]::GetEnvironmentVariable($operationsKey,'Process')
 [Environment]::SetEnvironmentVariable($operationsKey,$null,'Process')
}
try {
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 $operationsFiles=@(switch($Action){
  'unit' {@('services/operations/test/commands.test.mjs')}
  'integration' {@('db/test/operations.test.mjs')}
  'regression' {@('packages/protocol/phase10/settlement.test.mjs','packages/protocol/phase10/ledger-commitment.test.mjs','services/lock/test/finalize.test.mjs','packages/protocol/phase12/preparation.test.mjs','services/claims/test/claim.test.mjs','services/resolution/test/prepare.test.mjs')}
 })
 if($Action -ne 'unit'){
  # Build only stateless synthetic address/decoder examples; never run a wallet CLI.
  cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
  if($LASTEXITCODE -ne 0){throw 'Stateless native prerequisites failed'}
 }
 if($Action -eq 'integration'){
  $operationsTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $operationsCredential=Import-Clixml -LiteralPath (Join-Path $operationsTestRoot 'maintenance.xml')
  if($operationsCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$operationsCredential.UserName
  $env:PGPASSWORD=$operationsCredential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $operationsTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:DARKPOOL_LIFECYCLE_TEST_ONLY='1'
 }
 $operationsEvidence=Join-Path $operationsRepo ('.tools/operations-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $operationsEvidence|Out-Null
 $operationsInputs=@($operationsFiles)+@('services/operations/commands.mjs','services/operations/cli.mjs','db/test/lifecycle-fixtures.mjs','scripts/dev/operations-tests.ps1')
 $operationsHashes=@{}
 foreach($operationsInput in ($operationsInputs|Select-Object -Unique)){$operationsHashes[$operationsInput]=(Get-FileHash -LiteralPath $operationsInput -Algorithm SHA256).Hash}
 $operationsStart=[DateTime]::UtcNow.ToString('o')
 $operationsTap=Join-Path $operationsEvidence 'tests.tap.log'
 $operationsArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+@($operationsFiles)
 & node @operationsArguments 2>&1 | Tee-Object -FilePath $operationsTap
 $operationsExit=$LASTEXITCODE
 $operationsUnchanged=$true
 foreach($operationsInput in $operationsHashes.Keys){if((Get-FileHash -LiteralPath $operationsInput -Algorithm SHA256).Hash -ne $operationsHashes[$operationsInput]){$operationsUnchanged=$false}}
 $operationsReceipt=[ordered]@{version=1;scope='SYNTHETIC_TEST_ONLY';action=$Action;started_utc=$operationsStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$operationsExit;inputs_unchanged=$operationsUnchanged;test_files=@($operationsFiles);source_sha256=$operationsHashes;tap_sha256=(Get-FileHash -LiteralPath $operationsTap -Algorithm SHA256).Hash;tap_encoding='PowerShell Tee-Object UTF-16LE';wallet_initialization_authorized=$false;financial_authorization=$false}
 $operationsReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $operationsEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained synthetic test evidence: '+$operationsEvidence)
 if($operationsExit -ne 0 -or -not $operationsUnchanged){throw 'Operational adapter tests failed or source changed'}
} finally {
 foreach($operationsKey in $operationsPrior.Keys){[Environment]::SetEnvironmentVariable($operationsKey,$operationsPrior[$operationsKey],'Process')}
 $operationsCredential=$null
 Pop-Location
}

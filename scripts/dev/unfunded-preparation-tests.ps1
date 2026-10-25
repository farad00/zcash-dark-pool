param([ValidateSet('unit','storage','regression')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$prepRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $prepRepo
$prepPrior=@{}
$prepNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK','ALLOCATION_AUTH','ALLOCATION_PORT','CHAIN_ENDPOINT')} | ForEach-Object {$_.Name})
$prepNames+=@('DARKPOOL_UNFUNDED_PREPARATION_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
foreach($prepKey in ($prepNames|Select-Object -Unique)){
 $prepPrior[$prepKey]=[Environment]::GetEnvironmentVariable($prepKey,'Process')
 [Environment]::SetEnvironmentVariable($prepKey,$null,'Process')
}
try {
 $env:DARKPOOL_UNFUNDED_PREPARATION_TEST_ONLY='1';$env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 # Literal allowlists only. No database credentials, runtime commands or test discovery.
 $prepFiles=@(switch($Action){
  'unit' {@('services/rehearsal-preparation/test/plan.test.mjs')}
  'storage' {@('services/rehearsal-preparation/test/storage.test.mjs')}
  'regression' {@('services/observation-bridge/test/preview.test.mjs','services/test-bridge/test/payment-status.test.mjs','packages/protocol/phase10/settlement.test.mjs','packages/protocol/phase10/ledger-commitment.test.mjs','services/lock/test/finalize.test.mjs','packages/protocol/phase12/preparation.test.mjs','services/claims/test/claim.test.mjs','services/resolution/test/prepare.test.mjs')}
 })
 if($Action -eq 'regression'){
  # Compile stateless address/decoder prerequisites only, then copy local browser assets.
  cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
  if($LASTEXITCODE -ne 0){throw 'Stateless prerequisites failed'}
  & node apps/web/build-vault.mjs
  if($LASTEXITCODE -ne 0){throw 'Browser assets unavailable'}
 }
 $prepEvidence=Join-Path $prepRepo ('.tools/unfunded-preparation-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $prepEvidence|Out-Null
 $prepInputs=@($prepFiles)+@('services/rehearsal-preparation/target.proposed.json','services/rehearsal-preparation/plan.mjs','services/rehearsal-preparation/review.mjs','services/rehearsal-preparation/fixture.mjs','scripts/dev/unfunded-storage-probe.ps1','scripts/dev/v2-security.ps1','scripts/dev/unfunded-preparation-tests.ps1')
 $prepHashes=@{}
 foreach($prepInput in ($prepInputs|Select-Object -Unique)){$prepHashes[$prepInput]=(Get-FileHash -LiteralPath $prepInput -Algorithm SHA256).Hash}
 $prepStart=[DateTime]::UtcNow.ToString('o')
 $prepTap=Join-Path $prepEvidence 'tests.tap.log'
 $prepArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+@($prepFiles)
 & node @prepArguments 2>&1 | Tee-Object -FilePath $prepTap
 $prepExit=$LASTEXITCODE
 $prepUnchanged=$true
 foreach($prepInput in $prepHashes.Keys){if((Get-FileHash -LiteralPath $prepInput -Algorithm SHA256).Hash -ne $prepHashes[$prepInput]){$prepUnchanged=$false}}
 $prepReceipt=[ordered]@{version=1;scope='OFFLINE_UNFUNDED_PREPARATION_ONLY';action=$Action;started_utc=$prepStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$prepExit;inputs_unchanged=$prepUnchanged;test_files=@($prepFiles);source_sha256=$prepHashes;tap_sha256=(Get-FileHash -LiteralPath $prepTap -Algorithm SHA256).Hash;tap_encoding='PowerShell Tee-Object UTF-16LE';sql_executed=$false;wallet_access=$false;actual_target_created=$false;financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}
 $prepReceipt|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $prepEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained unfunded preparation evidence: '+$prepEvidence)
 if($prepExit -ne 0 -or -not $prepUnchanged){throw 'Unfunded preparation tests failed or source changed'}
} finally {
 foreach($prepKey in $prepPrior.Keys){[Environment]::SetEnvironmentVariable($prepKey,$prepPrior[$prepKey],'Process')}
 Pop-Location
}

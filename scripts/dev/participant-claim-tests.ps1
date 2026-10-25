param([ValidateSet('unit','integration','regression')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$claimRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $claimRepo
$claimPrior=@{}
$claimNames=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG|^DARKPOOL_|^CLAIM_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK')} | ForEach-Object {$_.Name})
$claimNames+=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIFECYCLE_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
foreach($claimKey in ($claimNames|Select-Object -Unique)){
 $claimPrior[$claimKey]=[Environment]::GetEnvironmentVariable($claimKey,'Process')
 [Environment]::SetEnvironmentVariable($claimKey,$null,'Process')
}
try {
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 # Literal wallet-free allowlist; no discovery, npm chains or watcher regressions.
 $claimFiles=@(switch($Action){
  'unit' {@('apps/web/test/claim.test.mjs')}
  'integration' {@('db/test/participant-claims.test.mjs')}
  'regression' {@('packages/protocol/phase10/settlement.test.mjs','packages/protocol/phase10/ledger-commitment.test.mjs','services/lock/test/finalize.test.mjs','packages/protocol/phase12/preparation.test.mjs','services/claims/test/claim.test.mjs','services/resolution/test/prepare.test.mjs')}
 })
 # These examples decode or generate synthetic addresses in memory, never wallet files.
 cargo build -p darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Stateless prerequisites failed'}
 node apps/web/build-vault.mjs
 if($LASTEXITCODE -ne 0){throw 'Local static asset build failed'}
 if($Action -eq 'integration'){
  $claimTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $claimCredential=Import-Clixml -LiteralPath (Join-Path $claimTestRoot 'maintenance.xml')
  if($claimCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$claimCredential.UserName
  $env:PGPASSWORD=$claimCredential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $claimTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:DARKPOOL_LIFECYCLE_TEST_ONLY='1'
 }
 $claimEvidence=Join-Path $claimRepo ('.tools/participant-claim-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $claimEvidence|Out-Null
 $claimInputs=@($claimFiles)+@('services/claims/participant.mjs','services/claims/reserve.mjs','apps/web/src/claim-server.mjs','apps/web/src/claim-client.mjs','apps/web/src/claim-wire.mjs','apps/web/src/claim-ui.mjs','apps/web/src/claim.html','apps/web/src/claim-cli.mjs','apps/web/test/vault-browser.mjs','apps/web/build-vault.mjs','db/test/lifecycle-fixtures.mjs','scripts/dev/participant-claim-tests.ps1')
 $claimHashes=@{}
 foreach($claimInput in ($claimInputs|Select-Object -Unique)){$claimHashes[$claimInput]=(Get-FileHash -LiteralPath $claimInput -Algorithm SHA256).Hash}
 $claimStart=[DateTime]::UtcNow.ToString('o')
 $claimTap=Join-Path $claimEvidence 'tests.tap.log'
 $claimArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+@($claimFiles)
 & node @claimArguments 2>&1 | Tee-Object -FilePath $claimTap
 $claimExit=$LASTEXITCODE
 $claimUnchanged=$true
 foreach($claimInput in $claimHashes.Keys){if((Get-FileHash -LiteralPath $claimInput -Algorithm SHA256).Hash -ne $claimHashes[$claimInput]){$claimUnchanged=$false}}
 [ordered]@{version=1;scope='SYNTHETIC_TEST_ONLY';action=$Action;started_utc=$claimStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$claimExit;inputs_unchanged=$claimUnchanged;test_files=@($claimFiles);source_sha256=$claimHashes;tap_sha256=(Get-FileHash -LiteralPath $claimTap -Algorithm SHA256).Hash;tap_encoding='PowerShell Tee-Object UTF-16LE';wallet_initialization_authorized=$false;financial_authorization=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $claimEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained synthetic test evidence: '+$claimEvidence)
 if($claimExit -ne 0 -or -not $claimUnchanged){throw 'Participant claim tests failed or source changed'}
} finally {
 foreach($claimKey in $claimPrior.Keys){[Environment]::SetEnvironmentVariable($claimKey,$claimPrior[$claimKey],'Process')}
 $claimCredential=$null
 Pop-Location
}

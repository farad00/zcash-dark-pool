param([ValidateSet('Test','Demo','Regression')][string]$Action='Test')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$demoRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$saved=@{}
$names=@(Get-ChildItem Env:|Where-Object {$_.Name -match '^PG|^DARKPOOL_|^ALLOCATION_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK','NODE_OPTIONS','NODE_PATH')}|ForEach-Object Name)
$names+=@('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIFECYCLE_TEST_ONLY','DARKPOOL_SUBMISSION_DEMO','APP_ENV','ZCASH_NETWORK')
foreach($name in ($names|Select-Object -Unique)){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$null,'Process')}
Push-Location $demoRepo
try{
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet'
 cargo build -p darkpool-zcash --bin darkpool-zcash --example phase14-claim-fixture --example phase13-destination --example payment-request-fixture --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Stateless prerequisites unavailable'}
 & node node_modules/typescript/bin/tsc -p packages/protocol/tsconfig.json
 if($LASTEXITCODE -ne 0){throw 'Protocol build failed'}
 & node apps/web/build-vault.mjs
 if($LASTEXITCODE -ne 0){throw 'Browser build failed'}
 # Literal wallet-free suites only. Phase 7 issuance.test.mjs creates a wallet
 # fixture and is deliberately excluded; never discover suites with a wildcard.
 $files=@(if($Action -eq 'Regression'){@('packages/protocol/phase10/settlement.test.mjs','packages/protocol/phase10/ledger-commitment.test.mjs','services/lock/test/finalize.test.mjs','packages/protocol/phase12/preparation.test.mjs','services/claims/test/claim.test.mjs','services/resolution/test/prepare.test.mjs')}elseif($Action -eq 'Test'){@('scripts/demo/session.test.mjs','scripts/demo/ui.test.mjs','scripts/demo/participant-ui.test.mjs','apps/web/test/payment-request.test.mjs','apps/web/test/claim.test.mjs','scripts/demo/submission.test.mjs')}else{@('scripts/demo/submission.test.mjs')})
 if($Action -ne 'Regression'){
  $root=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $credential=Import-Clixml -LiteralPath (Join-Path $root 'maintenance.xml')
  if($credential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity rejected'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$credential.UserName;$env:PGPASSWORD=$credential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $root 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:DARKPOOL_LIFECYCLE_TEST_ONLY='1'
  $env:DARKPOOL_SUBMISSION_DEMO=if($Action -eq 'Demo'){'INTERACTIVE'}else{'AUTOMATED'}
 }
 $receiptRoot=Join-Path $demoRepo ('.tools/submission-demo-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $receiptRoot|Out-Null
 $inputs=@('scripts/demo/product.mjs','scripts/demo/session.mjs','scripts/demo/submission.test.mjs','scripts/demo/context.mjs','scripts/demo/index.html','scripts/demo/style.css','scripts/demo/ui.mjs','scripts/dev/submission-demo.ps1','db/test/lifecycle-fixtures.mjs','db/issuance-runtime.mjs')+@($files)
 $inputs+=@('apps/web/src/issuance.html','apps/web/src/issuance-ui.mjs','apps/web/src/payment-status-wire.mjs','apps/web/src/payment-ui.mjs','apps/web/src/public-market.mjs','apps/web/src/public-server.mjs')
 $inputs+=@('apps/web/src/issuance-client.mjs','apps/web/src/claim-ui.mjs','apps/web/src/claim.html','apps/web/src/vault.css','apps/web/src/local-vault.mjs','apps/web/src/claim-client.mjs','apps/web/src/claim-wire.mjs','apps/web/build-vault.mjs')
 $hashes=@{};foreach($p in ($inputs|Select-Object -Unique)){$hashes[$p]=(Get-FileHash -LiteralPath $p).Hash}
 $tap=Join-Path $receiptRoot 'tests.tap.log'
 & node --test --test-concurrency=1 --test-reporter=tap @files 2>&1|Tee-Object -FilePath $tap
 $code=$LASTEXITCODE;$unchanged=$true
 foreach($p in $hashes.Keys){if((Get-FileHash -LiteralPath $p).Hash -cne $hashes[$p]){$unchanged=$false}}
 [ordered]@{scope='SYNTHETIC_TEST_ONLY';action=$Action;node_exit=$code;inputs_unchanged=$unchanged;source_sha256=$hashes;test_files=$files;tap_sha256=(Get-FileHash -LiteralPath $tap).Hash;financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE';genuine_payments=$false;wallet_initialization=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $receiptRoot 'receipt.json') -Encoding UTF8
 Write-Output ('Retained submission evidence: '+$receiptRoot)
 if($code -ne 0 -or -not $unchanged){throw 'Demo not confirmed; preserve evidence and inspect cleanup'}
}finally{foreach($name in $saved.Keys){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')};$credential=$null;Pop-Location}

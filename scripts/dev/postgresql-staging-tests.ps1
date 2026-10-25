param()
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $repo
$saved=@{}
$keys=@(Get-ChildItem Env:|Where-Object {$_.Name -match '^PG|^DARKPOOL_|^ALLOCATION_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','CHAIN_ENDPOINT','NODE_OPTIONS','NODE_PATH')}|ForEach-Object {$_.Name})+@('DARKPOOL_PG_STAGE_TEST_ONLY')
foreach($k in ($keys|Select-Object -Unique)){$saved[$k]=[Environment]::GetEnvironmentVariable($k,'Process');[Environment]::SetEnvironmentVariable($k,$null,'Process')}
try{
 $env:DARKPOOL_PG_STAGE_TEST_ONLY='1'
 $files=@('services/rehearsal-preparation/postgresql-tools/test/staging.test.mjs','services/rehearsal-preparation/observation-v1/test/policy.test.mjs')
 $inputs=@(rg --files services/rehearsal-preparation/postgresql-tools)+@('scripts/dev/postgresql-staging-core.ps1','scripts/dev/postgresql-staging.ps1','scripts/dev/postgresql-staging-tests.ps1','scripts/dev/observation-v1-preflight.ps1','services/rehearsal-preparation/observation-v1/tools.mjs')+@($files)
 $hashes=@{};foreach($p in ($inputs|Select-Object -Unique)){$hashes[$p]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash}
 $evidence=Join-Path $repo ('.tools/postgresql-staging-tests/'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $evidence|Out-Null
 $tap=Join-Path $evidence 'tests.tap.log';$start=[DateTime]::UtcNow.ToString('o')
 & node --test --test-concurrency=1 --test-reporter=tap @files 2>&1|Tee-Object -FilePath $tap
 $code=$LASTEXITCODE;$unchanged=$true
 foreach($p in $hashes.Keys){if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -cne $hashes[$p]){$unchanged=$false}}
 [ordered]@{version=1;scope='DISPOSABLE_STAGING_PREPARATION_ONLY';started_utc=$start;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$code;inputs_unchanged=$unchanged;source_sha256=$hashes;test_files=$files;tap_sha256=(Get-FileHash -LiteralPath $tap -Algorithm SHA256).Hash;tap_encoding='UTF-16LE';actual_destination_created=$false;binary_execution=$false;sql=$false;network=$false;financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $evidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained PostgreSQL staging evidence: '+$evidence)
 if($code -ne 0 -or -not $unchanged){throw 'Disposable staging tests failed'}
}finally{foreach($k in $saved.Keys){[Environment]::SetEnvironmentVariable($k,$saved[$k],'Process')};Pop-Location}

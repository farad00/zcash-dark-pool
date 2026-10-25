param([ValidateSet('unit','integration','bootstrap','security')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$obRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$obSaved=@{}
$obKeys=@(Get-ChildItem Env:|Where-Object {$_.Name -match '^PG|^DARKPOOL_|^ALLOCATION_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','CHAIN_ENDPOINT','NODE_OPTIONS','NODE_PATH')}|ForEach-Object {$_.Name})
$obKeys+=@('DARKPOOL_OBSERVATION_V1_TEST_ONLY','DARKPOOL_BACKUP_TEST_ONLY','DARKPOOL_PHYSICAL_REHEARSAL','DARKPOOL_PG_ENV','DARKPOOL_TEST_ONLY')
foreach($key in ($obKeys|Select-Object -Unique)){$obSaved[$key]=[Environment]::GetEnvironmentVariable($key,'Process');[Environment]::SetEnvironmentVariable($key,$null,'Process')}
Push-Location $obRepo
try{
 $env:DARKPOOL_OBSERVATION_V1_TEST_ONLY='1';$env:DARKPOOL_BACKUP_TEST_ONLY='1';$env:DARKPOOL_PHYSICAL_REHEARSAL='1';$env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
 # No test discovery, dependency-script invocation, native wallet suite or retained profile.
 $files=@(switch($Action){'unit'{@('services/rehearsal-preparation/observation-v1/test/policy.test.mjs','services/rehearsal-preparation/observation-v1/test/bootstrap-policy.test.mjs')};'integration'{'services/rehearsal-preparation/observation-v1/test/integration.test.mjs'};'bootstrap'{'services/rehearsal-preparation/observation-v1/test/bootstrap-integration.test.mjs'};'security'{@('services/rehearsal-preparation/observation-v1/test/windows-security.test.mjs','services/rehearsal-preparation/observation-v1/test/computer-b-recovery.test.mjs','services/rehearsal-preparation/observation-v1/test/native-windows.test.mjs')}})
 $inputs=@(rg --files services/rehearsal-preparation/observation-v1)+@('services/rehearsal-preparation/plan.mjs','services/rehearsal-preparation/target.proposed.json','services/backup/physical.mjs','services/backup/crypto.mjs','scripts/dev/backup-fixture-storage.ps1','scripts/dev/physical-backup-storage.ps1','scripts/dev/v2-security.ps1','scripts/dev/observation-v1-preflight.ps1','scripts/dev/observation-v1-tests.ps1','scripts/dev/observation-v1-bootstrap.ps1','scripts/dev/observation-bootstrap-dpapi-probe.ps1','scripts/dev/observation-windows-access.cs','scripts/dev/observation-windows-security.ps1','scripts/dev/observation-native-windows.cs','scripts/dev/observation-native-windows.ps1','scripts/dev/observation-computer-b-review.ps1')
 $hashes=@{};foreach($p in $inputs){$hashes[$p]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash}
 $evidence=Join-Path $obRepo ('.tools/observation-v1-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $evidence|Out-Null
 $tap=Join-Path $evidence 'tests.tap.log';$start=[DateTime]::UtcNow.ToString('o')
 & node --test --test-concurrency=1 --test-reporter=tap @files 2>&1|Tee-Object -FilePath $tap
 $code=$LASTEXITCODE;$unchanged=$true
 foreach($p in $hashes.Keys){if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne $hashes[$p]){$unchanged=$false}}
 [ordered]@{version=1;scope='OBSERVATION_V1_DISPOSABLE_ONLY';action=$Action;started_utc=$start;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$code;inputs_unchanged=$unchanged;source_sha256=$hashes;test_files=$files;tap_sha256=(Get-FileHash -LiteralPath $tap -Algorithm SHA256).Hash;tap_encoding='UTF-16LE';retained_database_access=$false;persistent_target_created=$false;wallet_access=$false;external_network=$false;financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $evidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained observation V1 evidence: '+$evidence)
 if($code -ne 0 -or -not $unchanged){throw 'Observation V1 disposable tests failed'}
}finally{
 foreach($key in $obSaved.Keys){[Environment]::SetEnvironmentVariable($key,$obSaved[$key],'Process')}
 Pop-Location
}

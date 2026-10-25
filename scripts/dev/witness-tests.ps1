$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$witnessTestRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $witnessTestRepo
$witnessPrevious=[Environment]::GetEnvironmentVariable('DARKPOOL_PUBLICATION_OPENSSL','Process')
try {
 $env:DARKPOOL_PUBLICATION_OPENSSL='C:\Program Files\Git\usr\bin\openssl.exe'
 # Literal wallet-free suites only; no discovery, npm hooks, or operational capture.
 $witnessTestFiles=@('tools/commitment-witness/test/synthetic-capture.test.mjs','tools/commitment-witness/test/operational.test.mjs','tools/commitment-witness/test/witness.test.mjs','services/publication/test/verify.test.mjs')
 $witnessTestFiles+=@('tools/commitment-witness/test/diagnostic.test.mjs')
 $witnessTestFiles+=@('tools/commitment-witness/test/node-version.test.mjs')
 $witnessTestFiles+=@('tools/commitment-witness/test/synthetic-signing.test.mjs')
 $witnessTestFiles+=@('tools/commitment-witness/test/artifact-timestamp.test.mjs')
 $witnessInputs=$witnessTestFiles+@(Get-ChildItem -LiteralPath tools/commitment-witness -File | ForEach-Object {$_.FullName})+@('services/publication/profile.mjs','services/publication/github.mjs','services/publication/github-receipt.mjs','services/publication/http.mjs','services/publication/verify.mjs','services/publication/openssl.mjs','services/publication/tst-policy.mjs','services/publication/rfc3161.mjs','services/publication/test/fixtures.mjs','services/publication/test/github-fixtures.mjs','scripts/dev/witness-tests.ps1')
 $witnessInputs+=@('tools/commitment-witness/test/capture-fixture.mjs','services/publication/freetsa-testnet.proposed.json','services/publication/witness-public.json')
 $witnessInputs+=@(Get-ChildItem -LiteralPath tools/commitment-witness/synthetic -File | ForEach-Object {$_.FullName})
 $witnessHashes=@{};foreach($witnessInput in $witnessInputs){$witnessHashes[$witnessInput]=(Get-FileHash -LiteralPath $witnessInput -Algorithm SHA256).Hash}
 $witnessEvidence=Join-Path $witnessTestRepo ('.tools/witness-tests/'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $witnessEvidence|Out-Null
 $witnessStart=[DateTime]::UtcNow.ToString('o');$witnessTap=Join-Path $witnessEvidence 'tests.tap.log'
 $witnessArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+$witnessTestFiles
 & node @witnessArguments 2>&1|Tee-Object -FilePath $witnessTap
 $witnessExit=$LASTEXITCODE;$witnessUnchanged=$true
 foreach($witnessInput in $witnessHashes.Keys){if((Get-FileHash -LiteralPath $witnessInput -Algorithm SHA256).Hash -ne $witnessHashes[$witnessInput]){$witnessUnchanged=$false}}
 [ordered]@{scope='SYNTHETIC_WITNESS_ONLY';started_utc=$witnessStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$witnessExit;inputs_unchanged=$witnessUnchanged;source_sha256=$witnessHashes;test_files=$witnessTestFiles;tap_sha256=(Get-FileHash -LiteralPath $witnessTap -Algorithm SHA256).Hash;external_requests_authorized=$false;real_witness_key_or_signature_created=$false;financial_authorization=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $witnessEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained synthetic witness evidence: '+$witnessEvidence)
 if($witnessExit -ne 0 -or -not $witnessUnchanged){throw 'Witness tests failed or source changed'}
}finally{[Environment]::SetEnvironmentVariable('DARKPOOL_PUBLICATION_OPENSSL',$witnessPrevious,'Process');Pop-Location}

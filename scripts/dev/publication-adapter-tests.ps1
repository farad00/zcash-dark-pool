$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$publisherRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $publisherRepo
$publisherPrevious=[Environment]::GetEnvironmentVariable('DARKPOOL_PUBLICATION_OPENSSL','Process')
try {
 $env:DARKPOOL_PUBLICATION_OPENSSL='C:\Program Files\Git\usr\bin\openssl.exe'
 if(-not(Test-Path -LiteralPath $env:DARKPOOL_PUBLICATION_OPENSSL -PathType Leaf)){throw 'Pinned OpenSSL unavailable'}
 # Explicit mock/offline verifier files only. No npm chain, SQL, wallet or Git commands.
 $publisherFiles=@('services/publication/test/github-destination.test.mjs','services/publication/test/github.test.mjs','services/publication/test/verify.test.mjs','services/publication/test/hardening.test.mjs','services/publication/test/witness-public.test.mjs')
 $publisherInputs=$publisherFiles+@('services/publication/http.mjs','services/publication/github.mjs','services/publication/github-receipt.mjs','services/publication/profile.mjs','services/publication/verify.mjs','services/publication/openssl.mjs','services/publication/tst-policy.mjs','services/publication/rfc3161.mjs','services/publication/test/fixtures.mjs','services/publication/test/github-fixtures.mjs','services/publication/github-destination.json','scripts/dev/publication-repository-readonly.mjs','scripts/dev/publication-adapter-tests.ps1')
 $publisherInputs+=@('tools/commitment-witness/verify-timestamp.mjs','services/publication/freetsa-testnet.proposed.json','services/publication/witness-public.json')+@(Get-ChildItem -LiteralPath services/publication/test/public-freetsa -File | ForEach-Object {$_.FullName})
 $publisherHashes=@{}
 foreach($publisherInput in $publisherInputs){$publisherHashes[$publisherInput]=(Get-FileHash -LiteralPath $publisherInput -Algorithm SHA256).Hash}
 $publisherEvidence=Join-Path $publisherRepo ('.tools/publication-adapter-tests/'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $publisherEvidence|Out-Null
 $publisherStart=[DateTime]::UtcNow.ToString('o')
 $publisherTap=Join-Path $publisherEvidence 'tests.tap.log'
 $publisherArguments=@('--test','--test-concurrency=1','--test-reporter=tap')+$publisherFiles
 & node @publisherArguments 2>&1 | Tee-Object -FilePath $publisherTap
 $publisherExit=$LASTEXITCODE
 $publisherUnchanged=$true
 foreach($publisherInput in $publisherHashes.Keys){if((Get-FileHash -LiteralPath $publisherInput -Algorithm SHA256).Hash -ne $publisherHashes[$publisherInput]){$publisherUnchanged=$false}}
 [ordered]@{version=1;scope='MOCKED_EXTERNAL_AND_SYNTHETIC_CRYPTO_ONLY';started_utc=$publisherStart;ended_utc=[DateTime]::UtcNow.ToString('o');node_exit=$publisherExit;inputs_unchanged=$publisherUnchanged;test_files=$publisherFiles;source_sha256=$publisherHashes;tap_sha256=(Get-FileHash -LiteralPath $publisherTap -Algorithm SHA256).Hash;openssl_sha256=(Get-FileHash -LiteralPath $env:DARKPOOL_PUBLICATION_OPENSSL -Algorithm SHA256).Hash;external_writes_authorized=$false;financial_authorization=$false;wallet_initialization_authorized=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $publisherEvidence 'receipt.json') -Encoding UTF8
 Write-Output ('Retained mock/synthetic evidence: '+$publisherEvidence)
 if($publisherExit -ne 0 -or -not $publisherUnchanged){throw 'Publication adapter tests failed or source changed'}
} finally {
 [Environment]::SetEnvironmentVariable('DARKPOOL_PUBLICATION_OPENSSL',$publisherPrevious,'Process')
 Pop-Location
}

$ErrorActionPreference='Stop'
$witnessRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$witnessOutput=Join-Path $witnessRepo ('.tools/witness-standalone/'+[Guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $witnessOutput){throw 'Fresh export directory required'}
$witnessFiles=@('tools/commitment-witness/core.mjs','tools/commitment-witness/store.mjs','tools/commitment-witness/cli.mjs','tools/commitment-witness/storage.ps1','tools/commitment-witness/witness.ps1','tools/commitment-witness/verify-public.mjs','tools/commitment-witness/config.example.json','tools/commitment-witness/README.md','tools/commitment-witness/operational.mjs','tools/commitment-witness/clock-cli.mjs','tools/commitment-witness/synthetic.mjs','tools/commitment-witness/synthetic/envelope.json','tools/commitment-witness/synthetic/github-destination.json','tools/commitment-witness/synthetic/witness-config.proposed.json','services/publication/profile.mjs','services/publication/github.mjs','services/publication/github-receipt.mjs','services/publication/http.mjs','services/publication/verify.mjs','services/publication/openssl.mjs','services/publication/tst-policy.mjs','services/publication/rfc3161.mjs','services/publication/github-destination.json')
$witnessFiles+=@('tools/commitment-witness/diagnose-capture.mjs','tools/commitment-witness/diagnose-capture.ps1')
$witnessFiles+=@('tools/commitment-witness/synthetic-signing.mjs')
$witnessFiles+=@('tools/commitment-witness/check-signing-config.mjs')
$witnessFiles+=@('tools/commitment-witness/artifact-query.mjs','tools/commitment-witness/artifact-rfc3161.mjs','tools/commitment-witness/artifact-timestamp.mjs','tools/commitment-witness/artifact-cli.mjs','tools/commitment-witness/artifact-timestamp.ps1','tools/commitment-witness/artifact-trust.example.json','tools/commitment-witness/ARTIFACT_TIMESTAMP.md')
New-Item -ItemType Directory -Path $witnessOutput|Out-Null
$witnessManifest=[ordered]@{}
foreach($witnessRelative in $witnessFiles){
 $witnessSource=Join-Path $witnessRepo $witnessRelative
 $witnessTarget=Join-Path $witnessOutput $witnessRelative
 New-Item -ItemType Directory -Path (Split-Path -Parent $witnessTarget) -Force|Out-Null
 Copy-Item -LiteralPath $witnessSource -Destination $witnessTarget
 $witnessHash=(Get-FileHash -LiteralPath $witnessSource -Algorithm SHA256).Hash
 if((Get-FileHash -LiteralPath $witnessTarget -Algorithm SHA256).Hash -ne $witnessHash){throw 'Export mismatch'}
 $witnessManifest[$witnessRelative]=$witnessHash
}
$witnessManifest|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $witnessOutput 'SHA256SUMS.json') -Encoding UTF8
Write-Output ('Source-only standalone package: '+$witnessOutput)
Write-Output ('Manifest SHA256: '+(Get-FileHash -LiteralPath (Join-Path $witnessOutput 'SHA256SUMS.json') -Algorithm SHA256).Hash)

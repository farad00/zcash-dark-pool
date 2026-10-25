param(
 [ValidateSet('check','prepare','submit','verify')][string]$Action,
 [Parameter(Mandatory=$true)][string]$Config,
 [string]$Trust='-', [string]$TrustSha256='-',
 [string]$ClockA='-', [string]$ClockB='-',
 [switch]$SubmitSyntheticArtifactTsaOnce
)
$ErrorActionPreference='Stop'
foreach($artifactVariable in @('NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_PATH','NODE_TLS_REJECT_UNAUTHORIZED','NODE_TEST_CONTEXT','DARKPOOL_SYNTHETIC_CAPTURE_TEST')){
 if([Environment]::GetEnvironmentVariable($artifactVariable,'Process')){throw 'Unexpected Node environment; STOP'}
}
$artifactKnown=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if(-not $artifactKnown -or $env:LOCALAPPDATA -ne $artifactKnown){throw 'State identity mismatch; STOP'}
if($Action -ne 'check' -and ($Trust -eq '-' -or $TrustSha256 -eq '-' -or $ClockA -eq '-' -or $ClockB -eq '-')){throw 'Separate approved artifact trust and fresh A/B reports required; STOP'}
if($Action -eq 'submit' -and -not $SubmitSyntheticArtifactTsaOnce){throw 'Separate explicit one-submission approval required; STOP'}
if($Action -ne 'submit' -and $SubmitSyntheticArtifactTsaOnce){throw 'Submission approval is only valid for submit; STOP'}
$artifactPowerShell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
& $artifactPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'storage.ps1') -Action check
if($LASTEXITCODE -ne 0){throw 'Storage/ACL prerequisite failed; STOP'}
$artifactApproval='NO_SUBMISSION_APPROVAL'
if($Action -eq 'submit'){$artifactApproval='SUBMIT_SYNTHETIC_ARTIFACT_TSA_ONCE'}
& node.exe (Join-Path $PSScriptRoot 'artifact-cli.mjs') $Action $Config $Trust $TrustSha256 $ClockA $ClockB $artifactApproval
if($LASTEXITCODE -ne 0){throw 'Artifact operation not confirmed; retain every file and marker. Do not retry.'}

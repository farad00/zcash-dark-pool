param(
 [ValidateSet('init-key','public-key','capture','sign','query','timestamp','verify','export')][string]$Action,
 [Parameter(Mandatory=$true)][string]$Config,
 [string]$Request='-', [string]$Record='-',
 [string]$ClockA='-', [string]$ClockB='-',
 [switch]$CommonControlAcknowledged,[switch]$SubmitTsaAcknowledged
)
$ErrorActionPreference='Stop'
if(-not $CommonControlAcknowledged){throw 'Acknowledge common human control; this is not independent third-party attestation'}
if($Action -eq 'timestamp' -and -not $SubmitTsaAcknowledged){throw 'Explicit TSA submission acknowledgement required'}
$witnessAcknowledgement='COMMON_CONTROL_ACKNOWLEDGED'
if($Action -eq 'timestamp'){$witnessAcknowledgement='COMMON_CONTROL_AND_TSA_SUBMISSION_ACKNOWLEDGED'}
if($Action -notin @('init-key','public-key') -and $ClockB -eq '-'){throw 'Fresh Computer B clock directory required'}
if($Action -in @('timestamp','verify','export') -and $ClockA -eq '-'){throw 'Fresh Computer A clock directory required'}
& node (Join-Path $PSScriptRoot 'cli.mjs') $Action $Config $Request $Record $witnessAcknowledgement $ClockA $ClockB
if($LASTEXITCODE -ne 0){throw 'Witness operation not confirmed; preserve original archive for review'}

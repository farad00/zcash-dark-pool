[CmdletBinding()]
param([ValidateSet('Plan','Create')][string]$Action='Plan')
$ErrorActionPreference='Stop'
try {
 if($args.Count -ne 0){throw 'fixed arguments only'}
 $repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
 $node=Join-Path $repo '.tools/node-v24.21.0-win-x64/node.exe'
 # This entrypoint invokes only the inert planner. Create has a hard release gate.
 & $node (Join-Path $repo 'services/rehearsal-preparation/observation-v1/bootstrap-cli.mjs') $Action.ToLowerInvariant()
 exit $LASTEXITCODE
}catch{
 [ordered]@{status='BOOTSTRAP_BLOCKED';reason='PERSISTENT_EXECUTION_NOT_APPROVED';persistent_created=$false;financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Compress
 exit 1
}

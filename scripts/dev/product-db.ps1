param([ValidateSet('migrate','test','test-admin','test-public','test-issuance','provision-admin','provision-public','provision-issuance','verify')][string]$Action = 'migrate', [string]$OperatorRole)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/activate.ps1"
$isolatedRepo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Action -like 'test*') {
  & "$PSScriptRoot/phase9-tests.ps1" -Action regressions
} elseif ($Action -eq 'migrate') {
  & node (Join-Path $isolatedRepo 'db/migrate.mjs')
} elseif ($Action -like 'provision-*') {
  $module = $Action.Substring('provision-'.Length)
  & node (Join-Path $isolatedRepo "db/$module-provision.mjs") $OperatorRole
} else {
  throw 'Use the guarded schema runner with an explicit isolated profile for operational verification; no implicit database is selected.'
}
if ($LASTEXITCODE -ne 0) { throw 'Isolated database command failed' }
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('TEST','LIVE_EVIDENCE')][string]$Kind, [ValidateSet('phase9_payment_v1','phase9_payment_v2')][string]$Instance, [switch]$Plan, [switch]$Create, [switch]$CompleteOnly, [switch]$Worker)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/activate.ps1"
$isolatedRepo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$boundedRunner = Join-Path $PSScriptRoot 'run-bounded.mjs'
$planArguments = @((Join-Path $isolatedRepo 'scripts/dev/target-plan.mjs'),$Kind)
if ($Instance) { $planArguments += $Instance }
$planText = & node @planArguments
if ($LASTEXITCODE -ne 0) { throw 'Approved target identity required' }
$targetPlan = $planText | ConvertFrom-Json
if ($Plan -or ($Kind -eq 'LIVE_EVIDENCE' -and -not $Create -and -not $CompleteOnly)) {
  if ($Create -or $CompleteOnly) { throw 'Plan cannot execute' }
  Write-Output $planText
  exit 0
}
function Invoke-IsolatedStage {
  param([string]$Stage,[int]$TimeoutMs,[string]$Executable,[string[]]$StageArguments,[switch]$AllowInheritedOutputAfterExit)
  $runnerArguments = @($Stage,[string]$TimeoutMs)
  if ($AllowInheritedOutputAfterExit) { $runnerArguments += '--allow-inherited-output-after-exit' }
  $runnerArguments += $Executable
  $runnerArguments += $StageArguments
  & node $boundedRunner @runnerArguments
  $stageExitCode = $LASTEXITCODE
  if ($stageExitCode -ne 0) { throw "Isolated stage failed: $Stage ($stageExitCode)" }
}
if (-not $Worker) {
  $workerArguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Kind',$Kind,'-Worker')
  if ($Instance) { $workerArguments += @('-Instance',$Instance) }
  if ($Create) { $workerArguments += '-Create' }
  $wholeTimeout = 180000
  if ($CompleteOnly) { $workerArguments += '-CompleteOnly'; $wholeTimeout = 15000 }
  Invoke-IsolatedStage 'initializer' $wholeTimeout 'powershell.exe' $workerArguments -AllowInheritedOutputAfterExit:(-not $CompleteOnly)
  exit
}
$isolatedRoot = [string]$targetPlan.root
$isolatedPort = [int]$targetPlan.port
$isolatedUser = [string]$targetPlan.maintenance_user
if ($CompleteOnly) {
  if ($targetPlan.preserved) { throw 'Preserved LIVE evidence cannot be completed or rewritten' }
  # Normal completion stage for either environment; no creation, restart or SQL mutation.
  if ($env:DARKPOOL_PG_ENV -ne $Kind -or $env:PGPORT -ne [string]$isolatedPort -or $env:PGUSER -ne $isolatedUser -or $env:PGDATABASE -ne 'postgres' -or $env:DARKPOOL_PG_PROFILE -ne (Join-Path $isolatedRoot 'profile.json')) { throw 'Explicit isolated completion environment required' }
  Invoke-IsolatedStage 'completion' 10000 'node' @((Join-Path $isolatedRepo 'db/environment-bootstrap.mjs'),'complete')
  Write-Output "PASS: $Kind isolated initialization completion recorded on $isolatedPort"
  exit
}
if (Test-Path -LiteralPath $isolatedRoot) { throw 'Isolated root already exists; refusing reuse or retry' }
if ($targetPlan.preserved) { throw 'Preserved LIVE identity cannot be initialized' }
if ([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains $isolatedPort) { throw 'Isolated port occupied' }
$versionStage = @(Invoke-IsolatedStage 'version' 5000 'postgres' @('--version'))
$versionStage | Write-Output
if (-not ($versionStage -match '^postgres \(PostgreSQL\) 18\.6$')) { throw 'PostgreSQL 18.6 required' }
New-Item -ItemType Directory -Path $isolatedRoot | Out-Null
$isolatedAcl = New-Object System.Security.AccessControl.DirectorySecurity
$isolatedAcl.SetAccessRuleProtection($true, $false)
$isolatedSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($sid in @($isolatedSid, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $isolatedAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $isolatedRoot -AclObject $isolatedAcl
$isolatedData = Join-Path $isolatedRoot 'data'
$isolatedPwFile = Join-Path $isolatedRoot 'init-password.tmp'
$isolatedPrevious = @{}
foreach ($name in @('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')) {
  $isolatedPrevious[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes); $rng.Dispose()
  $password = [Convert]::ToBase64String($bytes)
  $credential = New-Object System.Management.Automation.PSCredential($isolatedUser, (ConvertTo-SecureString $password -AsPlainText -Force))
  $credential | Export-Clixml -LiteralPath (Join-Path $isolatedRoot 'maintenance.xml')
  [System.IO.File]::WriteAllText($isolatedPwFile, $password, [System.Text.Encoding]::ASCII)
  Invoke-IsolatedStage 'initdb' 60000 'initdb' @('-D',$isolatedData,'-U',$isolatedUser,'--auth-host=scram-sha-256','--auth-local=scram-sha-256',"--pwfile=$isolatedPwFile",'--encoding=UTF8','--locale=C')
  Remove-Item -LiteralPath $isolatedPwFile -Force
  $isolatedConfig = @"

# Explicit isolated environment: $Kind
listen_addresses = '127.0.0.1'
port = $isolatedPort
timezone = 'UTC'
log_timezone = 'UTC'
password_encryption = 'scram-sha-256'
log_statement = 'none'
log_min_error_statement = 'panic'
log_error_verbosity = 'terse'
log_connections = ''
log_disconnections = off
"@
  [System.IO.File]::AppendAllText((Join-Path $isolatedData 'postgresql.conf'), $isolatedConfig, (New-Object System.Text.UTF8Encoding($false)))
  $env:PGHOST='127.0.0.1'; $env:PGPORT=[string]$isolatedPort; $env:PGUSER=$isolatedUser; $env:PGDATABASE='postgres'
  $env:PGPASSWORD=$password; $password=$null
  $env:DARKPOOL_PG_ENV=$Kind; $env:DARKPOOL_PG_PROFILE=Join-Path $isolatedRoot 'profile.json'
  if ($Kind -eq 'LIVE_EVIDENCE') { $env:DARKPOOL_LIVE_INSTANCE=$Instance } else { Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue }
  if ($Kind -eq 'TEST') { $env:DARKPOOL_TEST_ONLY='TEST_ONLY' } else { Remove-Item Env:DARKPOOL_TEST_ONLY -ErrorAction SilentlyContinue }
  Invoke-IsolatedStage 'profile' 10000 'node' @((Join-Path $isolatedRepo 'db/environment-bootstrap.mjs'),'profile')
  Invoke-IsolatedStage 'server-start' 30000 'pg_ctl' @('-D',$isolatedData,'-l',(Join-Path $isolatedRoot 'postgres.log'),'-t','20','-w','start') -AllowInheritedOutputAfterExit
  Invoke-IsolatedStage 'marker' 20000 'node' @((Join-Path $isolatedRepo 'db/environment-bootstrap.mjs'),'initialize-marker')
  Invoke-IsolatedStage 'completion' 10000 'node' @((Join-Path $isolatedRepo 'db/environment-bootstrap.mjs'),'complete')
  Write-Output "PASS: $Kind fresh isolated PostgreSQL initialized on $isolatedPort"
} finally {
  if (Test-Path -LiteralPath $isolatedPwFile) { Remove-Item -LiteralPath $isolatedPwFile -Force }
  foreach ($name in $isolatedPrevious.Keys) { [Environment]::SetEnvironmentVariable($name, $isolatedPrevious[$name], 'Process') }
}

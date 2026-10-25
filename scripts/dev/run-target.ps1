[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('phase9_payment_v1','phase9_payment_v2')][string]$Instance,
  [Parameter(Mandatory=$true)][ValidateSet('admin','issuer','watcher','public','migrate')][string]$Action,
  [switch]$Run
)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$repoTargetRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$targetText=& node (Join-Path $PSScriptRoot 'target-plan.mjs') LIVE_EVIDENCE $Instance
if($LASTEXITCODE -ne 0){throw 'Approved target rejected'}
$target=$targetText | ConvertFrom-Json
$role=@{admin='admin';issuer='issue';watcher='watch';public='read';migrate='owner'}[$Action]
$entry=@{admin='apps/web/src/admin-cli.mjs';issuer='apps/web/src/issuance-cli.mjs';watcher='services/watcher/main.mjs';public='apps/web/src/server.mjs';migrate='db/migrate.mjs'}[$Action]
if($target.preserved -and $Action -ne 'public'){throw 'Preserved LIVE evidence is read-only'}
$credentialPath=Join-Path ([string]$target.root) ($role+'.xml')
if(-not $Run){
  [ordered]@{environment='LIVE_EVIDENCE';instance=$Instance;action=$Action;port=$target.port;database=$target.database;role=$target.roles.$role;credential_path=$credentialPath;entrypoint=$entry;resource_creation=$false} | ConvertTo-Json -Compress
  exit 0
}
# Execution is a separate operator action. No credential is created or copied.
$credentialItem=Get-Item -LiteralPath $credentialPath
if(($credentialItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Credential redirect rejected'}
$credential=Import-Clixml -LiteralPath $credentialPath
if($credential.UserName -ne [string]$target.roles.$role){throw 'Selected target credential identity rejected'}
$launchEnvironment=@{PGHOST='127.0.0.1';PGPORT=[string]$target.port;PGDATABASE=[string]$target.database;PGUSER=$credential.UserName;PGPASSWORD=$credential.GetNetworkCredential().Password;DARKPOOL_PG_ENV='LIVE_EVIDENCE';DARKPOOL_LIVE_INSTANCE=$Instance;DARKPOOL_PG_PROFILE=[string]$target.profile;APP_ENV='development';ZCASH_NETWORK='testnet'}
foreach($name in @('PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA')){
  $value=[Environment]::GetEnvironmentVariable($name,'Process');if($null -ne $value){$launchEnvironment[$name]=$value}
}
if($Action -eq 'admin'){$launchEnvironment.DARKPOOL_ADMIN_INTERNAL='1'}
if($Action -eq 'issuer'){
  $launchEnvironment.DARKPOOL_ISSUANCE_INTERNAL='1'
  foreach($name in @('ALLOCATION_AUTH','ALLOCATION_PORT','VAULT_PORT')){$value=[Environment]::GetEnvironmentVariable($name,'Process');if($null -ne $value){$launchEnvironment[$name]=$value}}
}
if($Action -eq 'watcher'){
  $launchEnvironment.DARKPOOL_WATCHER_INTERNAL='1'
  $launchEnvironment.WALLET_DB_PATH=Join-Path ([string]$target.watcher) 'data.sqlite'
  $launchEnvironment.WATCHER_STOP_PATH=Join-Path ([string]$target.evidence) 'pending-stop.json'
  foreach($name in @('CHAIN_ENDPOINT','WATCHER_DIAGNOSTIC_PATH','DARKPOOL_WATCHER_RESCAN_REVIEW')){$value=[Environment]::GetEnvironmentVariable($name,'Process');if($null -ne $value){$launchEnvironment[$name]=$value}}
}
$targetProcess=New-Object System.Diagnostics.Process
$targetProcess.StartInfo.FileName=(Get-Command node).Source
$targetProcess.StartInfo.Arguments='"'+(Join-Path $repoTargetRoot $entry)+'"'
$targetProcess.StartInfo.UseShellExecute=$false
$targetProcess.StartInfo.CreateNoWindow=$true
$targetProcess.StartInfo.EnvironmentVariables.Clear()
foreach($name in $launchEnvironment.Keys){$targetProcess.StartInfo.EnvironmentVariables[$name]=$launchEnvironment[$name]}
try{if(-not $targetProcess.Start()){throw 'Selected target process unavailable'};$targetProcess.WaitForExit();$targetExit=$targetProcess.ExitCode;if($targetExit -ne 0){throw 'Selected target operation failed'}}finally{$launchEnvironment.PGPASSWORD=$null;$targetProcess.Dispose()}

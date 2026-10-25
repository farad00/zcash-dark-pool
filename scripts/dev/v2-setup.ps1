[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('phase9_payment_v2')][string]$Instance,
      [switch]$Plan,[switch]$Apply,[switch]$BackupsAcknowledged)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
. "$PSScriptRoot/v2-security.ps1"
$v2Repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$v2Previous=@{}
$v2ScopedKeys=@('DARKPOOL_PG_ENV','DARKPOOL_LIVE_INSTANCE','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','APP_ENV','ZCASH_NETWORK')
if($Apply){$v2ScopedKeys+=@('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD')}
foreach($key in $v2ScopedKeys) {
 $v2Previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')
}
function Invoke-V2Node([string]$Entry,[string[]]$Arguments,[string]$InputText) {
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=(Get-Command node).Source
 $start.Arguments='"'+(Join-Path $v2Repo $Entry)+'" '+($Arguments -join ' ')
 $start.UseShellExecute=$false; $start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
 $start.EnvironmentVariables.Clear()
 foreach($key in @('PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','DARKPOOL_PG_ENV','DARKPOOL_LIVE_INSTANCE','DARKPOOL_PG_PROFILE','APP_ENV','ZCASH_NETWORK','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD')) {
  if($Entry -eq 'db/v2-plan.mjs' -and $key -match '^PG'){continue}
  $value=[Environment]::GetEnvironmentVariable($key,'Process'); if($null -ne $value){$start.EnvironmentVariables[$key]=$value}
 }
 $child=New-Object Diagnostics.Process; $child.StartInfo=$start
 try {
  if(-not $child.Start()){throw 'V2 setup rejected'}
  $out=$child.StandardOutput.ReadToEndAsync(); $err=$child.StandardError.ReadToEndAsync()
  if($InputText){$child.StandardInput.Write($InputText)}; $child.StandardInput.Close()
  if(-not $child.WaitForExit(120000)){ $child.Kill(); throw 'V2 setup result unknown; reconcile before retry' }
  $outText=$out.GetAwaiter().GetResult(); $null=$err.GetAwaiter().GetResult()
  if($child.ExitCode -ne 0){throw 'V2 setup rejected; retained credentials must not be replaced'}
  return $outText.Trim()
 } finally { $start.EnvironmentVariables.Remove('PGPASSWORD'); $child.Dispose() }
}
try {
 if($Plan -and $Apply){throw 'V2 setup rejected'}
 # Refuse ambiguous inherited target/auth configuration, rather than silently clear it.
 foreach($key in @('PGPASSFILE','PGOPTIONS','PGSERVICE','PGSERVICEFILE','PGHOSTADDR','PGSSLMODE','PGSSLROOTCERT','PGTARGETSESSIONATTRS','DATABASE_URL','PSQL_PATH','WALLET_DB_PATH')) {
  if([Environment]::GetEnvironmentVariable($key,'Process')){throw 'V2 setup rejected'}
 }
 if($Apply) {
  if(@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG'}).Count -ne 0){throw 'Use a fresh unconfigured shell for V2 apply'}
  foreach($key in @('DARKPOOL_PG_ENV','DARKPOOL_LIVE_INSTANCE','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY')) {
   if([Environment]::GetEnvironmentVariable($key,'Process')){throw 'Use a fresh unconfigured shell for V2 apply'}
  }
  if(($env:ZCASH_NETWORK -and $env:ZCASH_NETWORK -cne 'testnet') -or ($env:APP_ENV -and $env:APP_ENV -cne 'development')){throw 'V2 setup rejected'}
  if(-not $BackupsAcknowledged){throw 'Protected storage and recovery acknowledgement required'}
 }
 $env:DARKPOOL_PG_ENV='LIVE_EVIDENCE'; $env:DARKPOOL_LIVE_INSTANCE=$Instance
 Remove-Item Env:DARKPOOL_TEST_ONLY -ErrorAction SilentlyContinue
 $env:APP_ENV='development'; $env:ZCASH_NETWORK='testnet'
 $target=(Invoke-V2Node 'db/v2-plan.mjs' @() '') | ConvertFrom-Json
 if(-not $Apply){$target | ConvertTo-Json -Depth 8; exit 0}
 # No initdb/pg_ctl, directory creation, wallet access or protected-target fallback.
 Assert-V2Acl ([string]$target.root) -ProtectedRoot
 Assert-V2Acl (Join-Path ([string]$target.root) 'maintenance.xml')
 $maintenance=Import-Clixml -LiteralPath (Join-Path ([string]$target.root) 'maintenance.xml')
 if($maintenance.UserName -cne [string]$target.roles.maintenance){throw 'V2 setup rejected'}
 $env:DARKPOOL_PG_PROFILE=[string]$target.profile
 $env:PGHOST='127.0.0.1';$env:PGPORT='55435';$env:PGDATABASE='postgres'
 $env:PGUSER=$maintenance.UserName;$env:PGPASSWORD=$maintenance.GetNetworkCredential().Password
 $preflight=(Invoke-V2Node 'db/v2-provision.mjs' @('preflight') '') | ConvertFrom-Json
 if($preflight.roles_present -ne 0) {
  if($preflight.roles_present -ne 5){throw 'Partial or conflicting roles require review'}
  foreach($purpose in @('owner','admin','watch','issue','read')) {
   if(-not (Test-Path -LiteralPath (Join-Path ([string]$target.root) ($purpose+'.xml')) -PathType Leaf)){throw 'Restore retained credential; never regenerate'}
  }
 }
 $credentials=@{}; $passwords=@{}
 foreach($purpose in @('owner','admin','watch','issue','read')) {
  $credentials[$purpose]=Write-V2Credential (Join-Path ([string]$target.root) ($purpose+'.xml')) ([string]$target.roles.$purpose)
  $passwords[$purpose]=$credentials[$purpose].GetNetworkCredential().Password
 }
 $result=Invoke-V2Node 'db/v2-provision.mjs' @('apply') ($passwords | ConvertTo-Json -Compress)
 $passwords.Clear()
 $env:PGDATABASE=[string]$target.database; $env:PGUSER=[string]$target.roles.owner
 $env:PGPASSWORD=$credentials.owner.GetNetworkCredential().Password
 $result=Invoke-V2Node 'db/v2-migrations.mjs' @('apply') ''
 Write-Output $result
} catch { Write-Output 'V2_SETUP_REJECTED_OR_UNCONFIRMED'; exit 1 }
finally {
 foreach($key in $v2Previous.Keys){[Environment]::SetEnvironmentVariable($key,$v2Previous[$key],'Process')}
 if($passwords){$passwords.Clear()};$credentials=$null;$maintenance=$null
}

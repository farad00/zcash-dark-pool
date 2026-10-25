[CmdletBinding()]
param([switch]$Create,[switch]$DevelopmentOnlyAcknowledged,[switch]$DisposableRehearsal,[string]$RehearsalRoot,[int]$RehearsalPort)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
. "$PSScriptRoot/v2-security.ps1"
$developmentRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$developmentNodePath=Join-Path $developmentRepo '.tools/node-v24.21.0-win-x64/node.exe'
function Invoke-DevelopmentProcess([string]$Executable,[string[]]$ProcessArguments,[string]$InputText,[int]$Deadline=60000){
 $developmentStart=New-Object Diagnostics.ProcessStartInfo
 $developmentStart.FileName=$Executable
 $developmentQuoted=@($ProcessArguments|ForEach-Object{if($_ -match '["\r\n]'){throw 'invalid native argument'};'"'+$_+'"'})
 $developmentStart.Arguments=$developmentQuoted -join ' '
 $developmentStart.UseShellExecute=$false;$developmentStart.CreateNoWindow=$true
 $developmentStart.RedirectStandardInput=$true;$developmentStart.RedirectStandardOutput=$true;$developmentStart.RedirectStandardError=$true
 $developmentStart.EnvironmentVariables.Clear()
 foreach($developmentName in @('PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','USERPROFILE','APPDATA')){
  $developmentValue=[Environment]::GetEnvironmentVariable($developmentName,'Process');if($null -ne $developmentValue){$developmentStart.EnvironmentVariables[$developmentName]=$developmentValue}
 }
 if($DisposableRehearsal){$developmentStart.EnvironmentVariables['DARKPOOL_DEV_REHEARSAL']='1'}
 $developmentChild=New-Object Diagnostics.Process;$developmentChild.StartInfo=$developmentStart
 try{
  if(-not $developmentChild.Start()){throw 'development process failed'}
  $developmentOut=$developmentChild.StandardOutput.ReadToEndAsync();$developmentErr=$developmentChild.StandardError.ReadToEndAsync()
  if($InputText){$developmentChild.StandardInput.Write($InputText)};$developmentChild.StandardInput.Close()
  if(-not $developmentChild.WaitForExit($Deadline)){$developmentChild.Kill();throw 'development result unknown'}
  $developmentText=$developmentOut.GetAwaiter().GetResult();$null=$developmentErr.GetAwaiter().GetResult()
  if($developmentChild.ExitCode -ne 0){throw 'development process rejected'}
  return $developmentText.Trim()
 }finally{$developmentChild.Dispose()}
}
function Invoke-DevelopmentNode([string]$Action,[string]$InputText){
 return Invoke-DevelopmentProcess $developmentNodePath @((Join-Path $developmentRepo 'db/v2-development.mjs'),$Action) $InputText
}
function Invoke-DevelopmentNative([string]$Stage,[int]$Limit,[string]$Executable,[string[]]$NativeArguments,[switch]$Daemon){
 $developmentArgs=@((Join-Path $PSScriptRoot 'run-bounded.mjs'),$Stage,[string]$Limit)
 if($Daemon){$developmentArgs+='--allow-inherited-output-after-exit'}
 $developmentArgs+=$Executable;$developmentArgs+=$NativeArguments
 $null=Invoke-DevelopmentProcess $developmentNodePath $developmentArgs '' 180000
}
$developmentPasswordPath=$null
$developmentStage='PLAN'
try{
 if($DisposableRehearsal){
  if($env:DARKPOOL_DEV_REHEARSAL -cne '1' -or -not $RehearsalRoot -or -not $RehearsalPort){throw 'disposable rehearsal required'}
  $developmentTarget=(Invoke-DevelopmentNode 'fixture-plan' (@{root=$RehearsalRoot;port=$RehearsalPort}|ConvertTo-Json -Compress))|ConvertFrom-Json
 }else{
  if($RehearsalRoot -or $RehearsalPort -or $env:DARKPOOL_DEV_REHEARSAL){throw 'rehearsal cannot select fixed development target'}
  if($env:LOCALAPPDATA -ine [Environment]::GetFolderPath('LocalApplicationData')){throw 'local application path mismatch'}
  $developmentTarget=(Invoke-DevelopmentNode 'plan' '')|ConvertFrom-Json
 }
 if(-not $Create){$developmentTarget|ConvertTo-Json -Depth 6;exit 0}
 $developmentStage='ACKNOWLEDGEMENT'
 if(-not $DevelopmentOnlyAcknowledged){throw 'NOT FINANCIALLY AUTHORIZED acknowledgement required'}
 $developmentStage='ENVIRONMENT'
 if(@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_LIVE_INSTANCE','DARKPOOL_TEST_ONLY')}).Count){throw 'fresh unconfigured shell required'}
 if(($env:APP_ENV -and $env:APP_ENV -cne 'development') -or ($env:ZCASH_NETWORK -and $env:ZCASH_NETWORK -cne 'testnet')){throw 'development only'}
 $developmentRoot=[string]$developmentTarget.root;$developmentData=[string]$developmentTarget.data
 $developmentStage='TARGET'
 Assert-V2LocalPath $developmentRoot
 if(Test-Path -LiteralPath $developmentRoot){throw 'existing root cannot be adopted'}
 if($developmentTarget.live_root -and (Test-Path -LiteralPath ([string]$developmentTarget.live_root))){throw 'financial V2 root collision; no conversion allowed'}
 if([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains [int]$developmentTarget.port){throw 'dedicated port occupied'}
 $developmentVersion=Invoke-DevelopmentProcess (Join-Path $developmentRepo '.tools/pgsql/bin/postgres.exe') @('--version') '' 10000
 if($developmentVersion -cne 'postgres (PostgreSQL) 18.6'){throw 'pinned PostgreSQL required'}
 New-Item -ItemType Directory -Path $developmentRoot | Out-Null
 $developmentStage='CREDENTIALS'
 $developmentAcl=New-Object Security.AccessControl.DirectorySecurity;$developmentAcl.SetAccessRuleProtection($true,$false)
 $developmentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 foreach($developmentPrincipal in @($developmentSid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){
  $developmentRule=New-Object Security.AccessControl.FileSystemAccessRule($developmentPrincipal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$developmentAcl.AddAccessRule($developmentRule)
 }
 Set-Acl -LiteralPath $developmentRoot -AclObject $developmentAcl;Assert-V2Acl $developmentRoot -ProtectedRoot
 $developmentMaintenance=Write-V2Credential (Join-Path $developmentRoot 'maintenance.xml') ([string]$developmentTarget.roles.maintenance)
 $developmentReader=Write-V2Credential (Join-Path $developmentRoot 'read.xml') ([string]$developmentTarget.roles.read)
 [IO.File]::WriteAllText((Join-Path $developmentRoot 'NOT_FINANCIALLY_AUTHORIZED.txt'),'DEVELOPMENT_ONLY. NO WALLETS, FUNDABLE TICKETS, DEPOSITS OR PAYOUTS. OFF-DEVICE BACKUP UNAVAILABLE.')
 $developmentPasswordPath=Join-Path $developmentRoot 'bootstrap.password'
 [IO.File]::WriteAllText($developmentPasswordPath,$developmentMaintenance.GetNetworkCredential().Password,[Text.Encoding]::ASCII)
 $developmentStage='INITDB'
 Invoke-DevelopmentNative 'development-initdb' 60000 (Join-Path $developmentRepo '.tools/pgsql/bin/initdb.exe') @('-D',$developmentData,'-U',[string]$developmentTarget.roles.maintenance,"--pwfile=$developmentPasswordPath",'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C','--wal-segsize=1')
 Remove-Item -LiteralPath $developmentPasswordPath -Force;$developmentPasswordPath=$null
 $developmentConfig=@"
listen_addresses='127.0.0.1'
port=$($developmentTarget.port)
shared_buffers='16MB'
max_connections=12
wal_level=minimal
max_wal_senders=0
min_wal_size='2MB'
max_wal_size='16MB'
fsync=on
synchronous_commit=on
full_page_writes=on
timezone='UTC'
password_encryption='scram-sha-256'
log_statement='none'
log_min_error_statement='panic'
log_error_verbosity='terse'
log_connections=''
log_disconnections=off
"@
 [IO.File]::WriteAllText((Join-Path $developmentData 'postgresql.conf'),$developmentConfig,(New-Object Text.UTF8Encoding($false)))
 [IO.File]::WriteAllText((Join-Path $developmentData 'pg_hba.conf'),"host all all 127.0.0.1/32 scram-sha-256`n",[Text.Encoding]::ASCII)
 $developmentStage='PROFILE'
 $null=Invoke-DevelopmentNode 'profile' (@{plan=$developmentTarget}|ConvertTo-Json -Depth 6 -Compress)
 $developmentStage='START'
 Invoke-DevelopmentNative 'development-start' 30000 (Join-Path $developmentRepo '.tools/pgsql/bin/pg_ctl.exe') @('-D',$developmentData,'-l',(Join-Path $developmentRoot 'development-postgres.log'),'-t','20','-w','start') -Daemon
 $developmentStage='INSTALL'
 $developmentReceipt=Invoke-DevelopmentNode 'install' (@{plan=$developmentTarget;maintenance=$developmentMaintenance.GetNetworkCredential().Password;read=$developmentReader.GetNetworkCredential().Password}|ConvertTo-Json -Depth 6 -Compress)
 [IO.File]::WriteAllText((Join-Path $developmentRoot 'initialization-receipt.json'),$developmentReceipt,(New-Object Text.UTF8Encoding($false)))
 Write-Output $developmentReceipt
}catch{
 Write-Output ('V2_DEVELOPMENT_REJECTED_STAGE_'+$developmentStage+':'+$_.Exception.GetType().Name+':'+$_.InvocationInfo.ScriptLineNumber)
 exit 1
}finally{
 if($developmentPasswordPath -and (Test-Path -LiteralPath $developmentPasswordPath)){Remove-Item -LiteralPath $developmentPasswordPath -Force}
 $developmentMaintenance=$null;$developmentReader=$null
}

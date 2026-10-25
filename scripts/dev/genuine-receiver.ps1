[CmdletBinding()]
param(
 [ValidateSet('Plan','Create','Open','Allocator','Issuer','Stop')][string]$Action='Plan',
 [string]$ApprovalFile,[string]$ApprovedMarketSha256,
 [switch]$UnfundedOnlyAcknowledged
)
$ErrorActionPreference='Stop'
$receiverRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$receiverNode=Join-Path $receiverRepo '.tools/node-v24.21.0-win-x64/node.exe'
$receiverCli=Join-Path $receiverRepo 'services/genuine-deposit/unfunded-cli.mjs'
$receiverRoot='C:\ProgramData\ZcashDarkPoolRehearsal\testnet_observation_v1'
$receiverData=Join-Path $receiverRoot 'postgres\data'
$receiverStage='PREFLIGHT'
. "$PSScriptRoot/v2-security.ps1"
function Write-ReceiverNew([string]$Path,[string]$Text){
 $f=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$b=(New-Object Text.UTF8Encoding($false)).GetBytes($Text);$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}
}
function Invoke-ReceiverProcess([string]$Executable,[string[]]$Arguments,[string]$InputText='',[int]$Limit=180000,[Management.Automation.PSCredential]$Identity=$null){
 $si=New-Object Diagnostics.ProcessStartInfo
 $si.FileName=$Executable;$si.Arguments=(@($Arguments|ForEach-Object{if($_ -match '["\r\n]'){throw 'argument rejected'};'"'+$_+'"'}) -join ' ')
 $si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.WorkingDirectory=$receiverRepo
 $si.RedirectStandardInput=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
 $si.EnvironmentVariables.Clear()
 foreach($k in @('PATH','SystemRoot','WINDIR','TEMP','TMP')){ $v=[Environment]::GetEnvironmentVariable($k,'Process');if($v){$si.EnvironmentVariables[$k]=$v} }
 if($Identity){
  $n=$Identity.UserName.Split('\');if($n.Count -ne 2){throw 'qualified Windows user required'}
  $account=New-Object Security.Principal.NTAccount($Identity.UserName)
  $accountSid=$account.Translate([Security.Principal.SecurityIdentifier]).Value
  $profile=(Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$accountSid)).ProfileImagePath
  $runtimeTemp=Join-Path $profile 'AppData\Local\Temp'
  Assert-V2LocalPath $runtimeTemp
  if(-not (Test-Path -LiteralPath $runtimeTemp -PathType Container)){throw 'existing runtime profile required'}
  $si.EnvironmentVariables['TEMP']=$runtimeTemp;$si.EnvironmentVariables['TMP']=$runtimeTemp
  $si.Domain=$n[0];$si.UserName=$n[1];$si.Password=$Identity.Password;$si.LoadUserProfile=$true
 }
 $p=New-Object Diagnostics.Process;$p.StartInfo=$si
 try{
  if(-not $p.Start()){throw 'process unavailable'}
  $err=$p.StandardError.ReadToEndAsync()
  if($InputText){$p.StandardInput.Write($InputText)};$p.StandardInput.Close()
  if($Identity){
   $first=$p.StandardOutput.ReadLineAsync()
   if(-not $first.Wait(30000)){throw 'runtime startup not confirmed'}
   $ready=$first.GetAwaiter().GetResult()|ConvertFrom-Json
   if($ready.status -ceq 'UNFUNDED_ISSUER_READY'){Write-Host 'UNFUNDED_ISSUER_READY: http://127.0.0.1:3003/market (DO NOT FUND)'}
   elseif($ready.status -ceq 'UNFUNDED_ALLOCATOR_PROCESS_STARTED_NOT_YET_PROVEN'){Write-Host 'UNFUNDED_ALLOCATOR_PROCESS_STARTED_NOT_YET_PROVEN'}
   else{throw 'runtime startup not confirmed'}
  }
  $out=$p.StandardOutput.ReadToEndAsync()
  if(-not $p.WaitForExit($Limit)){throw 'process outcome unknown; preserve and review'}
  $s=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult()
  if($p.ExitCode -ne 0){throw 'operation not confirmed'}
  return $s.Trim()
 }finally{$p.Dispose();$si.Password=$null}
}
function Invoke-ReceiverNode([string]$Operation,[object]$Value){
 $i=if($null -eq $Value){''}else{$Value|ConvertTo-Json -Depth 12 -Compress}
 return Invoke-ReceiverProcess $receiverNode @($receiverCli,$Operation) $i
}
function Set-ReceiverAcl([string]$Path,[string[]]$Readers=@(),[switch]$InheritReaders){
 Assert-V2LocalPath $Path
 $item=Get-Item -Force -LiteralPath $Path
 $acl=if($item.PSIsContainer){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
 $acl.SetAccessRuleProtection($true,$false)
 $own=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl.SetOwner($own)
 foreach($s in @($own.Value,'S-1-5-18','S-1-5-32-544')){
  $sid=New-Object Security.Principal.SecurityIdentifier($s)
  $r=if($item.PSIsContainer){New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')}
  $acl.AddAccessRule($r)
 }
 foreach($s in $Readers){
  $sid=New-Object Security.Principal.SecurityIdentifier($s)
  $r=if($item.PSIsContainer -and $InheritReaders){New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')}else{New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','Allow')}
  $acl.AddAccessRule($r)
 }
 # Set only the explicitly modified DACL/owner through .NET. PowerShell 5.1's
 # provider can otherwise request SeSecurityPrivilege for an ordinary owner write.
 $item.SetAccessControl($acl)
}
function Assert-ReceiverAcl([string]$Path,[string[]]$Readers=@(),[switch]$AllowInherited){
 Assert-V2LocalPath $Path
 $acl=Get-Acl -LiteralPath $Path
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid -or (-not $AllowInherited -and -not $acl.AreAccessRulesProtected)){throw 'ACL rejected'}
 $allowed=@($sid,'S-1-5-18','S-1-5-32-544')+$Readers
 foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($r.AccessControlType -ne 'Allow' -or $allowed -notcontains $r.IdentityReference.Value){throw 'ACL rejected'}
  if($Readers -contains $r.IdentityReference.Value -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0){throw 'read-only ACL required'}
 }
}
function Assert-ReceiverTools([string]$Path,[string[]]$Readers){
 Assert-ReceiverAcl $Path $Readers
 function Test-ReceiverTree([string]$Directory){
  foreach($item in Get-ChildItem -Force -LiteralPath $Directory){
   Assert-ReceiverAcl $item.FullName $Readers -AllowInherited
   if($item.PSIsContainer){Test-ReceiverTree $item.FullName}
  }
 }
 Test-ReceiverTree $Path
}
function Assert-ReceiverViewer([string]$ViewerSid){
 $path=Join-Path $receiverRoot 'viewer'
 Assert-V2LocalPath $path
 $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544',$ViewerSid)
 function Test-ViewerItem([string]$ItemPath){
  $item=Get-Item -Force -LiteralPath $ItemPath
  Assert-V2LocalPath $item.FullName
  $acl=Get-Acl -LiteralPath $item.FullName
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $allowed[0]){throw 'viewer owner rejected'}
  foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($r.AccessControlType -ne 'Allow' -or $allowed -notcontains $r.IdentityReference.Value){throw 'viewer ACL rejected'}
   if($r.IdentityReference.Value -ceq $ViewerSid -and ($r.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)) -ne 0){throw 'viewer ownership authority rejected'}
  }
  if($item.PSIsContainer){foreach($child in Get-ChildItem -Force -LiteralPath $ItemPath){Test-ViewerItem $child.FullName}}
 }
 Test-ViewerItem $path
}
function Read-ReceiverCredential([string]$Purpose){
 $file=Join-Path $receiverRoot ('credentials\'+$Purpose+'.xml')
 Assert-V2Acl (Split-Path -Parent $file) -ProtectedRoot;Assert-V2Acl $file
 $c=Import-Clixml -LiteralPath $file
 if($c.UserName -cne ('darkpool_obs_v1_'+$Purpose)){throw 'credential identity rejected'}
 return $c
}
function Assert-ReceiverPhysical {
 # Node's profile action is create-only; this existing guard checks without writing.
 $code="import {readClusterProfile,validateIdentityProfile} from './db/environment-identity.mjs';import {layout} from './services/genuine-deposit/unfunded.mjs'; const l={...layout(),reserved_system_identifiers:['7698884242696928048','7697706083887339692','7697541254856017064']}; await readClusterProfile(l,p=>{validateIdentityProfile(p,l,'TESTNET_OBSERVATION');if(p.instance!==l.instance||p.database!==l.database||p.financial_authorization!=='NOT_GRANTED')throw Error('rejected');}); console.log('IDENTITY_PASS');"
 if((Invoke-ReceiverProcess $receiverNode @('--input-type=module','-e',$code)) -cne 'IDENTITY_PASS'){throw 'physical identity rejected'}
}
$receiverPasswordPath=$null
try{
 if($Action -eq 'Plan'){Invoke-ReceiverNode 'plan' $null;exit 0}
 if(-not $UnfundedOnlyAcknowledged){throw 'separate explicit approval required'}
 if(@(Get-ChildItem Env:|Where-Object{$_.Name -match '^PG' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','DARKPOOL_PG_ENV','DARKPOOL_LIVE_INSTANCE','DARKPOOL_TEST_ONLY')}).Count){throw 'fresh shell required'}
 Assert-V2LocalPath $receiverRoot
 if($Action -eq 'Create'){
  if(-not $ApprovalFile -or (Test-Path -LiteralPath $receiverRoot)){throw 'create-only target required'}
  if([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains 55436){throw 'dedicated port occupied'}
  $a=Get-Content -Raw -LiteralPath $ApprovalFile|ConvertFrom-Json
  $null=Invoke-ReceiverNode 'validate' @{approval=$a}
  if((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'normal non-elevated operator required'}
  foreach($s in @($a.web_sid,$a.viewer_sid)){
   $sid=New-Object Security.Principal.SecurityIdentifier($s);$null=$sid.Translate([Security.Principal.NTAccount])
   $user=Get-LocalUser -SID $sid
   if(-not $user.Enabled -or $user.SID.Value -cne $s){throw 'pre-existing dedicated enabled local identity required'}
   foreach($group in Get-LocalGroup){
    if($group.SID.Value -cne 'S-1-5-32-545' -and @(Get-LocalGroupMember -SID $group.SID|Where-Object{$_.SID.Value -ceq $s}).Count){throw 'privileged runtime group refused'}
   }
  }
  $native=Join-Path $receiverRepo 'target\debug\darkpool-zcash.exe'
  if((Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash.ToLowerInvariant() -cne $a.native_sha256){throw 'native pin rejected'}
  $receiverStage='CREATE_ONLY_ROOT'
  $parent=Split-Path -Parent $receiverRoot
  if(-not (Test-Path -LiteralPath $parent)){
   New-Item -ItemType Directory -Path $parent|Out-Null
   Set-ReceiverAcl $parent
  }
  Assert-ReceiverAcl $parent
  New-Item -ItemType Directory -Path $receiverRoot|Out-Null
  Set-ReceiverAcl $receiverRoot @($a.web_sid,$a.viewer_sid)
  Assert-ReceiverAcl $receiverRoot @($a.web_sid,$a.viewer_sid)
  Write-ReceiverNew (Join-Path $receiverRoot 'create-attempt.json') (@{scope='ONE_UNFUNDED_RECEIVER_V1';approval_id=$a.approval_id;started_utc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress)
  Write-ReceiverNew (Join-Path $receiverRoot 'unfunded-approval.json') ($a|ConvertTo-Json -Depth 8 -Compress)
  foreach($d in @('postgres','credentials','control','bin')){New-Item -ItemType Directory -Path (Join-Path $receiverRoot $d)|Out-Null;Set-ReceiverAcl (Join-Path $receiverRoot $d)}
  $receiverStage='PRIVATE_TOOLS'
  $null=Invoke-ReceiverNode 'mirror' $null
  $tools=Join-Path $receiverRoot 'postgres\runtime-18.6-5'
  Set-ReceiverAcl $tools @($a.web_sid) -InheritReaders
  Assert-ReceiverTools $tools @($a.web_sid)
  [IO.File]::Copy($native,(Join-Path $receiverRoot 'bin\darkpool-zcash.exe'),$false)
  Set-ReceiverAcl (Join-Path $receiverRoot 'bin') @($a.viewer_sid) -InheritReaders
  $passwords=@{}
  foreach($k in @('maintenance','admin','issue','status','read')){$c=Write-V2Credential (Join-Path $receiverRoot ('credentials\'+$k+'.xml')) ('darkpool_obs_v1_'+$k);$passwords[$k]=$c.GetNetworkCredential().Password}
  $receiverPasswordPath=Join-Path $receiverRoot 'credentials\bootstrap.password'
  Write-ReceiverNew $receiverPasswordPath $passwords.maintenance
  $receiverStage='INITDB'
  $null=Invoke-ReceiverProcess (Join-Path $tools 'bin\initdb.exe') @('-D',$receiverData,'-U','darkpool_obs_v1_maintenance',"--pwfile=$receiverPasswordPath",'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C','--no-clean')
  Remove-Item -LiteralPath $receiverPasswordPath -Force;$receiverPasswordPath=$null
  $null=Invoke-ReceiverNode 'profile' $null
  $plan=Invoke-ReceiverNode 'plan' $null|ConvertFrom-Json
  [IO.File]::WriteAllText((Join-Path $receiverData 'pg_hba.conf'),[string]$plan.hba,[Text.Encoding]::ASCII)
  [IO.File]::AppendAllText((Join-Path $receiverData 'postgresql.conf'),"`nlisten_addresses='127.0.0.1'`nport=55436`npassword_encryption='scram-sha-256'`nfsync=on`nsynchronous_commit=on`nfull_page_writes=on`ntimezone='UTC'`nlog_statement='none'`nlog_min_error_statement='panic'`nlog_error_verbosity='terse'`n",[Text.Encoding]::ASCII)
  $receiverStage='START'
  $null=Invoke-ReceiverProcess $receiverNode @((Join-Path $PSScriptRoot 'run-bounded.mjs'),'unfunded-start','30000','--allow-inherited-output-after-exit',(Join-Path $tools 'bin\pg_ctl.exe'),'-D',$receiverData,'-l',(Join-Path $receiverRoot 'postgres.log'),'-t','20','-w','start')
  $receiverStage='INTAKE'
  $result=Invoke-ReceiverNode 'install' @{passwords=$passwords}
  # Give web only the physical identity reads required by the existing transport.
  foreach($d in @('postgres','postgres\data','postgres\data\global','postgres\data\pg_wal','postgres\data\pg_tblspc')){Set-ReceiverAcl (Join-Path $receiverRoot $d) @($a.web_sid,$a.viewer_sid)}
  Set-ReceiverAcl (Join-Path $receiverData 'global\pg_control') @($a.web_sid,$a.viewer_sid)
  foreach($f in @('unfunded-approval.json','deposit-profile.json','cluster-marker.json','intake-installed.json')){Set-ReceiverAcl (Join-Path $receiverRoot $f) @($a.web_sid,$a.viewer_sid)}
  $bytes=[IO.File]::ReadAllBytes((Join-Path $receiverRoot 'intake-installed.json'))
  $hasher=[Security.Cryptography.SHA256]::Create()
  try{$hash=([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
  Write-ReceiverNew (Join-Path $receiverRoot 'bootstrap-completed.json') (@{scope='ONE_UNFUNDED_RECEIVER_V1';status='PHYSICAL_BOOTSTRAP_COMPLETED';receipt_sha256=$hash}|ConvertTo-Json -Compress)
  Set-ReceiverAcl (Join-Path $receiverRoot 'bootstrap-completed.json') @($a.web_sid,$a.viewer_sid)
  Write-Output $result
  exit 0
 }
 $a=Get-Content -Raw -LiteralPath (Join-Path $receiverRoot 'unfunded-approval.json')|ConvertFrom-Json
 $receiverStage='TARGET_BINDING'
 if($Action -ne 'Stop'){$null=Invoke-ReceiverNode 'validate' @{approval=$a}}
 elseif([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $a.operator_sid){throw 'stop identity rejected'}
 Assert-ReceiverAcl $receiverRoot @($a.web_sid,$a.viewer_sid)
 Assert-ReceiverPhysical
 $tools=Join-Path $receiverRoot 'postgres\runtime-18.6-5'
 Assert-ReceiverTools $tools @($a.web_sid)
 if($Action -eq 'Stop'){
  $null=Invoke-ReceiverProcess $receiverNode @((Join-Path $PSScriptRoot 'run-bounded.mjs'),'unfunded-stop','30000',(Join-Path $tools 'bin\pg_ctl.exe'),'-D',$receiverData,'-m','fast','-w','stop')
  Write-Output 'UNFUNDED_CLUSTER_STOPPED';exit 0
 }
 if($Action -eq 'Open'){
  $receiverStage='PRIVATE_OPEN'
  if($ApprovedMarketSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'exact reviewed market hash required'}
  $maintenance=Read-ReceiverCredential 'maintenance'
  $result=Invoke-ReceiverNode 'open' @{maintenance=$maintenance.GetNetworkCredential().Password;approved_market_sha256=$ApprovedMarketSha256}
  Set-ReceiverAcl (Join-Path $receiverRoot 'market-opened.json') @($a.web_sid,$a.viewer_sid)
  Write-Output $result;exit 0
 }
 $receiverStage='VIEWER_PERMISSIONS'
 Assert-ReceiverViewer $a.viewer_sid
 $market=Get-Content -Raw -LiteralPath (Join-Path $receiverRoot 'market-opened.json')|ConvertFrom-Json
 $allocationPath=Join-Path $receiverRoot 'control\allocator.xml'
 $allocation=Write-V2Credential $allocationPath 'unfunded_allocator_capability'
 $allocator=@{ALLOCATION_AUTH=$allocation.GetNetworkCredential().Password;ALLOCATION_PORT='55437';ALLOCATION_MARKET_ID=$market.market_id;ALLOCATION_VAULT_CONTEXT=$market.vault_context_ref}
 $purpose=if($Action -eq 'Issuer'){'serve'}else{'allocator'}
 $receiverStage='RUNTIME_IDENTITY'
 $identity=Get-Credential -Message ('Dedicated '+$Action+' Windows identity; no wallet key')
 $account=New-Object Security.Principal.NTAccount($identity.UserName)
 $sid=$account.Translate([Security.Principal.SecurityIdentifier]).Value
 $expected=if($Action -eq 'Issuer'){$a.web_sid}else{$a.viewer_sid}
 if($sid -cne $expected){throw 'runtime identity substitution refused'}
 $inputValue=@{allocator=$allocator}
 if($Action -eq 'Issuer'){
  $connections=@{}
  foreach($k in @('issue','status','read')){
   $c=Read-ReceiverCredential $k
   $connections[$k]=@{APP_ENV='development';ZCASH_NETWORK='testnet';DARKPOOL_PG_ENV='TESTNET_OBSERVATION';DARKPOOL_OBSERVATION_INSTANCE='testnet_observation_v1';PGHOST='127.0.0.1';PGPORT='55436';PGDATABASE='darkpool_testnet_observation_v1';PGUSER=$c.UserName;PGPASSWORD=$c.GetNetworkCredential().Password;FINANCIAL_AUTHORIZATION='NOT_GRANTED'}
  }
  $inputValue.connections=$connections
 }
 # Named runtime account, stdin-only capabilities, no maintenance password.
 $receiverStage=if($Action -eq 'Issuer'){'ISSUER_STARTUP'}else{'ALLOCATOR_STARTUP'}
 $result=Invoke-ReceiverProcess $receiverNode @($receiverCli,$purpose) ($inputValue|ConvertTo-Json -Depth 12 -Compress) 1860000 $identity
 Write-Output $result
}catch{
 Write-Output (@{status='UNFUNDED_OPERATION_NOT_CONFIRMED';stage=$receiverStage;partial_state='PRESERVE_AND_REVIEW_IF_PRESENT';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress)
 exit 1
}finally{
 # The sole ephemeral plaintext initdb file; never remove attempt/identity records.
 if($receiverPasswordPath -and (Test-Path -LiteralPath $receiverPasswordPath)){Remove-Item -LiteralPath $receiverPasswordPath -Force}
 $passwords=$null;$c=$null;$maintenance=$null;$identity=$null;$connections=$null;$inputValue=$null;$allocation=$null
}

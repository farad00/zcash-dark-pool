[CmdletBinding()]
param(
 [ValidateSet('Inspect','CompileTest','Rehearse','CreatePersistent')][string]$Action='Inspect',
 [switch]$DisposableAccountsAcknowledged,
 [ValidatePattern('^[a-f0-9]{32}$')][string]$EvidenceId,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedNativeSha256,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRunnerSha256,
 [ValidatePattern('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')][string]$ApprovalExpiresUtc
)
$ErrorActionPreference='Stop'
$stage='RELEASE_GATE';$root=$null;$rootId=$null;$lock=$null;$evidence=$null
$accounts=[Collections.Generic.List[object]]::new();$hostResults=[Collections.Generic.List[object]]::new()
$failure=$null;$cleanupErrors=[Collections.Generic.List[string]]::new();$checks=[Collections.Generic.List[string]]::new()
$script:journalIndex=0
function Assert-NativeFixtureWindow([string]$Value){
 if(-not $Value){throw 'short execution window required'}
 $end=[DateTime]::ParseExact($Value,'yyyy-MM-ddTHH:mm:ssZ',[Globalization.CultureInfo]::InvariantCulture,([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal))
 if($end -le [DateTime]::UtcNow -or $end -gt [DateTime]::UtcNow.AddMinutes(15)){throw 'execution window expired or too broad'}
}
# Self-contained version of the existing local-path guard: an elevated runner
# must not dot-source an additional unpinned file from the writable workspace.
function Assert-V2LocalPath([string]$Path){
 if(-not [IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.?([\\/]|$)'){throw 'local path required'}
 $at=[IO.Path]::GetFullPath($Path)
 while($at){if(Test-Path -LiteralPath $at){if(((Get-Item -LiteralPath $at -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse rejected'}};$parent=Split-Path -Parent $at;if($parent -eq $at){break};$at=$parent}
}
# Evidence helpers stay in this source-pinned runner. No configurable production
# evidence root or additional unpinned elevated dependency is accepted.
function Assert-EvidencePath([string]$Path){
 try{Assert-V2LocalPath $Path}catch{if($_.Exception.Message -ceq 'reparse rejected'){throw 'EVIDENCE_REPARSE_REJECTED'};throw 'EVIDENCE_PATH_REJECTED'}
}
function New-EvidenceAcl([string]$Sid,[bool]$Directory){
 $acl=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
 $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($Sid));$acl.SetAccessRuleProtection($true,$false)
 $inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
 foreach($who in @($Sid,'S-1-5-18','S-1-5-32-544')|Select-Object -Unique){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($who),'FullControl',$inherit,'None','Allow'))}
 return $acl
}
function Assert-EvidenceAcl([string]$Path,[string]$Sid){
 Assert-EvidencePath $Path
 $item=Get-Item -LiteralPath $Path -Force;$acl=Get-Acl -LiteralPath $Path
 $allowed=@($Sid,'S-1-5-18','S-1-5-32-544')|Select-Object -Unique
 if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin $allowed){throw 'EVIDENCE_ACL_REJECTED'}
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$seen=@{}
 $inherit=if($item.PSIsContainer){3}else{0}
 foreach($rule in $rules){$who=$rule.IdentityReference.Value
  if($who -cnotin $allowed -or $seen.ContainsKey($who) -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or [int]$rule.FileSystemRights -ne 2032127 -or [int]$rule.InheritanceFlags -ne $inherit -or [int]$rule.PropagationFlags -ne 0){throw 'EVIDENCE_ACL_REJECTED'}
  $seen[$who]=$true
 }
 if($seen.Count -ne @($allowed).Count){throw 'EVIDENCE_ACL_REJECTED'}
}
function Assert-EvidenceAncestors([string]$Path,[string]$Sid){
 Assert-EvidencePath $Path
 $trusted=@($Sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
 $at=Split-Path -Parent ([IO.Path]::GetFullPath($Path))
 while($at){
  if(-not(Test-Path -LiteralPath $at -PathType Container)){throw 'EVIDENCE_PATH_REJECTED'}
  $acl=Get-Acl -LiteralPath $at
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin $trusted){throw 'EVIDENCE_ACL_REJECTED'}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   # Standard Windows ancestors permit creating children. They must not permit
   # untrusted deletion/replacement of an existing directory or ACL/owner edits.
   if($rule.AccessControlType -eq 'Allow' -and ([int]$rule.PropagationFlags -band 2) -eq 0 -and $rule.IdentityReference.Value -cnotin $trusted -and (([long][int]$rule.FileSystemRights -band 0x500D0040) -ne 0)){throw 'EVIDENCE_ACL_REJECTED'}
  }
  $next=Split-Path -Parent $at;if($next -eq $at){break};$at=$next
 }
}
function New-EvidenceDirectory([string]$Path,[string]$Sid){
 Assert-EvidenceAncestors $Path $Sid
 if(Test-Path -LiteralPath $Path){throw 'EVIDENCE_COLLISION'}
 if(-not ('ObservationEvidenceDirectory' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ObservationEvidenceDirectory {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path, ref SA attributes);
 public static void Create(string path, byte[] descriptor) {
  IntPtr p=Marshal.AllocHGlobal(descriptor.Length);
  try { Marshal.Copy(descriptor,0,p,descriptor.Length); SA sa=new SA();sa.length=Marshal.SizeOf(typeof(SA));sa.descriptor=p;
   if(!CreateDirectoryW(path,ref sa))throw new Win32Exception(Marshal.GetLastWin32Error());
  } finally { Marshal.FreeHGlobal(p); }
 }
}
'@
 }
 $acl=New-EvidenceAcl $Sid $true
 # CreateDirectoryW is atomic create-only (unlike Directory.CreateDirectory).
 [ObservationEvidenceDirectory]::Create($Path,$acl.GetSecurityDescriptorBinaryForm())
 Assert-EvidenceAcl $Path $Sid
}
function Initialize-NativeEvidence([string]$Parent,[string]$Id,[string]$Sid){
 if($Id -cnotmatch '^[a-f0-9]{32}$'){throw 'EVIDENCE_PATH_REJECTED'}
 Assert-EvidenceAncestors $Parent $Sid
 if(Test-Path -LiteralPath $Parent){Assert-EvidenceAcl $Parent $Sid}else{New-EvidenceDirectory $Parent $Sid}
 $candidate=Join-Path $Parent $Id
 New-EvidenceDirectory $candidate $Sid
 return $candidate
}
function Write-EvidenceDurable([string]$Directory,[string]$Name,[byte[]]$Bytes,[string]$Sid){
 if($Name -cnotmatch '^(\d{2,}-event|result)\.json$'){throw 'EVIDENCE_PATH_REJECTED'}
 Assert-EvidenceAncestors $Directory $Sid;Assert-EvidenceAcl $Directory $Sid
 $path=Join-Path $Directory $Name;Assert-EvidencePath $path
 $acl=New-EvidenceAcl $Sid $false
 $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$acl)
 try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 Assert-EvidenceAcl $path $Sid
 if((Get-Item -LiteralPath $path -Force).Length -ne $Bytes.Length){throw 'EVIDENCE_WRITE_FAILED'}
}
function Save-NativeResult($Report,[string]$Directory,[string]$Sid){
 try{Write-EvidenceDurable $Directory 'result.json' ([Text.Encoding]::UTF8.GetBytes(($Report|ConvertTo-Json -Depth 7))) $Sid}
 catch{
  $Report.original_failure=$Report.failure
  $reason=if($_.Exception.Message -cin @('EVIDENCE_REPARSE_REJECTED','EVIDENCE_ACL_REJECTED','EVIDENCE_PATH_REJECTED')){$_.Exception.Message}else{'EVIDENCE_WRITE_FAILED'}
  $Report.status='FAIL_OR_BLOCKED';$Report.failure=[ordered]@{stage='RESULT_PERSISTENCE';reason='RESULT_PERSISTENCE_FAILED';evidence_reason=$reason;win32_code=$null}
 }
}
try {
 if($args.Count -ne 0 -or $Action -ceq 'CreatePersistent'){throw 'PERSISTENT_EXECUTION_DISABLED'}
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($id)
 $elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
 if($Action -ceq 'Inspect'){
  if($ApprovalExpiresUtc){Assert-NativeFixtureWindow $ApprovalExpiresUtc}
  [ordered]@{status='NATIVE_BACKEND_INSPECTION';elevated=$elevated;window_checked=[bool]$ApprovalExpiresUtc;real_fixture_execution=$(if($elevated){'REQUIRES_EXPLICIT_DISPOSABLE_ACTION'}else{'BLOCKED_ELEVATION_REQUIRED'});persistent_creation='DISABLED';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress;exit 0
 }
 $stage='AUTHORIZATION'
 if($Action -ceq 'Rehearse' -and (-not $DisposableAccountsAcknowledged -or -not $elevated -or $id.Name -cne 'ABDULSAMAD\Admin')){throw 'ELEVATION_OR_ACKNOWLEDGEMENT_REQUIRED'}
 if($Action -ceq 'Rehearse'){Assert-NativeFixtureWindow $ApprovalExpiresUtc}
 if(-not [Environment]::Is64BitProcess -or $env:SystemRoot -ine 'C:\Windows'){throw 'WINDOWS_X64_REQUIRED'}
 $repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
 if($repo -ine 'C:\Users\Admin\OneDrive\Desktop\zecathon\zcash-dark-pool' -or ([IO.Path]::GetTempPath()).TrimEnd('\') -ine 'C:\Users\Admin\AppData\Local\Temp'){throw 'fixed fixture location required'}
 $source=Join-Path $PSScriptRoot 'observation-native-windows.cs'
 $nativeHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
 $runnerHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
 if($Action -ceq 'Rehearse' -and (-not $EvidenceId -or $ExpectedNativeSha256 -cne $nativeHash -or $ExpectedRunnerSha256 -cne $runnerHash)){throw 'REVIEWED_SOURCE_HASH_REQUIRED'}
 if($Action -ceq 'CompileTest' -and ($EvidenceId -or $DisposableAccountsAcknowledged)){throw 'compile only'}
 $operatorSid=$id.User.Value
 if($Action -ceq 'Rehearse'){
  $stage='EVIDENCE_PREFLIGHT'
  $evidence=Initialize-NativeEvidence 'C:\ProgramData\ZcashDarkPoolRehearsalEvidence' $EvidenceId $operatorSid
  Write-EvidenceDurable $evidence '00-event.json' ([Text.Encoding]::UTF8.GetBytes((([ordered]@{scope='DISPOSABLE_WINDOWS_SECURITY_ONLY';phase='EVIDENCE_READY';elevated=$elevated;operator_sid=$operatorSid;native_sha256=$nativeHash;runner_sha256=$runnerHash;financial_authorization='NOT_GRANTED'})|ConvertTo-Json -Compress))) $operatorSid
  $script:journalIndex=1
 }
 $stage='FRESH_FIXTURE'
 $nonce=[Guid]::NewGuid().ToString('N')
 $root=Join-Path ([IO.Path]::GetTempPath()) ('darkpool-winsec-'+$nonce)
 Assert-V2LocalPath $root
 if(Test-Path -LiteralPath $root){throw 'fixture collision'}
 New-Item -ItemType Directory -Path $root|Out-Null
 function Set-FixtureAcl([string]$Path,[string[]]$Readers=@(),[string]$Writer){
  $full=[IO.Path]::GetFullPath($Path)
  if($full -ine $root -and -not $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'fixture only'}
  Assert-V2LocalPath $full
  $directory=Test-Path -LiteralPath $full -PathType Container
  $acl=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($operatorSid))
  $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  $controllers=if($Writer){@('S-1-5-18','S-1-5-32-544')}else{@($operatorSid,'S-1-5-18','S-1-5-32-544')}
  foreach($sid in $controllers|Select-Object -Unique){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,'None','Allow'))}
  foreach($sid in $Readers){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'ReadAndExecute',$inherit,'None','Allow'))}
  if($Writer){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Writer),'Modify',$inherit,'None','Allow'))}
  Set-Acl -LiteralPath $full -AclObject $acl
 }
 Set-FixtureAcl $root
 function New-Durable([string]$Path,[byte[]]$Bytes){
  Assert-V2LocalPath $Path
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 }
 $lock=[IO.File]::Open((Join-Path $root 'controller.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $lock.WriteByte(1);$lock.Flush($true)
 function Journal($Value){
  if($evidence){$name=('{0:D2}-event.json' -f $script:journalIndex);$script:journalIndex++;Write-EvidenceDurable $evidence $name ([Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 5 -Compress))) $operatorSid}
 }
 Journal ([ordered]@{scope='DISPOSABLE_WINDOWS_SECURITY_ONLY';phase='EXCLUSIVE_ATTEMPT';nonce=$nonce;root=$root;native_sha256=$nativeHash;runner_sha256=$runnerHash;financial_authorization='NOT_GRANTED'})
 $stage='COMPILE'
 $bin=Join-Path $root 'bin';New-Item -ItemType Directory -Path $bin|Out-Null;Set-FixtureAcl $bin
 $exe=Join-Path $bin 'host.exe'
 $framework=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
 if(-not $framework.StartsWith('C:\Windows\Microsoft.NET\Framework64\',[StringComparison]::OrdinalIgnoreCase)){throw 'trusted Windows framework required'}
 $references=@('System.dll','System.Core.dll','System.Security.dll','System.ServiceProcess.dll','System.Web.Extensions.dll')|ForEach-Object {$path=Join-Path $framework $_;Assert-V2LocalPath $path;$path}
 Add-Type -Path $source -OutputAssembly $exe -OutputType ConsoleApplication -ReferencedAssemblies $references
 # Load a separate in-memory helper assembly; do not lock host.exe in the controller.
 Add-Type -Path $source -ReferencedAssemblies $references
 $rootId=[ObservationNative]::DirectoryIdentity($root)
 function Assert-OwnedRoot {
  Assert-V2LocalPath $root
  if([ObservationNative]::DirectoryIdentity($root) -cne $rootId -or (Split-Path -Leaf $root) -cne ('darkpool-winsec-'+$nonce)){throw 'fixture identity changed'}
 }
 Assert-OwnedRoot
 Journal ([ordered]@{phase='FIXTURE_DIRECTORY_BOUND';nonce=$nonce;root=$root;directory_identity=$rootId;host_sha256=(Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant()})
 $checks.Add('NATIVE_COMPILE_AND_LOAD')
 # Negative primitive checks run without privileges and never reach native mutation.
 foreach($badName in @('ZDPRehearsalPg','ZDPRecoveryOperator','Administrator','zdptbad')){
  $rejected=$false;try{[ObservationNative]::RequireFixtureName($badName)}catch{$rejected=$true};if(-not $rejected){throw 'name guard'}
 }
 $checks.Add('PERSISTENT_NAMES_REFUSED')
 foreach($work in @({[ObservationNative]::AddFixtureRights('S-1-5-18',@('SeServiceLogonRight'))},{[ObservationNative]::BindFixtureAccount('Administrator',$operatorSid)},{[ObservationNative]::Rights($operatorSid)})){
  $rejected=$false;try{& $work|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'unbound mutation guard'}
 }
 $checks.Add('UNBOUND_SID_AND_ACCOUNT_MUTATIONS_REFUSED')
 $currentType=[ObservationNative]::CurrentLogonType()
 if($currentType -eq 0){throw 'token query failed'}
 $checks.Add('NATIVE_LOGON_SESSION_QUERY')
 if($Action -ceq 'Rehearse'){
  $stage='COLLISION_PREFLIGHT'
  $purposes=@('postgres','viewer_controller','web','signer','backup_operator');$suffix=@('p','v','w','s','r')
  $profilesRoot=[Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory)
  if($profilesRoot -ine 'C:\Users'){throw 'profile root not reviewed'}
  $names=@();for($i=0;$i -lt 5;$i++){$name='zdpt'+$nonce.Substring(0,12)+$suffix[$i];[ObservationNative]::RequireFixtureName($name);$names+=@($name);if((Get-LocalUser -Name $name -ErrorAction SilentlyContinue) -or (Get-Service -Name $name -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $profilesRoot $name))){throw 'fixture name collision'}}
  $stage='ACCOUNT_CREATION'
  for($i=0;$i -lt 5;$i++){
   Assert-OwnedRoot
   $bytes=New-Object byte[] 48;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
   $text='Aa9!'+[Convert]::ToBase64String($bytes);$password=ConvertTo-SecureString $text -AsPlainText -Force;$text=$null;[Array]::Clear($bytes,0,$bytes.Length)
   $user=New-LocalUser -Name $names[$i] -Password $password -Disabled -UserMayNotChangePassword -Description ('Zcash disposable Windows fixture '+$nonce)
   $row=[pscustomobject]@{name=$user.Name;purpose=$purposes[$i];sid=$user.SID.Value;password=$password;token=[IntPtr]::Zero;profile=[IntPtr]::Zero;profile_path=$null;service_created=$false;service_binary=$null;rights_added=$false}
   $accounts.Add($row)
   Journal ([ordered]@{phase='ACCOUNT_CREATED_DISABLED';purpose=$row.purpose;name=$row.name;sid=$row.sid})
   [ObservationNative]::BindFixtureAccount($row.name,$row.sid)
   if(@($accounts|Where-Object sid -eq $row.sid).Count -ne 1 -or $user.Enabled){throw 'account identity'}
   $groups=@([ObservationNative]::LocalGroups($row.name));$usersGroup=(Get-LocalGroup -SID 'S-1-5-32-545').Name
   foreach($group in $groups){if($group -cne $usersGroup){throw 'unexpected account group'};Remove-LocalGroupMember -Group $group -Member $user.SID}
   if(@([ObservationNative]::LocalGroups($row.name)).Count -ne 0){throw 'group separation'}
   $batch=$row.purpose -in @('signer','backup_operator')
   $rights=@('SeDenyInteractiveLogonRight','SeDenyRemoteInteractiveLogonRight','SeDenyNetworkLogonRight')+$(if($batch){@('SeBatchLogonRight','SeDenyServiceLogonRight')}else{@('SeServiceLogonRight','SeDenyBatchLogonRight')})
   if(@([ObservationNative]::Rights($row.sid)).Count -ne 0){throw 'inherited direct rights'}
   [ObservationNative]::AddFixtureRights($row.sid,$rights);$row.rights_added=$true
   if(((@([ObservationNative]::Rights($row.sid))|Sort-Object) -join ',') -cne (($rights|Sort-Object)-join ',')){throw 'rights readback'}
  }
  $checks.Add('FIVE_DISTINCT_DISABLED_ACCOUNTS_AND_EXACT_RIGHTS')
  # A duplicate native create must not replace/reset the original account.
  $duplicateDenied=$false;try{New-LocalUser -Name $accounts[0].name -Password $accounts[0].password -Disabled -ErrorAction Stop|Out-Null}catch{$duplicateDenied=$true}
  if(-not $duplicateDenied -or (Get-LocalUser -Name $accounts[0].name).SID.Value -cne $accounts[0].sid){throw 'duplicate account replacement'}
  $checks.Add('REAL_ACCOUNT_COLLISION_REFUSED')
  $allSids=@($accounts|ForEach-Object sid)
  Set-FixtureAcl $root -Readers $allSids;Set-FixtureAcl $bin -Readers $allSids;Set-FixtureAcl $exe -Readers $allSids
  foreach($name in @('private','cross')){$path=Join-Path $root $name;New-Item -ItemType Directory -Path $path|Out-Null;Set-FixtureAcl $path -Readers $allSids}
  foreach($row in $accounts){$path=Join-Path $root ('private/'+$row.purpose);New-Item -ItemType Directory -Path $path|Out-Null;Set-FixtureAcl $path -Writer $row.sid;New-Durable (Join-Path $path 'synthetic.txt') ([Text.Encoding]::UTF8.GetBytes('SYNTHETIC_NONFINANCIAL_ACL_PROBE'));Set-FixtureAcl (Join-Path $path 'synthetic.txt') -Writer $row.sid}
  $scope=[ordered]@{scope='DISPOSABLE_WINDOWS_SECURITY_ONLY';root=$root;nonce=$nonce;directory_identity=$rootId;accounts=@($accounts|Select-Object purpose,name,sid);host_sha256=(Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant();financial_authorization='NOT_GRANTED'}
  $scopeFile=Join-Path $root 'scope.json';New-Durable $scopeFile ([Text.Encoding]::UTF8.GetBytes(($scope|ConvertTo-Json -Depth 5 -Compress)));Set-FixtureAcl $scopeFile -Readers $allSids
  $scopeHash=(Get-FileHash -LiteralPath $scopeFile).Hash.ToLowerInvariant()
  $stage='REAL_LOGON_AND_PROFILES'
  foreach($row in $accounts){
   Assert-OwnedRoot;if((Get-LocalUser -Name $row.name).SID.Value -cne $row.sid){throw 'SID substituted'}
   Enable-LocalUser -SID $row.sid
   $type=if($row.purpose -in @('signer','backup_operator')){4}else{5}
   foreach($deniedType in @(2,3,$(if($type -eq 5){4}else{5}))){if([ObservationNative]::DeniedLogon($row.name,$row.password,$deniedType) -ne 1385){throw 'logon denial not proven'}}
   $row.token=[ObservationNative]::Logon($row.name,$row.password,$type);[ObservationNative]::RequireSid($row.token,$row.sid)
   $substitutionDenied=$false;try{[ObservationNative]::RequireSid($row.token,$operatorSid)}catch{$substitutionDenied=$true};if(-not $substitutionDenied){throw 'token substitution'}
   $row.profile_path=Join-Path $profilesRoot $row.name
   Journal ([ordered]@{phase='PROFILE_CREATE_INTENT';name=$row.name;sid=$row.sid;profile_path=$row.profile_path})
   $row.profile=[ObservationNative]::LoadProfile($row.token,$row.name)
   if([ObservationNative]::ProfilePath($row.token) -ine $row.profile_path){throw 'profile identity'}
   Journal ([ordered]@{phase='REAL_LOGON_PROFILE_LOADED';name=$row.name;sid=$row.sid;logon_type=$type;profile_path=$row.profile_path})
  }
  $checks.Add('ACTUAL_LOGON_ALLOW_DENY_AND_SID_SUBSTITUTION')
  function Host-Arguments($Row,[string]$Phase){@($(if($Row.purpose -in @('signer','backup_operator')){'batch'}else{'service'}),$root,$nonce,$Row.purpose,$Row.sid,$Row.name,$Phase,$scopeHash)}
  $stage='SCM_INSTALL'
  foreach($row in $accounts|Where-Object {$_.purpose -notin @('signer','backup_operator')}){
   $arg=Host-Arguments $row 'own';$binary='"'+$exe+'" '+(($arg|ForEach-Object {'"'+$_+'"'}) -join ' ')
   Journal ([ordered]@{phase='SERVICE_CREATE_INTENT';name=$row.name;sid=$row.sid;binary_sha256=[ObservationNative]::Hash([Text.Encoding]::UTF8.GetBytes($binary))})
   [ObservationNative]::InstallFixtureService($row.name,$row.password,$binary);$row.service_created=$true;$row.service_binary=$binary
   Journal ([ordered]@{phase='SERVICE_CREATED_DISABLED';name=$row.name;sid=$row.sid})
  }
  $checks.Add('THREE_DISABLED_SCM_SERVICES_CREATED_WITH_PRIVATE_MEMORY_CREDENTIALS')
  foreach($phase in @('own','cross')){
   $stage=if($phase -ceq 'own'){'SERVICE_USER_DPAPI'}else{'CROSS_USER_DPAPI'}
   if($phase -ceq 'cross'){foreach($row in $accounts){$from=Join-Path $root ('private/'+$row.purpose+'/synthetic.dpapi');$to=Join-Path $root ('cross/'+$row.purpose+'.dpapi');New-Durable $to ([IO.File]::ReadAllBytes($from));Set-FixtureAcl $to -Readers $allSids}}
   foreach($row in $accounts){
    Assert-OwnedRoot;if((Get-LocalUser -Name $row.name).SID.Value -cne $row.sid -or (Get-FileHash -LiteralPath $scopeFile).Hash.ToLowerInvariant() -cne $scopeHash -or (Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant() -cne $scope.host_sha256){throw 'host binding'}
    $arg=Host-Arguments $row $phase
    if($row.service_created){$binary='"'+$exe+'" '+(($arg|ForEach-Object {'"'+$_+'"'}) -join ' ');[ObservationNative]::RunFixtureService($row.name,('.\'+$row.name),$row.service_binary,$binary);$row.service_binary=$binary}
    else{if([ObservationNative]::RunBatchProbe($row.token,$arg) -ne 0){throw 'batch probe'}}
    $resultPath=Join-Path $root ('private/'+$row.purpose+'/'+$phase+'-result.json')
    $result=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json
    if($result.status -cne 'PASS' -or $result.sid -cne $row.sid -or $result.phase -cne $phase -or $result.acl_denials -ne 8 -or -not $result.tool_write_denied -or -not $result.dpapi_roundtrip -or $result.residual_elevated_privileges -ne 0 -or ($phase -ceq 'cross' -and $result.cross_user_dpapi_denials -ne 4)){throw 'host probe not verified'}
    $hostResults.Add($result);Journal ([ordered]@{phase='HOST_PROBE_PASS';result=$result})
   }
  }
  $checks.Add('REAL_CROSS_ACCOUNT_READ_WRITE_DENIALS')
  $checks.Add('SERVICE_AND_BATCH_CURRENT_USER_DPAPI_ROUNDTRIP')
  $checks.Add('RESTARTED_IDENTITY_DPAPI_AND_FOUR_OTHER_USER_DECRYPT_DENIALS')
 }
}catch{
 $nativeCode=$null;$exception=$_.Exception
 while($exception){if($exception -is [ComponentModel.Win32Exception]){$nativeCode=$exception.NativeErrorCode};$exception=$exception.InnerException}
 $safeReason=if($_.Exception.Message -cin @('EVIDENCE_REPARSE_REJECTED','EVIDENCE_ACL_REJECTED','EVIDENCE_PATH_REJECTED','EVIDENCE_COLLISION','EVIDENCE_WRITE_FAILED')){$_.Exception.Message}else{switch($stage){'RELEASE_GATE'{'PERSISTENT_EXECUTION_DISABLED'};'AUTHORIZATION'{'ELEVATION_ACK_OR_PLATFORM_REQUIRED'};'EVIDENCE_PREFLIGHT'{'EVIDENCE_INITIALIZATION_FAILED'};default{'NATIVE_OPERATION_NOT_CONFIRMED'}}}
 $failure=[ordered]@{stage=$stage;reason=$safeReason;win32_code=$nativeCode}
 if($root -and $evidence){foreach($row in $accounts){foreach($phase in @('own','cross')){
  $candidate=Join-Path $root ('private/'+$row.purpose+'/'+$phase+'-result.json')
  if(Test-Path -LiteralPath $candidate -PathType Leaf){try{Assert-V2LocalPath $candidate;if((Get-Item -LiteralPath $candidate).Length -le 8192){$v=Get-Content -LiteralPath $candidate -Raw|ConvertFrom-Json;if($v.status -ceq 'FAIL' -and $v.stage -cin @('HOST_INPUTS','HOST_IDENTITY','LOGON_TYPE','PROFILE','TOKEN_RESTRICTION','ACL_DENIAL','DPAPI_PROTECT','DPAPI_CROSS')){Journal ([ordered]@{phase='HOST_PROBE_FAILED';purpose=$row.purpose;stage=$v.stage})}}}catch{}}
 }}}
}finally{
 # No name-only cleanup. Only exact accounts/SIDs/services created by this attempt.
 if($root -and (Test-Path -LiteralPath $root)){
  foreach($row in @($accounts.ToArray())|Sort-Object name -Descending){
   $clean=$true
   try{
    if(-not $rootId){throw 'unbound root'};Assert-OwnedRoot
    $actual=Get-LocalUser -Name $row.name -ErrorAction Stop
    if($actual.SID.Value -cne $row.sid -or $actual.Description -cne ('Zcash disposable Windows fixture '+$nonce)){throw 'account cleanup identity'}
    Disable-LocalUser -SID $row.sid
    if($row.service_created){[ObservationNative]::DeleteFixtureService($row.name,('.\'+$row.name),$row.service_binary);$row.service_created=$false}
    elseif(Get-Service -Name $row.name -ErrorAction SilentlyContinue){throw 'unconfirmed service creation'}
   }catch{$clean=$false;$cleanupErrors.Add('ACCOUNT_OR_SERVICE_IDENTITY_UNCONFIRMED')}
   try{if($row.profile -ne [IntPtr]::Zero){[ObservationNative]::UnloadProfile($row.token,$row.profile);$row.profile=[IntPtr]::Zero}}catch{$clean=$false;$cleanupErrors.Add('PROFILE_UNLOAD_UNCONFIRMED')}
   try{if($row.token -ne [IntPtr]::Zero){[ObservationNative]::CloseHandle($row.token)|Out-Null;$row.token=[IntPtr]::Zero}
    if($clean){
     if($row.profile_path){
      $profileKey='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$row.sid
      if(Test-Path -LiteralPath $profileKey){if((Get-ItemProperty -LiteralPath $profileKey).ProfileImagePath -ine $row.profile_path){throw 'profile cleanup identity'};Assert-V2LocalPath $row.profile_path;[ObservationNative]::DeleteFixtureProfile($row.sid,$row.profile_path,$row.name)}
      if((Test-Path -LiteralPath $profileKey) -or (Test-Path -LiteralPath $row.profile_path)){throw 'profile remains'}
     }
     if($row.rights_added){[ObservationNative]::RemoveFixtureRights($row.sid)}
     if((Get-LocalUser -Name $row.name).SID.Value -cne $row.sid){throw 'SID changed before delete'}
     Remove-LocalUser -SID $row.sid
     if(Get-LocalUser -Name $row.name -ErrorAction SilentlyContinue){throw 'account remains'}
     Journal ([ordered]@{phase='EXACT_FIXTURE_ACCOUNT_CLEANED';name=$row.name;sid=$row.sid})
    }
   }catch{$cleanupErrors.Add('ACCOUNT_PROFILE_OR_RIGHTS_CLEANUP_UNCONFIRMED')}
   if($row.password){$row.password.Dispose();$row.password=$null}
  }
  if($lock){$lock.Dispose();$lock=$null}
  if($cleanupErrors.Count -eq 0){
   try{
    if($rootId){Assert-OwnedRoot}else{Assert-V2LocalPath $root;if((Split-Path -Parent $root).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $root) -cne ('darkpool-winsec-'+$nonce)){throw 'unbound compile fixture'}}
    # Verify no reparse/hardlink escape before native PowerShell deletion.
    function Check-CleanupTree([string]$At){Assert-V2LocalPath $At;$item=Get-Item -LiteralPath $At -Force;if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $At -Force){Check-CleanupTree $child.FullName}}}
    Check-CleanupTree $root;Remove-Item -LiteralPath $root -Recurse -Force
    if(Test-Path -LiteralPath $root){throw 'fixture remains'}
   }catch{$cleanupErrors.Add('FIXTURE_DIRECTORY_CLEANUP_UNCONFIRMED')}
  }
 }
 if($Action -cne 'Inspect' -or $failure){
  $report=[ordered]@{scope='DISPOSABLE_WINDOWS_SECURITY_ONLY';status=$(if(-not $failure -and $cleanupErrors.Count -eq 0){'PASS'}else{'FAIL_OR_BLOCKED'});action=$Action;failure=$failure;checks=$checks.ToArray();host_results=$hostResults.ToArray();cleanup_confirmed=($cleanupErrors.Count -eq 0);cleanup_issues=$cleanupErrors.ToArray();fixture_root=$root;accounts_created=$accounts.Count;persistent_creation='DISABLED';financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}
  if($evidence){Save-NativeResult $report $evidence $operatorSid;$failure=$report.failure}
  $report|ConvertTo-Json -Depth 7
 }
}
if($failure -or $cleanupErrors.Count -gt 0){exit 1}

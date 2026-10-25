[CmdletBinding()]
param([ValidateSet('Capabilities','CreateAccounts','InstallHost','StartHost','FixtureAccess')][string]$Action='Capabilities', [string]$Directory)
$ErrorActionPreference='Stop'
$stage='GATE'
try {
 if($args.Count -ne 0){throw 'fixed inputs'}
 if($Action -in @('CreateAccounts','InstallHost','StartHost')){
  # Unconditional release gate BEFORE SCM, LSA, account, ACL or filesystem writes.
  throw 'PERSISTENT_WINDOWS_EXECUTION_DISABLED'
 }
 $who=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=[Security.Principal.WindowsPrincipal]::new($who)
 if($Action -eq 'Capabilities'){
  if($Directory){throw 'no target accepted'}
  [ordered]@{status='CAPABILITIES_ONLY';elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);account_creation='DISABLED';service_installation='DISABLED';actual_cross_account_test='NOT_RUN';actual_service_user_dpapi='NOT_RUN';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
  exit 0
 }
 $stage='FIXTURE_SCOPE'
 if($env:DARKPOOL_OBSERVATION_V1_TEST_ONLY -cne '1' -or $env:DARKPOOL_BACKUP_TEST_ONLY -cne '1'){throw 'fixture only'}
 . "$PSScriptRoot/v2-security.ps1"
 $full=[IO.Path]::GetFullPath($Directory)
 if((Split-Path -Parent $full).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $full) -cnotmatch '^darkpool-backup-fixture-[a-f0-9]{32}$'){throw 'fixture only'}
 Assert-V2LocalPath $full;Assert-V2Acl $full -ProtectedRoot
 $scope=Get-Content -LiteralPath (Join-Path $full 'security-scope.json') -Raw|ConvertFrom-Json
 if($scope.scope -cne 'WINDOWS_SECURITY_FIXTURE_ONLY' -or $scope.root -cne $full -or $scope.nonce -cnotmatch '^[a-f0-9]{32}$' -or @((Get-ChildItem -LiteralPath $full -Force)).Count -ne 1){throw 'fixture scope'}
 $stage='AUTHZ_FIXTURE'
 Add-Type -Path "$PSScriptRoot/observation-windows-access.cs"
 function Check($condition){if(-not $condition){throw 'fixture assertion'}}
 $purposes=@('postgres','viewer','web','signer','recovery')
 $sids=@{};for($i=0;$i -lt 5;$i++){$sids[$purposes[$i]]='S-1-5-21-111111111-222222222-333333333-'+(1000+$i)}
 $checks=0
 # Actual protected NTFS DACLs on newly created synthetic directories only.
 foreach($purpose in $purposes){
  $path=Join-Path $full $purpose;New-Item -ItemType Directory -Path $path|Out-Null
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($who.User)
  foreach($sid in @($who.User.Value,'S-1-5-18','S-1-5-32-544')){
   $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sids[$purpose]),'Modify','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $path -AclObject $acl
  $sd=(Get-Acl -LiteralPath $path).GetSecurityDescriptorBinaryForm()
  foreach($other in $purposes){
   $read=[ObservationWindowsAccess]::SidOnlyAccess($sd,$sids[$other],1)
   $write=[ObservationWindowsAccess]::SidOnlyAccess($sd,$sids[$other],2)
   Check ($read -eq ($other -ceq $purpose));Check ($write -eq ($other -ceq $purpose));$checks+=2
  }
  # A broad grant is detected by Windows Authz, not accepted as successful denial.
  $bad=[Security.AccessControl.DirectorySecurity]::new();$bad.SetSecurityDescriptorBinaryForm($sd)
  $bad.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sids['web']),'Read','Allow'))
  Check ([ObservationWindowsAccess]::SidOnlyAccess($bad.GetSecurityDescriptorBinaryForm(),$sids['web'],1));$checks++
 }
 $stage='TOOL_ACL_FIXTURE'
 $tool=Join-Path $full 'tool-copy';New-Item -ItemType Directory -Path $tool|Out-Null
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($who.User)
 foreach($sid in @($who.User.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 foreach($purpose in @('postgres','recovery')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sids[$purpose]),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))}
 Set-Acl -LiteralPath $tool -AclObject $acl;$sd=(Get-Acl -LiteralPath $tool).GetSecurityDescriptorBinaryForm()
 foreach($purpose in $purposes){Check (([ObservationWindowsAccess]::SidOnlyAccess($sd,$sids[$purpose],1)) -eq ($purpose -in @('postgres','recovery')));Check (-not [ObservationWindowsAccess]::SidOnlyAccess($sd,$sids[$purpose],2));$checks+=2}
 [ordered]@{status='WINDOWS_AUTHZ_FIXTURE_PASS';checks=$checks;context='SID_ONLY_NO_GROUPS_NOT_REAL_LOGON';actual_cross_account_test='NOT_RUN';actual_service_user_dpapi='NOT_RUN';persistent_created=$false;financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
}catch{
 [ordered]@{status='WINDOWS_SECURITY_BLOCKED';stage=$stage;reason=$(if($stage -ceq 'GATE'){'PERSISTENT_WINDOWS_EXECUTION_DISABLED'}else{'FIXTURE_VALIDATION_FAILED'});financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
 exit 1
}

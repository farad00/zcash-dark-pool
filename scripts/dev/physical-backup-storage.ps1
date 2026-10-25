[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('check','unsafe','repair')][string]$Action,[Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/v2-security.ps1"
try {
 if($env:DARKPOOL_PHYSICAL_REHEARSAL -cne '1'){throw 'fixture only'}
 $physicalRoot=[IO.Path]::GetFullPath($Directory)
 if((Split-Path -Parent $physicalRoot).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or
    (Split-Path -Leaf $physicalRoot) -cnotmatch '^darkpool-backup-fixture-[a-f0-9]{32}$'){throw 'fixture root required'}
 Assert-V2Acl $physicalRoot -ProtectedRoot
 if($Action -ne 'check'){
  $physicalProbe=Join-Path $physicalRoot 'unsafe-probe'
  Assert-V2LocalPath $physicalProbe
  if(-not (Test-Path -LiteralPath $physicalProbe -PathType Container)){throw 'fixture probe required'}
  if($Action -eq 'unsafe'){
   $physicalAcl=Get-Acl -LiteralPath $physicalProbe
   $physicalRule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'ReadAndExecute','Allow')
   $physicalAcl.AddAccessRule($physicalRule);Set-Acl -LiteralPath $physicalProbe -AclObject $physicalAcl
  }else{
   $physicalAcl=New-Object Security.AccessControl.DirectorySecurity
   $physicalAcl.SetAccessRuleProtection($false,$false)
   Set-Acl -LiteralPath $physicalProbe -AclObject $physicalAcl
  }
 }else{
  # Check each ancestor before descent; never follow a reparse point recursively.
  $physicalCurrentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $physicalAllowed=@($physicalCurrentSid,'S-1-5-18','S-1-5-32-544')
  function Test-PhysicalTree($At){
   if(($At.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'redirect rejected'}
   $physicalItemAcl=Get-Acl -LiteralPath $At.FullName
   if($physicalItemAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $physicalCurrentSid){throw 'owner rejected'}
   $physicalFull=$false
   foreach($physicalAccess in $physicalItemAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($physicalAccess.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $physicalAllowed -notcontains $physicalAccess.IdentityReference.Value){throw 'permission rejected'}
    if($physicalAccess.IdentityReference.Value -eq $physicalCurrentSid -and ($physicalAccess.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$physicalFull=$true}
   }
   if(-not $physicalFull){throw 'permission rejected'}
   if($At.PSIsContainer){foreach($physicalItem in Get-ChildItem -LiteralPath $At.FullName -Force){Test-PhysicalTree $physicalItem}}
  }
  # Root ancestors were checked above. The same owner/allowlist/full-control
  # rules are checked once per descendant, avoiding quadratic parent rechecks.
  Test-PhysicalTree (Get-Item -Force -LiteralPath $physicalRoot)
 }
 Write-Output 'PHYSICAL_STORAGE_OK'
}catch{Write-Output 'PHYSICAL_STORAGE_REJECTED';exit 1}

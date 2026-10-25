[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('configure','check','unsafe-fixture-acl')][string]$Action,[Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/v2-security.ps1"
try {
 if($env:DARKPOOL_UNFUNDED_PREPARATION_TEST_ONLY -cne '1'){throw 'fixture only'}
 $probeRoot=[IO.Path]::GetFullPath($FixtureRoot)
 if((Split-Path -Parent $probeRoot).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or
    (Split-Path -Leaf $probeRoot) -cnotmatch '^darkpool-unfunded-prep-[a-f0-9]{32}$'){throw 'fixture only'}
 Assert-V2LocalPath $probeRoot
 $probeScopePath=Join-Path $probeRoot 'fixture-scope.json'
 Assert-V2LocalPath $probeScopePath
 $probeScope=Get-Content -LiteralPath $probeScopePath -Raw|ConvertFrom-Json
 if($probeScope.root -cne $probeRoot -or $probeScope.classification -cne 'DISPOSABLE_TEST_ONLY' -or $probeScope.scope_id -cnotmatch '^[a-f0-9]{32}$'){throw 'fixture binding rejected'}
 $probeSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if($Action -eq 'configure'){
  $probeEntries=@(Get-ChildItem -LiteralPath $probeRoot -Force)
  if($probeEntries.Count -ne 1 -or $probeEntries[0].Name -cne 'fixture-scope.json'){throw 'fresh fixture required'}
  $probeAcl=New-Object Security.AccessControl.DirectorySecurity
  $probeAcl.SetOwner($probeSid);$probeAcl.SetAccessRuleProtection($true,$false)
  foreach($id in @($probeSid.Value,'S-1-5-18','S-1-5-32-544')){
   $identity=New-Object Security.Principal.SecurityIdentifier($id)
   $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
   $probeAcl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $probeRoot -AclObject $probeAcl
  $probeFileAcl=New-Object Security.AccessControl.FileSecurity
  $probeFileAcl.SetOwner($probeSid);$probeFileAcl.SetAccessRuleProtection($true,$false)
  foreach($id in @($probeSid.Value,'S-1-5-18','S-1-5-32-544')){
   $identity=New-Object Security.Principal.SecurityIdentifier($id)
   $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')
   $probeFileAcl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $probeScopePath -AclObject $probeFileAcl
 }elseif($Action -eq 'unsafe-fixture-acl'){
  Assert-V2Acl $probeRoot -ProtectedRoot
  $probeFile=Join-Path $probeRoot 'synthetic.json';Assert-V2LocalPath $probeFile
  $probeAcl=Get-Acl -LiteralPath $probeFile
  $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','Allow')
  $probeAcl.AddAccessRule($rule);Set-Acl -LiteralPath $probeFile -AclObject $probeAcl
 }else{
  Assert-V2Acl $probeRoot -ProtectedRoot
  foreach($entry in Get-ChildItem -LiteralPath $probeRoot -Force){
   if($entry.PSIsContainer -or $entry.Name -cnotmatch '^(fixture-scope\.json|synthetic\.json|(allocation|scan|observation)-attempt\.json)$'){throw 'fixture contents rejected'}
   Assert-V2Acl $entry.FullName
  }
 }
 Write-Output 'UNFUNDED_FIXTURE_STORAGE_PASS'
}catch{Write-Output 'UNFUNDED_FIXTURE_STORAGE_FAIL';exit 1}

[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('create','rewrap','check')][string]$Action,[Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
$stage=1
. "$PSScriptRoot/v2-security.ps1"
try {
 if($env:DARKPOOL_BACKUP_TEST_ONLY -cne '1'){throw 'synthetic only'}
 $full=[IO.Path]::GetFullPath($Directory)
 if((Split-Path -Parent $full).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or
    (Split-Path -Leaf $full) -cnotmatch '^darkpool-backup-fixture-[a-f0-9]{32}$'){throw 'fixture path required'}
 Assert-V2LocalPath $full
 if($Action -eq 'create'){
  if(Test-Path -LiteralPath $full){throw 'existing root'}
  New-Item -ItemType Directory -Path $full | Out-Null
  $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){
   $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $full -AclObject $acl
 }
 Assert-V2Acl $full -ProtectedRoot
 if($Action -eq 'rewrap'){
  $stage=2
  $inputText=[Console]::In.ReadToEnd();if($inputText.Length -gt 8192){throw 'input limit'}
  $records=ConvertFrom-Json $inputText
  foreach($record in $records){
   if($record.purpose -cnotmatch '^(owner|admin|watch|issue|read|oracle|coordinator|lock)$' -or
      $record.login -cnotmatch '^darkpool_[a-z0-9_]+_[a-f0-9]{16}$' -or $record.password -cnotmatch '^[a-f0-9]{64}$'){throw 'credential rejected'}
   $path=Join-Path $full ($record.purpose+'.xml')
   $stage=3
   $recoveryCredential=New-Object Management.Automation.PSCredential($record.login,(ConvertTo-SecureString $record.password -AsPlainText -Force))
   $xml=[Management.Automation.PSSerializer]::Serialize($recoveryCredential)
   $stage=4
   $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   try{$bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($xml);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
   Assert-V2Acl $path
   $stage=5
   $retained=Import-Clixml -LiteralPath $path
   $stage=6
   if($retained.UserName -cne $record.login){throw 'rewrap failed'}
   $stage=7
   if($retained.GetNetworkCredential().Password -cne $record.password){throw 'rewrap failed'}
  }
 }
 if($Action -eq 'check'){
  foreach($file in Get-ChildItem -LiteralPath $full -File){Assert-V2Acl $file.FullName}
 }
 Write-Output 'SYNTHETIC_STORAGE_OK'
}catch{Write-Output 'SYNTHETIC_STORAGE_REJECTED';exit $stage}

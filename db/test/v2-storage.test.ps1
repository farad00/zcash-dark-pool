$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../scripts/dev/v2-security.ps1')
$storageRoot=Join-Path ([IO.Path]::GetTempPath()) ('darkpool-v2-storage-'+[guid]::NewGuid().ToString('N'))
function Expect-StorageFailure([scriptblock]$Action) {
 $failed=$false;try{ & $Action }catch{$failed=$true};if(-not $failed){throw 'expected storage refusal'}
}
try {
 $storageStage='CREATE_TEMP'
 New-Item -ItemType Directory -Path $storageRoot | Out-Null
 # An inherited temporary directory is not an approved protected root.
 $storageStage='INHERITED_ACL';Expect-StorageFailure { Assert-V2Acl $storageRoot -ProtectedRoot }
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $storageRoot -AclObject $acl
 $storageStage='PROTECTED_ACL';Assert-V2Acl $storageRoot -ProtectedRoot
 $credentialPath=Join-Path $storageRoot 'synthetic.xml'
 $storageStage='CREDENTIAL_CREATE';$first=Write-V2Credential $credentialPath 'darkpool_synthetic_owner'
 $hash=(Get-FileHash -LiteralPath $credentialPath).Hash
 $storageStage='CREDENTIAL_RETRY';$second=Write-V2Credential $credentialPath 'darkpool_synthetic_owner'
 if($first.GetNetworkCredential().Password -cne $second.GetNetworkCredential().Password -or $hash -ne (Get-FileHash -LiteralPath $credentialPath).Hash){throw 'credential replaced'}
 $xml=[IO.File]::ReadAllText($credentialPath)
 if($xml.Contains($first.GetNetworkCredential().Password)){throw 'plaintext credential'}
 $storageStage='CREDENTIAL_CONFLICT';Expect-StorageFailure { Write-V2Credential $credentialPath 'different_login' | Out-Null }
 $storageStage='BROAD_ACL'
 $broadRoot=Join-Path $storageRoot 'broad';New-Item -ItemType Directory -Path $broadRoot | Out-Null
 $broadAcl=New-Object Security.AccessControl.DirectorySecurity;$broadAcl.SetAccessRuleProtection($true,$false)
 foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')),(New-Object Security.Principal.SecurityIdentifier('S-1-1-0')))) {
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$broadAcl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $broadRoot -AclObject $broadAcl
 Expect-StorageFailure { Assert-V2Acl $broadRoot -ProtectedRoot }
 # A junction to an ordinary synthetic directory must be refused, never followed.
 $link=Join-Path $storageRoot 'redirect'
 $storageStage='JUNCTION';New-Item -ItemType Junction -Path $link -Target $storageRoot | Out-Null
 Expect-StorageFailure { Assert-V2LocalPath $link }
 [IO.Directory]::Delete($link)
 Write-Output 'V2_SYNTHETIC_STORAGE_PASS'
} catch {
 Write-Output ('V2_SYNTHETIC_STORAGE_FAIL:'+ $storageStage+':'+$_.Exception.GetType().Name+':'+$_.InvocationInfo.ScriptLineNumber)
 if($_.Exception.InnerException -is [Security.Cryptography.CryptographicException]){Write-Output $_.Exception.InnerException.Message}
 exit 1
}
finally {
 # Only this newly generated temporary root may be removed.
 if([IO.Path]::GetFullPath($storageRoot).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path -Leaf $storageRoot) -match '^darkpool-v2-storage-[a-f0-9]{32}$') {
  $redirect=Join-Path $storageRoot 'redirect'
  if(Test-Path -LiteralPath $redirect){[IO.Directory]::Delete($redirect)}
  Remove-Item -LiteralPath $storageRoot -Recurse -Force -ErrorAction SilentlyContinue
 }
}

[CmdletBinding()]
param([string]$Root, [string]$Credential)
$ErrorActionPreference='Stop'

function Assert-V2LocalPath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.?([\\/]|$)') { throw 'V2 storage rejected' }
  $candidate=[IO.Path]::GetFullPath($Path)
  while ($candidate) {
    if (Test-Path -LiteralPath $candidate) {
      $item=Get-Item -Force -LiteralPath $candidate
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'V2 storage rejected' }
    }
    $parent=Split-Path -Parent $candidate
    if ($parent -eq $candidate) { break }; $candidate=$parent
  }
}

function Assert-V2Acl([string]$Path, [switch]$ProtectedRoot) {
  Assert-V2LocalPath $Path
  $item=Get-Item -Force -LiteralPath $Path
  $acl=Get-Acl -LiteralPath $Path
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed=@($sid,'S-1-5-18','S-1-5-32-544')
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or
      ($ProtectedRoot -and (-not $acl.AreAccessRulesProtected -or -not $item.PSIsContainer))) { throw 'V2 storage rejected' }
  $currentFull=$false
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $allowed -notcontains $rule.IdentityReference.Value) { throw 'V2 storage rejected' }
    if ($rule.IdentityReference.Value -eq $sid -and
        ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $currentFull=$true }
  }
  if (-not $currentFull) { throw 'V2 storage rejected' }
}

function Write-V2Credential([string]$Path, [string]$User) {
  Assert-V2Acl (Split-Path -Parent $Path) -ProtectedRoot
  if (Test-Path -LiteralPath $Path) {
    Assert-V2Acl $Path
    if ((Get-Item -LiteralPath $Path).PSIsContainer) { throw 'V2 credential rejected' }
    $retained=Import-Clixml -LiteralPath $Path
    if ($retained -isnot [Management.Automation.PSCredential] -or $retained.UserName -cne $User -or
        $retained.GetNetworkCredential().Password -cnotmatch '^[a-f0-9]{64}$') { throw 'V2 credential rejected' }
    return $retained
  }
  $bytes=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $password=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
  $credential=New-Object Management.Automation.PSCredential($User,(ConvertTo-SecureString $password -AsPlainText -Force))
  $serialized=[Management.Automation.PSSerializer]::Serialize($credential)
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $encoded=(New-Object Text.UTF8Encoding($false)).GetBytes($serialized); $stream.Write($encoded,0,$encoded.Length); $stream.Flush($true) }
  finally { $stream.Dispose(); $password=$null; $serialized=$null; [Array]::Clear($bytes,0,$bytes.Length) }
  Assert-V2Acl $Path
  # Validate actual DPAPI roundtrip before the credential can be installed in SQL.
  $readback=Import-Clixml -LiteralPath $Path
  if ($readback.UserName -cne $User -or $readback.GetNetworkCredential().Password -cne $credential.GetNetworkCredential().Password) { throw 'V2 credential rejected' }
  return $readback
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    if (-not $Root -or $Credential -cnotmatch '^(maintenance|owner|admin|watch|issue|read)\.xml$') { throw 'V2 storage rejected' }
    Assert-V2Acl $Root -ProtectedRoot
    $file=Join-Path $Root $Credential
    Assert-V2Acl $file
    if ((Get-Item -LiteralPath $file).PSIsContainer) { throw 'V2 storage rejected' }
    Write-Output 'V2_STORAGE_OK'
  } catch { Write-Output 'V2_STORAGE_REJECTED'; exit 1 }
}

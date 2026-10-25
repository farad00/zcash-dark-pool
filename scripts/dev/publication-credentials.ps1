[CmdletBinding()]
param(
  [ValidateSet('Store','Check','Launch')][string]$Action,
  [string]$ExpiresAt,
  [string]$ApprovedPlanSha256,
  [switch]$PublicationAcknowledged
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# No test/root/entrypoint overrides in the command-line interface. Helpers are
# dot-sourceable for disposable synthetic tests; dot-sourcing performs no action.
function Get-PublicationSid {
  if([Environment]::OSVersion.Platform -ne 'Win32NT'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    return $identity.User.Value
  } finally {$identity.Dispose()}
}
function Assert-PublicationPath([string]$Path) {
  if($Path -cnotmatch '^[A-Za-z]:[\\/]' -or $Path -match '(^|[\\/])\.\.?([\\/]|$)'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $candidate=[IO.Path]::GetFullPath($Path)
  while($candidate){
    if(Test-Path -LiteralPath $candidate){
      if(((Get-Item -Force -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    }
    $parent=Split-Path -Parent $candidate
    if($parent -eq $candidate){break};$candidate=$parent
  }
}
function Get-PublicationRoot {
  $known=[Environment]::GetFolderPath('LocalApplicationData')
  if(-not $known -or $env:LOCALAPPDATA -ine $known){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $root=Join-Path $known 'ZcashDarkPoolPublication'
  Assert-PublicationPath $root
  return $root
}
function Assert-PublicationAcl([string]$Path,[switch]$Root) {
  Assert-PublicationPath $Path
  $sid=Get-PublicationSid
  $item=Get-Item -Force -LiteralPath $Path
  if(($Root -and -not $item.PSIsContainer) -or (-not $Root -and $item.PSIsContainer)){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $acl=Get-Acl -LiteralPath $Path
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid -or ($Root -and -not $acl.AreAccessRulesProtected)){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $full=$false
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($rule.AccessControlType -ne 'Allow' -or @($sid,'S-1-5-18','S-1-5-32-544') -notcontains $rule.IdentityReference.Value){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    if($rule.IdentityReference.Value -ceq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$full=$true}
  }
  if(-not $full){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
}
function Initialize-PublicationRoot([string]$Root) {
  Assert-PublicationPath $Root
  if(Test-Path -LiteralPath $Root){Assert-PublicationAcl $Root -Root;return}
  $sid=New-Object Security.Principal.SecurityIdentifier((Get-PublicationSid))
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  foreach($allowed in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
    $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($allowed)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  # Apply the security descriptor at directory creation, before writing anything.
  $directory=New-Object IO.DirectoryInfo($Root);$directory.Create($acl)
  Assert-PublicationAcl $Root -Root
}
function Get-PublicationExpiry([string]$Value) {
  if($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $parsed=[DateTimeOffset]::ParseExact($Value,[string[]]@("yyyy-MM-dd'T'HH:mm:ss'Z'","yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),[Globalization.CultureInfo]::InvariantCulture,([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal))
  if($parsed -le [DateTimeOffset]::UtcNow.AddSeconds(30)){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  return $parsed.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture)
}
function Assert-PublicationFields($Value,[string[]]$Fields) {
  if($null -eq $Value -or $Value -isnot [Management.Automation.PSCustomObject]){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $names=@($Value.PSObject.Properties.Name)
  if($names.Count -ne $Fields.Count -or @($names|Where-Object {$Fields -cnotcontains $_}).Count){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
}
function Get-PublicationEntropy {
  return ,([Text.Encoding]::UTF8.GetBytes("DARKPOOL_GITHUB_PUBLICATION_CREDENTIAL_V1`01427973036"))
}
function Read-PublicationCredential([string]$Root) {
  $cipher=$null;$plain=$null;$text=$null;$payload=$null;$stream=$null
  try {
    Assert-PublicationAcl $Root -Root
    $path=Join-Path $Root 'github-token.json';Assert-PublicationAcl $path
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    if($stream.Length -lt 1 -or $stream.Length -gt 32768){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $reader=New-Object IO.StreamReader($stream,(New-Object Text.UTF8Encoding($false,$true)))
    try {$record=$reader.ReadToEnd()|ConvertFrom-Json} finally {$reader.Dispose();$stream=$null}
    Assert-PublicationFields $record @('version','protected_payload')
    if($record.version -isnot [int] -or $record.version -ne 1 -or $record.protected_payload -isnot [string]){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $cipher=[Convert]::FromBase64String($record.protected_payload)
    if([Convert]::ToBase64String($cipher) -cne $record.protected_payload){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    Add-Type -AssemblyName System.Security
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,(Get-PublicationEntropy),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($plain)
    $payload=$text|ConvertFrom-Json
    Assert-PublicationFields $payload @('version','kind','repository','repository_id','user_sid','expires_at','token')
    foreach($field in @('kind','repository','repository_id','user_sid','expires_at','token')){if($payload.$field -isnot [string]){throw 'PUBLICATION_CREDENTIAL_REJECTED'}}
    if($payload.version -isnot [int] -or $payload.version -ne 1 -or $payload.kind -cne 'DARKPOOL_GITHUB_CREDENTIAL_V1' -or $payload.repository -cne 'https://github.com/farad00/zcash-dark-pool-commitments' -or $payload.repository_id -cne '1427973036' -or $payload.user_sid -cne (Get-PublicationSid) -or $payload.token -cnotmatch '^[A-Za-z0-9_]{20,512}\z'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $canonicalExpiry=Get-PublicationExpiry $payload.expires_at
    if($canonicalExpiry -cne $payload.expires_at){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    return $payload
  } catch {throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  finally {
    if($stream){$stream.Dispose()}
    if($plain){[Array]::Clear($plain,0,$plain.Length)}
    if($cipher){[Array]::Clear($cipher,0,$cipher.Length)}
    $text=$null;$payload=$null
  }
}
function Write-PublicationCredential([string]$Root,[Security.SecureString]$Secret,[string]$Expiry) {
  $bstr=[IntPtr]::Zero;$token=$null;$json=$null;$bytes=$null;$cipher=$null;$check=$null
  try {
    $canonicalExpiry=Get-PublicationExpiry $Expiry
    Initialize-PublicationRoot $Root
    $path=Join-Path $Root 'github-token.json'
    if(Test-Path -LiteralPath $path){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if($token -cnotmatch '^[A-Za-z0-9_]{20,512}\z'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $json=[ordered]@{version=1;kind='DARKPOOL_GITHUB_CREDENTIAL_V1';repository='https://github.com/farad00/zcash-dark-pool-commitments';repository_id='1427973036';user_sid=(Get-PublicationSid);expires_at=$canonicalExpiry;token=$token}|ConvertTo-Json -Compress
    $bytes=[Text.Encoding]::UTF8.GetBytes($json)
    Add-Type -AssemblyName System.Security
    $cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,(Get-PublicationEntropy),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $record=[ordered]@{version=1;protected_payload=[Convert]::ToBase64String($cipher)}|ConvertTo-Json -Compress
    $encoded=[Text.Encoding]::UTF8.GetBytes($record)
    $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$file.Write($encoded,0,$encoded.Length);$file.Flush($true)} finally {$file.Dispose()}
    Assert-PublicationAcl $path
    $check=Read-PublicationCredential $Root
    if($check.token -cne $token){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  } catch {throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  finally {
    if($bstr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
    if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
    if($cipher){[Array]::Clear($cipher,0,$cipher.Length)}
    $token=$null;$json=$null;$check=$null
  }
}
function New-PublicationChild([string]$Node,[string]$Entry,[string]$WorkingDirectory,[string]$Token,[string]$Expiry,[string]$Plan,[string]$EvidenceDirectory) {
  # Source files are fixed by the CLI, in the operator-trusted checkout. OneDrive
  # cloud placeholders are present there. Reject link/junction redirection while
  # permitting that existing source layout; NEVER apply this exception to data.
  foreach($path in @($Node,$Entry,$WorkingDirectory)){
    if($path -cnotmatch '^[A-Za-z]:[\\/]' -or $path -match '["\r\n]' -or $path -match '(^|[\\/])\.\.?([\\/]|$)'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $candidate=[IO.Path]::GetFullPath($path)
    while($candidate){
      $item=Get-Item -Force -LiteralPath $candidate
      if($item.LinkType){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
      $parent=Split-Path -Parent $candidate;if($parent -eq $candidate){break};$candidate=$parent
    }
  }
  Assert-PublicationPath $EvidenceDirectory
  if($EvidenceDirectory -match '["\r\n]'){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$Node;$start.Arguments='"'+$Entry+'"';$start.WorkingDirectory=$WorkingDirectory
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.EnvironmentVariables.Clear()
  foreach($name in @('SystemRoot','WINDIR','TEMP','TMP')){
    $value=[Environment]::GetEnvironmentVariable($name,'Process');if($null -ne $value){$start.EnvironmentVariables[$name]=$value}
  }
  $start.EnvironmentVariables['DARKPOOL_GITHUB_TOKEN']=$Token
  $start.EnvironmentVariables['DARKPOOL_GITHUB_TOKEN_EXPIRES_AT']=$Expiry
  $start.EnvironmentVariables['DARKPOOL_SYNTHETIC_APPROVED_PLAN']=$Plan
  $start.EnvironmentVariables['DARKPOOL_SYNTHETIC_WORKDIR']=$EvidenceDirectory
  return $start
}
function Invoke-PublicationChild([Diagnostics.ProcessStartInfo]$Start,[int]$TimeoutMilliseconds=60000) {
  $child=New-Object Diagnostics.Process;$child.StartInfo=$Start
  $outText=$null;$token=$Start.EnvironmentVariables['DARKPOOL_GITHUB_TOKEN']
  $outBuffer=New-Object char[] 8193;$errBuffer=New-Object char[] 1
  try {
    if(-not $child.Start()){throw 'PUBLICATION_LAUNCH_UNCONFIRMED_RECONCILE'}
    $child.StandardInput.Close()
    $stdout=$child.StandardOutput.ReadBlockAsync($outBuffer,0,$outBuffer.Length)
    $stderr=$child.StandardError.ReadBlockAsync($errBuffer,0,$errBuffer.Length)
    if(-not $child.WaitForExit($TimeoutMilliseconds)){$child.Kill();$child.WaitForExit();throw 'PUBLICATION_LAUNCH_UNCONFIRMED_RECONCILE'}
    $outCount=$stdout.GetAwaiter().GetResult();$errCount=$stderr.GetAwaiter().GetResult()
    $outText=New-Object string($outBuffer,0,$outCount)
    if($child.ExitCode -ne 0 -or $outCount -gt 8192 -or $errCount -ne 0 -or $outText.Contains($token)){throw 'PUBLICATION_LAUNCH_UNCONFIRMED_RECONCILE'}
    $v=$outText|ConvertFrom-Json
    Assert-PublicationFields $v @('scope','status','repository_id','commit','content_sha256','financial_authorization')
    if($v.scope -cne 'SYNTHETIC_TEST_ONLY' -or $v.status -cne 'GITHUB_FILE_RETRIEVED_NO_RECEIPT' -or $v.repository_id -cne '1427973036' -or $v.commit -cnotmatch '^[0-9a-f]{40}\z' -or $v.content_sha256 -cne '657516b70067fa75c284359428acb75d92fb300a7b136133c3865a3d56843a2c' -or $v.financial_authorization -cne 'NOT_GRANTED'){throw 'PUBLICATION_LAUNCH_UNCONFIRMED_RECONCILE'}
    return [ordered]@{scope='SYNTHETIC_TEST_ONLY';status='GITHUB_FILE_RETRIEVED_NO_RECEIPT';repository_id='1427973036';commit=[string]$v.commit;content_sha256='657516b70067fa75c284359428acb75d92fb300a7b136133c3865a3d56843a2c';financial_authorization='NOT_GRANTED'}
  } catch {throw 'PUBLICATION_LAUNCH_UNCONFIRMED_RECONCILE'}
  finally {
    $Start.EnvironmentVariables.Remove('DARKPOOL_GITHUB_TOKEN');$Start.EnvironmentVariables.Remove('DARKPOOL_GITHUB_TOKEN_EXPIRES_AT')
    [Array]::Clear($outBuffer,0,$outBuffer.Length);[Array]::Clear($errBuffer,0,$errBuffer.Length)
    $token=$null;$outText=$null;$child.Dispose()
  }
}
function Write-PublicationMarker([string]$Path,$Value) {
  Assert-PublicationPath $Path
  $file=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Compress));$file.Write($bytes,0,$bytes.Length);$file.Flush($true)} finally {$file.Dispose()}
}
if($MyInvocation.InvocationName -ne '.') {
  $secret=$null;$credential=$null
  try {
    if(-not $Action){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $plan='bffc49f876bf71c34384c4df81253ddc7021030c55f31bf2d764f8b6dc60574f'
    if($Action -eq 'Launch' -and (-not $PublicationAcknowledged -or $ApprovedPlanSha256 -cne $plan)){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
    $null=Get-PublicationSid
    $root=Get-PublicationRoot
    if($Action -eq 'Store') {
      if(-not $ExpiresAt){$ExpiresAt=Read-Host 'Actual GitHub token expiry, UTC (YYYY-MM-DDTHH:MM:SSZ)'}
      $ExpiresAt=Get-PublicationExpiry $ExpiresAt
      Assert-PublicationPath $root
      if(Test-Path -LiteralPath (Join-Path $root 'github-token.json')){throw 'PUBLICATION_CREDENTIAL_REJECTED'}
      $secret=Read-Host 'GitHub publisher token (local masked input only)' -AsSecureString
      Write-PublicationCredential $root $secret $ExpiresAt
      [ordered]@{status='STORED';repository_id='1427973036';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
    } elseif($Action -eq 'Check') {
      $credential=Read-PublicationCredential $root
      [ordered]@{status='READY_LOCAL_CHECK_ONLY';repository_id='1427973036';expires_at=$credential.expires_at;github_permissions='NOT_CHECKED';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
    } else {
      Assert-PublicationAcl $root -Root
      $marker=Join-Path $root ('publication-'+$plan+'.attempt.json')
      if(Test-Path -LiteralPath $marker){throw 'PUBLICATION_LAUNCH_UNCONFIRMED_RECONCILE'}
      $repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
      $node=Join-Path $repo '.tools/node-v24.21.0-win-x64/node.exe'
      $entry=Join-Path $repo 'services/publication/github-publish-cli.mjs'
      foreach($path in @($node,$entry)){if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'PUBLICATION_CREDENTIAL_REJECTED'}}
      $credential=Read-PublicationCredential $root
      $parent=Join-Path $root 'runs';Assert-PublicationPath $parent
      Initialize-PublicationRoot $parent
      $evidence=Join-Path $parent ([Guid]::NewGuid().ToString('N'));Initialize-PublicationRoot $evidence
      Write-PublicationMarker $marker ([ordered]@{scope='SYNTHETIC_TEST_ONLY';plan_sha256=$plan;started_at=[DateTime]::UtcNow.ToString('o');evidence_directory=$evidence;financial_authorization='NOT_GRANTED'})
      $start=New-PublicationChild $node $entry $repo $credential.token $credential.expires_at $plan $evidence
      $credential=$null
      $result=Invoke-PublicationChild $start
      $result['evidence_directory']=$evidence
      $result|ConvertTo-Json -Compress
    }
  } catch {[Console]::Error.WriteLine('PUBLICATION_OPERATION_NOT_CONFIRMED; retain original credentials and attempt markers; no automatic retry.');exit 1}
  finally {if($secret){$secret.Dispose()};$credential=$null;$secret=$null}
}

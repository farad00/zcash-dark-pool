# Shared fixed-policy staging implementation. Dot-source only; never launches PG.
# Synthetic contexts require a fresh, identity-bound direct TEMP child.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
. "$PSScriptRoot/v2-security.ps1"

function Get-PgStageProfile {
 $repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
 $p=Get-Content -LiteralPath (Join-Path $repo 'services/rehearsal-preparation/postgresql-tools/profile.json') -Raw|ConvertFrom-Json
 if($p.profile -cne 'POSTGRESQL_CONTROLLED_STAGE_V1' -or $p.destination -cne 'C:\ZcashTools\PostgreSQL\18.6-5' -or
    $p.archive_sha256 -cne 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2' -or
    $p.inventory_sha256 -cne '16a59b60f7b18e8eddc8c95a935081a08d8419c760e9838c1a1fd173369ac2db' -or
    $p.archive_relative -cne '.tools/postgresql-18.6-windows-x64.zip' -or $p.archive_bytes -ne 384620317 -or
    $p.inventory_files -ne 1585 -or $p.inventory_directories -ne 87 -or $p.inventory_bytes -ne 147931704 -or
    $p.version -cne '18.6' -or $p.build -cne '18.6-5' -or $p.architecture -cne 'windows-x64' -or
    $p.provenance_policy -cne 'EDB_HTTPS_CHECKSUM_AND_FIXED_LOCAL_PIN_V1' -or
    $p.checksum_filename -cne 'postgresql-18.6-5-windows-x64-binaries.zip' -or
    $p.checksum_url -cne 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip.sha256' -or
    $p.execution_approval -cne 'NOT_GRANTED' -or $p.financial_authorization -cne 'NOT_GRANTED'){throw 'PG_PROFILE_REJECTED'}
 return $p
}
function Get-PgBytesHash([byte[]]$Bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Get-PgStreamHash($Stream,[long]$Limit){
 $sha=[Security.Cryptography.SHA256]::Create();$buffer=New-Object byte[] 65536;$total=0L
 try{
  while(($n=$Stream.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$n;if($total -gt $Limit){throw 'PG_SIZE_REJECTED'};[void]$sha.TransformBlock($buffer,0,$n,$buffer,0)}
  [void]$sha.TransformFinalBlock($buffer,0,0)
  return @{sha256=([BitConverter]::ToString($sha.Hash)).Replace('-','').ToLowerInvariant();size=$total}
 }finally{$sha.Dispose()}
}
function Convert-PgVendorChecksum([byte[]]$Bytes,$Profile){
 if($Bytes.Length -gt 512){throw 'PG_VENDOR_CHECKSUM_REJECTED'}
 $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($Bytes)
 $pattern='\A([a-f0-9]{64})(?:  '+[regex]::Escape($Profile.checksum_filename)+')?\r?\n?\z'
 $match=[regex]::Match($text,$pattern)
 if(-not $match.Success -or $match.Groups[1].Value -cne $Profile.archive_sha256){throw 'PG_VENDOR_CHECKSUM_REJECTED'}
 return [ordered]@{status='VENDOR_HTTPS_CHECKSUM_VERIFIED';policy=$Profile.provenance_policy;url=$Profile.checksum_url;
   archive_sha256=$match.Groups[1].Value;body_sha256=(Get-PgBytesHash $Bytes);retrieved_utc=[DateTime]::UtcNow.ToString('o');signature='NOT_A_DETACHED_SIGNATURE'}
}
function Get-PgVendorChecksum($Profile){
 # No redirects, credentials, proxy overrides, TLS callbacks or retries.
 $req=[Net.HttpWebRequest]::Create($Profile.checksum_url);$req.Method='GET';$req.AllowAutoRedirect=$false;$req.Timeout=15000;$req.ReadWriteTimeout=15000
 $response=$null;$stream=$null;$memory=New-Object IO.MemoryStream
 try{
  $response=$req.GetResponse();if([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 512 -or $response.ResponseUri.AbsoluteUri -cne $Profile.checksum_url){throw 'PG_VENDOR_UNAVAILABLE'}
  $stream=$response.GetResponseStream();$buffer=New-Object byte[] 128
  while(($n=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($memory.Length+$n -gt 512){throw 'PG_VENDOR_UNAVAILABLE'};$memory.Write($buffer,0,$n)}
  return Convert-PgVendorResponse ([int]$response.StatusCode) $response.ResponseUri.AbsoluteUri $memory.ToArray() $Profile
 }finally{if($stream){$stream.Dispose()};if($response){$response.Dispose()};$memory.Dispose()}
}
function Convert-PgVendorResponse([int]$Status,[string]$Url,[byte[]]$Bytes,$Profile){
 if($Status -ne 200 -or $Url -cne $Profile.checksum_url){throw 'PG_VENDOR_UNAVAILABLE'}
 return Convert-PgVendorChecksum $Bytes $Profile
}
function Assert-PgRelative([string]$Path){
 if(-not $Path -or $Path.Length -gt 220 -or $Path -match '[\x00-\x1f\x7f\\:<>"|?*]'){throw 'PG_ARCHIVE_PATH_REJECTED'}
 foreach($part in $Path.Split('/')){if(-not $part -or $part -in @('.','..') -or $part -match '[. ]$|^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)'){throw 'PG_ARCHIVE_PATH_REJECTED'}}
}
function New-PgManifest($Files,$Directories){
 [string[]]$names=@($Files.Keys);[Array]::Sort($names,[StringComparer]::Ordinal)
 [string[]]$dirs=@($Directories.Keys);[Array]::Sort($dirs,[StringComparer]::Ordinal)
 $records=@(foreach($name in $names){$Files[$name]})
 return [ordered]@{profile='POSTGRESQL_RUNTIME_INVENTORY_V1';version='18.6';architecture='windows-x64';directories=$dirs;files=$records}
}
function Get-PgManifestHash($Manifest){return Get-PgBytesHash ([Text.Encoding]::UTF8.GetBytes(($Manifest|ConvertTo-Json -Depth 6 -Compress)))}
function Assert-PgProductionInventory($Manifest,[long]$ArchiveBytes){
 # This exact read-only production gate is also exercised under PowerShell 5.1.
 # Measure-Object cannot read dictionary keys as properties on these records.
 $p=Get-PgStageProfile
 [long]$inventoryBytes=0
 foreach($file in $Manifest.files){$inventoryBytes += [long]$file['size']}
 if($ArchiveBytes -ne $p.archive_bytes){throw 'PG_ARCHIVE_SIZE_REJECTED'}
 if(@($Manifest.files).Count -ne $p.inventory_files -or @($Manifest.directories).Count -ne $p.inventory_directories){throw 'PG_INVENTORY_COUNT_REJECTED'}
 if($inventoryBytes -ne $p.inventory_bytes){throw 'PG_INVENTORY_BYTES_REJECTED'}
}
function Get-PgFailureReason($Record){
 # Never serialize exception text, target paths, inner exceptions or stack traces.
 # Only an exact, fixed code may pass through; everything else is redacted.
 $allowed=@('PG_PROFILE_REJECTED','PG_ARGUMENTS_REJECTED','PG_EXTRACTION_APPROVAL_REQUIRED','PG_ADMIN_REQUIRED',
  'PG_VENDOR_CHECKSUM_REJECTED','PG_VENDOR_UNAVAILABLE','PG_SIZE_REJECTED','PG_ARCHIVE_PATH_REJECTED',
  'PG_ARCHIVE_ALIAS_REJECTED','PG_LAYOUT_REJECTED','PG_CONTEXT_REJECTED','PG_ACL_REJECTED',
  'PG_CREATE_ONLY_DIRECTORY_REJECTED','PG_METADATA_REJECTED','PG_EXTRA_FILE_REJECTED',
  'PG_INVENTORY_REJECTED','PG_RECEIPT_REJECTED','PG_PROVENANCE_REQUIRED','PG_DESTINATION_OCCUPIED',
  'PG_ARCHIVE_HASH_REJECTED','PG_FILE_HASH_REJECTED','PG_WRITE_PATH_REJECTED',
  'PG_ARCHIVE_SIZE_REJECTED','PG_INVENTORY_COUNT_REJECTED','PG_INVENTORY_BYTES_REJECTED')
 if($Record.Exception.Message -cin $allowed){return $Record.Exception.Message}
 if($Record.Exception.Message -ceq 'V2 storage rejected'){return 'PG_LOCAL_PATH_REJECTED'}
 # Inspect types only, including native/IO wrapper causes; never output messages.
 $exception=$Record.Exception
 while($exception){
  if($exception -is [UnauthorizedAccessException]){return 'PG_ACCESS_DENIED'}
  if($exception -is [Net.WebException]){return 'PG_VENDOR_UNAVAILABLE'}
  if($exception -is [IO.IOException]){return 'PG_IO_FAILURE'}
  $exception=$exception.InnerException
 }
 return 'PG_UNEXPECTED_FAILURE'
}
function Get-PgArchiveManifest($Archive){
 $files=@{};$dirs=@{};$all=@{};$spellings=@{};$total=0L
 foreach($entry in $Archive.Entries){
  if($entry.FullName -cnotmatch '^pgsql/(bin/|lib/|share/|server_license\.txt$|commandlinetools_3rd_party_licenses\.txt$)'){continue}
  $relative=$entry.FullName.Substring(6).TrimEnd('/');Assert-PgRelative $relative
  # No symlink/device entries, duplicate names, case aliases or file/dir collisions.
  $unixType=($entry.ExternalAttributes -shr 16) -band 61440
  if($unixType -notin @(0,16384,32768) -or $all.ContainsKey($relative.ToLowerInvariant())){throw 'PG_ARCHIVE_ALIAS_REJECTED'}
  $isDir=$entry.FullName.EndsWith('/');$all[$relative.ToLowerInvariant()]=@{path=$relative;directory=$isDir}
  if($isDir){$dirs[$relative]=$true;continue}
  if($entry.Length -gt 33554432 -or $entry.Length -lt 0){throw 'PG_SIZE_REJECTED'}
  $total+=$entry.Length;if($total -gt 268435456 -or $files.Count -ge 4096){throw 'PG_SIZE_REJECTED'}
  $stream=$entry.Open();try{$h=Get-PgStreamHash $stream 33554432}finally{$stream.Dispose()}
  if($h.size -ne $entry.Length){throw 'PG_SIZE_REJECTED'}
  $files[$relative]=[ordered]@{path=$relative;size=$h.size;sha256=$h.sha256}
 }
 foreach($path in @($all.Keys)){
  $record=$all[$path];$parent=$record.path
  if($spellings.ContainsKey($parent.ToLowerInvariant()) -and $spellings[$parent.ToLowerInvariant()] -cne $parent){throw 'PG_ARCHIVE_ALIAS_REJECTED'}
  $spellings[$parent.ToLowerInvariant()]=$parent
  while($parent.Contains('/')){
   $parent=$parent.Substring(0,$parent.LastIndexOf('/'))
   if($all.ContainsKey($parent.ToLowerInvariant()) -and (-not $all[$parent.ToLowerInvariant()].directory -or $all[$parent.ToLowerInvariant()].path -cne $parent)){throw 'PG_ARCHIVE_ALIAS_REJECTED'}
   if($spellings.ContainsKey($parent.ToLowerInvariant()) -and $spellings[$parent.ToLowerInvariant()] -cne $parent){throw 'PG_ARCHIVE_ALIAS_REJECTED'}
   $spellings[$parent.ToLowerInvariant()]=$parent;$dirs[$parent]=$true
  }
 }
 foreach($d in @('bin','lib','share')){if(-not $dirs.ContainsKey($d)){throw 'PG_LAYOUT_REJECTED'}}
 foreach($f in @('server_license.txt','commandlinetools_3rd_party_licenses.txt')){if(-not $files.ContainsKey($f)){throw 'PG_LAYOUT_REJECTED'}}
 if($dirs.Count -gt 512){throw 'PG_SIZE_REJECTED'}
 return New-PgManifest $files $dirs
}
function Assert-PgContext($Context){
 if($Context.kind -ceq 'PRODUCTION'){
  $p=Get-PgStageProfile
  $expected=Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path $p.archive_relative
  if($Context.destination -cne $p.destination -or $Context.source -cne $expected -or $Context.inventory_sha256 -cne $p.inventory_sha256 -or $Context.archive_sha256 -cne $p.archive_sha256 -or $Context.scope -cne 'STAGED_BINARIES_ONLY'){throw 'PG_CONTEXT_REJECTED'}
 }elseif($Context.kind -ceq 'SYNTHETIC'){
  if($env:DARKPOOL_PG_STAGE_TEST_ONLY -cne '1' -or $Context.scope -cne 'DISPOSABLE_SYNTHETIC_STAGE_ONLY'){throw 'PG_CONTEXT_REJECTED'}
  $root=[IO.Path]::GetFullPath($Context.root)
  if((Split-Path -Parent $root).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $root) -cnotmatch '^darkpool-pg-stage-[a-f0-9]{32}$' -or
     $Context.destination -cne (Join-Path $root 'installation') -or $Context.source -cne (Join-Path $root 'source.zip')){throw 'PG_CONTEXT_REJECTED'}
  Assert-V2LocalPath $root
  $marker=Get-Content -LiteralPath (Join-Path $root 'fixture-scope.json') -Raw|ConvertFrom-Json
  if($marker.nonce -cne $Context.nonce -or $marker.root -cne $root -or $marker.scope -cne $Context.scope){throw 'PG_CONTEXT_REJECTED'}
 }else{throw 'PG_CONTEXT_REJECTED'}
 Assert-V2LocalPath $Context.destination
}
function New-PgAclDefinition($Context,[bool]$Directory){
 if($Directory){$acl=New-Object Security.AccessControl.DirectorySecurity}else{$acl=New-Object Security.AccessControl.FileSecurity}
 $acl.SetAccessRuleProtection($true,$false)
 $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $owner=if($Context.kind -ceq 'PRODUCTION'){New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')}else{$current}
 $acl.SetOwner($owner)
 $grants=@(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($current.Value,$(if($Context.kind -ceq 'PRODUCTION'){'ReadAndExecute'}else{'FullControl'})))
 foreach($grant in $grants){
  $id=New-Object Security.Principal.SecurityIdentifier($grant[0])
  $rule=if($Directory){New-Object Security.AccessControl.FileSystemAccessRule($id,$grant[1],'ContainerInherit,ObjectInherit','None','Allow')}else{New-Object Security.AccessControl.FileSystemAccessRule($id,$grant[1],'Allow')}
  $acl.AddAccessRule($rule)
 }
 return $acl
}
function Set-PgNewAcl([string]$Path,$Context){
 Assert-PgContext $Context;Assert-PgWritablePath $Path $Context
 $item=Get-Item -Force -LiteralPath $Path
 Set-Acl -LiteralPath $Path -AclObject (New-PgAclDefinition $Context $item.PSIsContainer)
}
function New-PgProtectedDirectory([string]$Path,$Context){
 Assert-PgContext $Context;Assert-PgWritablePath $Path $Context
 # Lazy compilation only on synthetic or separately approved real creation.
 # Read-only installation verification/preflight never compiles or invokes this.
 if(-not ('DarkpoolPgCreateDirectoryV1' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DarkpoolPgCreateDirectoryV1 {
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public int length; public IntPtr descriptor; public int inherit; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CreateDirectoryW(string name, ref Attributes attributes);
 public static void Create(string path, byte[] descriptor) {
  var pointer=Marshal.AllocHGlobal(descriptor.Length);
  try {
   Marshal.Copy(descriptor,0,pointer,descriptor.Length);
   var attributes=new Attributes {length=Marshal.SizeOf(typeof(Attributes)),descriptor=pointer,inherit=0};
   if(!CreateDirectoryW(path,ref attributes)) throw new InvalidOperationException("PG_CREATE_ONLY_DIRECTORY_REJECTED");
  } finally {Marshal.FreeHGlobal(pointer);}
 }
}
'@
 }
 $acl=New-PgAclDefinition $Context $true
 [DarkpoolPgCreateDirectoryV1]::Create($Path,$acl.GetSecurityDescriptorBinaryForm())
 Assert-PgAcl $Path $Context -Root
}
function Assert-PgAcl([string]$Path,$Context,[switch]$Root){
 Assert-V2LocalPath $Path
 $item=Get-Item -Force -LiteralPath $Path;$acl=Get-Acl -LiteralPath $Path
 $operator=if($Context.kind -ceq 'PRODUCTION'){(New-Object Security.Principal.NTAccount('ABDULSAMAD\Admin')).Translate([Security.Principal.SecurityIdentifier]).Value}else{[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
 $owner=if($Context.kind -ceq 'PRODUCTION'){'S-1-5-32-544'}else{$operator}
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner -or ($Root -and (-not $item.PSIsContainer -or -not $acl.AreAccessRulesProtected))){throw 'PG_ACL_REJECTED'}
 $seen=@{}
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  $sid=$rule.IdentityReference.Value
  if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $sid -notin @('S-1-5-18','S-1-5-32-544',$operator)){throw 'PG_ACL_REJECTED'}
  $expected=if($Context.kind -ceq 'PRODUCTION' -and $sid -ceq $operator){[Security.AccessControl.FileSystemRights]::ReadAndExecute}else{[Security.AccessControl.FileSystemRights]::FullControl}
  # Synchronize may be added by Windows to allow ACEs; no other excess permission.
  if(($rule.FileSystemRights -band (-bnot ($expected -bor [Security.AccessControl.FileSystemRights]::Synchronize))) -ne 0 -or ($rule.FileSystemRights -band $expected) -ne $expected){throw 'PG_ACL_REJECTED'}
  $seen[$sid]=$true
 }
 foreach($sid in @('S-1-5-18','S-1-5-32-544',$operator)){if(-not $seen.ContainsKey($sid)){throw 'PG_ACL_REJECTED'}}
}
function Write-PgNewFile([string]$Path,[byte[]]$Bytes,$Context){
 Assert-PgContext $Context;Assert-PgWritablePath $Path $Context;Assert-V2LocalPath $Path
 $f=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$f.Write($Bytes,0,$Bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
 Set-PgNewAcl $Path $Context
}
function Get-PgInstalledManifest($Context){
 Assert-PgContext $Context;Assert-PgAcl $Context.destination $Context -Root
 $files=@{};$dirs=@{}
 function Visit-PgStage([string]$At,[string]$Relative){
  Assert-PgAcl $At $Context
  foreach($item in Get-ChildItem -Force -LiteralPath $At){
   $r=if($Relative){$Relative+'/'+$item.Name}else{$item.Name};Assert-PgRelative $r
   Assert-PgAcl $item.FullName $Context
   if($r -in @('staging-attempt.json','inventory.json','installation.json')){if($item.PSIsContainer -or $item.Length -gt $(if($r -ceq 'inventory.json'){1048576}else{16384})){throw 'PG_METADATA_REJECTED'};continue}
   if($r -cnotmatch '^(bin|lib|share)(/|$)|^(server_license\.txt|commandlinetools_3rd_party_licenses\.txt)$'){throw 'PG_EXTRA_FILE_REJECTED'}
   if($item.PSIsContainer){$dirs[$r]=$true;Visit-PgStage $item.FullName $r}else{
    if($item.Length -gt 33554432 -or $files.Count -ge 4096){throw 'PG_SIZE_REJECTED'}
    $files[$r]=[ordered]@{path=$r;size=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
   }
  }
 }
 Visit-PgStage $Context.destination ''
 return New-PgManifest $files $dirs
}
function Confirm-PgInstallation($Context){
 Assert-PgContext $Context
 if($Context.kind -ceq 'SYNTHETIC'){Assert-PgAcl $Context.root $Context -Root}
 if($Context.kind -ceq 'PRODUCTION'){foreach($parent in @('C:\ZcashTools','C:\ZcashTools\PostgreSQL')){Assert-PgAcl $parent $Context -Root}}
 $manifest=Get-PgInstalledManifest $Context
 if((Get-PgManifestHash $manifest) -cne $Context.inventory_sha256){throw 'PG_INVENTORY_REJECTED'}
 $attempt=Get-Content -LiteralPath (Join-Path $Context.destination 'staging-attempt.json') -Raw|ConvertFrom-Json
 $receipt=Get-Content -LiteralPath (Join-Path $Context.destination 'installation.json') -Raw|ConvertFrom-Json
 $retained=[IO.File]::ReadAllBytes((Join-Path $Context.destination 'inventory.json'))
 if((Get-PgBytesHash $retained) -cne $Context.inventory_sha256 -or $receipt.scope -cne $Context.scope -or
    $attempt.scope -cne $Context.scope -or $attempt.destination -cne $Context.destination -or
    $receipt.stage_id -cne $attempt.stage_id -or $receipt.stage_id -cnotmatch '^[a-f0-9]{32}$' -or
    $receipt.archive_sha256 -cne $Context.archive_sha256 -or $attempt.archive_sha256 -cne $Context.archive_sha256 -or
    $receipt.inventory_sha256 -cne $Context.inventory_sha256 -or $receipt.destination -cne $Context.destination -or
    $receipt.financial_authorization -cne 'NOT_GRANTED' -or $receipt.binary_execution -cne 'NOT_AUTHORIZED' -or
    ($Context.kind -ceq 'PRODUCTION' -and ($receipt.provenance.status -cne 'VENDOR_HTTPS_CHECKSUM_VERIFIED' -or
      $receipt.provenance.url -cne (Get-PgStageProfile).checksum_url -or $receipt.provenance.archive_sha256 -cne $Context.archive_sha256))){throw 'PG_RECEIPT_REJECTED'}
 return [ordered]@{status='PINNED_BINARIES_STAGED_ONLY';scope=$Context.scope;destination=$Context.destination;archive_sha256=$Context.archive_sha256;
 inventory_sha256=$Context.inventory_sha256;binary_execution='NOT_AUTHORIZED';financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}
}
function Invoke-PgCreateOnlyStage($Context,$VendorEvidence,[string]$Fault=''){
 Assert-PgContext $Context
 if($Context.kind -ceq 'SYNTHETIC'){Assert-PgAcl $Context.root $Context -Root}
 if($Context.kind -ceq 'PRODUCTION'){
  $who=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($who)
  if($who.Name -cne 'ABDULSAMAD\Admin' -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $Fault){throw 'PG_ADMIN_REQUIRED'}
  if($VendorEvidence.status -cne 'VENDOR_HTTPS_CHECKSUM_VERIFIED' -or $VendorEvidence.archive_sha256 -cne $Context.archive_sha256 -or $VendorEvidence.url -cne (Get-PgStageProfile).checksum_url){throw 'PG_PROVENANCE_REQUIRED'}
 }elseif($Fault -notin @('','after_attempt','after_file','before_receipt')){throw 'PG_FIXTURE_REJECTED'}
 if(Test-Path -LiteralPath $Context.destination){throw 'PG_DESTINATION_OCCUPIED'}
 # Hold this exact source handle through hash validation and extraction. The
 # approved OneDrive source is read as bytes only; no source ACL/reparse metadata
 # is copied into the new local installation, and no source binary is executed.
 $source=[IO.File]::Open($Context.source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $archive=$null
 try{
  if($source.Length -gt 419430400){throw 'PG_SIZE_REJECTED'}
  $hash=Get-PgStreamHash $source 419430400
  if($hash.sha256 -cne $Context.archive_sha256){throw 'PG_ARCHIVE_HASH_REJECTED'}
  $source.Position=0;$archive=New-Object IO.Compression.ZipArchive($source,[IO.Compression.ZipArchiveMode]::Read,$true)
  $manifest=Get-PgArchiveManifest $archive
  if((Get-PgManifestHash $manifest) -cne $Context.inventory_sha256){throw 'PG_INVENTORY_REJECTED'}
  if($Context.kind -ceq 'PRODUCTION'){
   Assert-PgProductionInventory $manifest $hash.size
   foreach($parent in @('C:\ZcashTools','C:\ZcashTools\PostgreSQL')){
    Assert-V2LocalPath $parent
    if(Test-Path -LiteralPath $parent){Assert-PgAcl $parent $Context -Root}else{New-PgProtectedDirectory $parent $Context}
   }
  }
  New-PgProtectedDirectory $Context.destination $Context
  $stageId=[Guid]::NewGuid().ToString('N')
  $attempt=[ordered]@{scope=$Context.scope;stage_id=$stageId;archive_sha256=$Context.archive_sha256;destination=$Context.destination;started_utc=[DateTime]::UtcNow.ToString('o')}
  Write-PgNewFile (Join-Path $Context.destination 'staging-attempt.json') ([Text.Encoding]::UTF8.GetBytes(($attempt|ConvertTo-Json -Compress))) $Context
  if($Fault -ceq 'after_attempt'){throw 'PG_SYNTHETIC_INTERRUPTION'}
  foreach($d in $manifest.directories){$path=Join-Path $Context.destination $d;New-PgProtectedDirectory $path $Context}
  foreach($f in $manifest.files){
   $path=Join-Path $Context.destination $f.path;Assert-V2LocalPath $path
   $entry=$archive.GetEntry('pgsql/'+$f.path);$input=$entry.Open()
   $output=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose();$input.Dispose()}
   Set-PgNewAcl $path $Context
   if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'PG_FILE_HASH_REJECTED'}
   if($Fault -ceq 'after_file'){throw 'PG_SYNTHETIC_INTERRUPTION'}
  }
  $encoded=[Text.Encoding]::UTF8.GetBytes(($manifest|ConvertTo-Json -Depth 6 -Compress))
  Write-PgNewFile (Join-Path $Context.destination 'inventory.json') $encoded $Context
  if((Get-PgManifestHash (Get-PgInstalledManifest $Context)) -cne $Context.inventory_sha256){throw 'PG_INVENTORY_REJECTED'}
  if($Fault -ceq 'before_receipt'){throw 'PG_SYNTHETIC_INTERRUPTION'}
  $receipt=[ordered]@{scope=$Context.scope;stage_id=$stageId;destination=$Context.destination;archive_sha256=$Context.archive_sha256;
    inventory_sha256=$Context.inventory_sha256;provenance=$VendorEvidence;completed_utc=[DateTime]::UtcNow.ToString('o');binary_execution='NOT_AUTHORIZED';financial_authorization='NOT_GRANTED'}
  Write-PgNewFile (Join-Path $Context.destination 'installation.json') ([Text.Encoding]::UTF8.GetBytes(($receipt|ConvertTo-Json -Depth 5 -Compress))) $Context
  return Confirm-PgInstallation $Context
 }finally{if($archive){$archive.Dispose()};$source.Dispose()}
 # On failure: preserve partial directories/attempts. No reset, rollback deletion
 # or resume for the real destination; only disposable test owners may clean up.
}
function New-PgProductionContext {
 $p=Get-PgStageProfile
 return @{kind='PRODUCTION';scope='STAGED_BINARIES_ONLY';destination=$p.destination;
  source=(Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path $p.archive_relative);
  archive_sha256=$p.archive_sha256;inventory_sha256=$p.inventory_sha256}
}
function Assert-PgWritablePath([string]$Path,$Context){
 $full=[IO.Path]::GetFullPath($Path)
 $base=if($Context.kind -ceq 'SYNTHETIC'){$Context.root}else{$Context.destination}
 $base=[IO.Path]::GetFullPath($base).TrimEnd('\')
 $parents=if($Context.kind -ceq 'PRODUCTION'){@('C:\ZcashTools','C:\ZcashTools\PostgreSQL')}else{@()}
 if($full -ine $base -and -not $full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -and $full -notin $parents){throw 'PG_WRITE_PATH_REJECTED'}
 Assert-V2LocalPath $full
}

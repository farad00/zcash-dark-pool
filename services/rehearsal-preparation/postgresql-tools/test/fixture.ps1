[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Scenario,[Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/../../../../scripts/dev/postgresql-staging-core.ps1"
$phase='SCOPE'
try{
 $allowed=@('success','retry','archive-hash','inventory-hash','traversal','duplicate','case-alias','parent-alias','reserved-name','ads','symlink-entry','unsafe-acl','unsafe-parent','after_attempt','after_file','before_receipt','tampering','extra-file','missing-file','missing-receipt','receipt-scope','manifest-tampering','wrong-target','vendor-parser','production-guards','retained-archive-inventory','production-acl-policy','reparse-target','directory-collision','vendor-unavailable','attempt-binding','production-manifest-byte-count','production-inventory-rejection','failure-reason-redaction','cli-failure-reason')
 if($Scenario -notin $allowed -or $env:DARKPOOL_PG_STAGE_TEST_ONLY -cne '1'){throw 'fixture only'}
 $root=[IO.Path]::GetFullPath($FixtureRoot)
 if((Split-Path -Parent $root).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $root) -cnotmatch '^darkpool-pg-stage-[a-f0-9]{32}$'){throw 'fixture only'}
 Assert-V2LocalPath $root
 $scope=Get-Content -LiteralPath (Join-Path $root 'fixture-scope.json') -Raw|ConvertFrom-Json
 if($scope.root -cne $root -or $scope.nonce -cnotmatch '^[a-f0-9]{32}$' -or $scope.scope -cne 'DISPOSABLE_SYNTHETIC_STAGE_ONLY'){throw 'fixture only'}
 if(@(Get-ChildItem -LiteralPath $root -Force).Count -ne 1){throw 'fresh fixture required'}
 $ctx=@{kind='SYNTHETIC';scope=$scope.scope;root=$root;nonce=$scope.nonce;source=(Join-Path $root 'source.zip');destination=(Join-Path $root 'installation');archive_sha256='';inventory_sha256=''}
 Set-PgNewAcl $root $ctx;Set-PgNewAcl (Join-Path $root 'fixture-scope.json') $ctx
 function Expect-Rejection($Work){$rejected=$false;try{&$Work|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'expected rejection'}}
 function Check($Condition){if(-not $Condition){throw 'fixture assertion failed'}}
 function Unsafe-Acl([string]$Path){
  # Request/write DACL only, never SACL or owner privileges in a normal-user test.
  $directory=Test-Path -LiteralPath $Path -PathType Container
  $acl=if($directory){[IO.Directory]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Access)}else{[IO.File]::GetAccessControl($Path,[Security.AccessControl.AccessControlSections]::Access)}
  $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'ReadAndExecute','Allow');$acl.AddAccessRule($rule)
  if($directory){[IO.Directory]::SetAccessControl($Path,$acl)}else{[IO.File]::SetAccessControl($Path,$acl)}
 }
 $phase='ZIP_SETUP'
 $file=[IO.File]::Open($ctx.source,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  $zip=New-Object IO.Compression.ZipArchive($file,[IO.Compression.ZipArchiveMode]::Create,$true)
  try{
   $names=@('pgsql/bin/synthetic.exe','pgsql/lib/synthetic.dll','pgsql/share/subdir/catalog.txt','pgsql/server_license.txt','pgsql/commandlinetools_3rd_party_licenses.txt')
   switch($Scenario){
    'traversal' {$names+=@('pgsql/bin/../escape.dll')}
    'duplicate' {$names+=@('pgsql/bin/synthetic.exe')}
    'case-alias' {$names+=@('pgsql/bin/SYNTHETIC.exe')}
    'parent-alias' {$names+=@('pgsql/bin/Child/a.dll','pgsql/bin/child/b.dll')}
    'reserved-name' {$names+=@('pgsql/bin/CON.dll')}
    'ads' {$names+=@('pgsql/bin/data:stream')}
   }
   foreach($name in $names){$e=$zip.CreateEntry($name);if($Scenario -ceq 'symlink-entry' -and $name.EndsWith('synthetic.exe')){$e.ExternalAttributes=-1610612736};$output=$e.Open();try{$data=[Text.Encoding]::UTF8.GetBytes('SYNTHETIC_NOT_EXECUTABLE '+$name);$output.Write($data,0,$data.Length)}finally{$output.Dispose()}}
  }finally{$zip.Dispose()}
 }finally{$file.Dispose()}
 Set-PgNewAcl $ctx.source $ctx
 $ctx.archive_sha256=(Get-FileHash -LiteralPath $ctx.source -Algorithm SHA256).Hash.ToLowerInvariant()
 $unsafe=$Scenario -in @('traversal','duplicate','case-alias','parent-alias','reserved-name','ads','symlink-entry')
 if(-not $unsafe){$zip=[IO.Compression.ZipFile]::OpenRead($ctx.source);try{$ctx.inventory_sha256=Get-PgManifestHash (Get-PgArchiveManifest $zip)}finally{$zip.Dispose()}}else{$ctx.inventory_sha256='0'*64}
 $vendor=@{status='SYNTHETIC_VENDOR_ONLY';archive_sha256=$ctx.archive_sha256}
 $phase='SCENARIO'
 switch($Scenario){
  'success' {
   $r=Invoke-PgCreateOnlyStage $ctx $vendor;Check ($r.status -ceq 'PINNED_BINARIES_STAGED_ONLY');Check ($r.scope -ceq 'DISPOSABLE_SYNTHETIC_STAGE_ONLY')
   Check ([IO.File]::ReadAllText((Join-Path $ctx.destination 'bin/synthetic.exe')).StartsWith('SYNTHETIC_NOT_EXECUTABLE'))
   Check (Test-Path -LiteralPath (Join-Path $ctx.destination 'share/subdir/catalog.txt'))
  }
  'retry' {
   Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null
   $before=(Get-FileHash -LiteralPath (Join-Path $ctx.destination 'staging-attempt.json')).Hash
   Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor}
   Check ((Get-FileHash -LiteralPath (Join-Path $ctx.destination 'staging-attempt.json')).Hash -ceq $before)
   Confirm-PgInstallation $ctx|Out-Null
  }
  'archive-hash' {$ctx.archive_sha256='0'*64;Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor};Check (-not (Test-Path -LiteralPath $ctx.destination))}
  'inventory-hash' {$ctx.inventory_sha256='0'*64;Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor};Check (-not (Test-Path -LiteralPath $ctx.destination))}
  {$_ -in @('traversal','duplicate','case-alias','parent-alias','reserved-name','ads','symlink-entry')} {Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor};Check (-not (Test-Path -LiteralPath $ctx.destination))}
  'unsafe-acl' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;Unsafe-Acl (Join-Path $ctx.destination 'bin/synthetic.exe');Expect-Rejection {Confirm-PgInstallation $ctx}}
  'unsafe-parent' {Unsafe-Acl $root;Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor};Check (-not (Test-Path -LiteralPath $ctx.destination))}
  {$_ -in @('after_attempt','after_file','before_receipt')} {
   Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor $Scenario}
   Check (Test-Path -LiteralPath (Join-Path $ctx.destination 'staging-attempt.json'))
   Check (-not (Test-Path -LiteralPath (Join-Path $ctx.destination 'installation.json')))
   $before=(Get-FileHash -LiteralPath (Join-Path $ctx.destination 'staging-attempt.json')).Hash
   Expect-Rejection {Confirm-PgInstallation $ctx};Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor}
   Check ((Get-FileHash -LiteralPath (Join-Path $ctx.destination 'staging-attempt.json')).Hash -ceq $before)
  }
  'tampering' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;[IO.File]::WriteAllText((Join-Path $ctx.destination 'bin/synthetic.exe'),'SYNTHETIC_TAMPERING');Expect-Rejection {Confirm-PgInstallation $ctx}}
  'extra-file' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;Write-PgNewFile (Join-Path $ctx.destination 'bin/extra.dll') ([byte[]]@(1,2,3)) $ctx;Expect-Rejection {Confirm-PgInstallation $ctx}}
  'missing-file' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;Assert-PgWritablePath (Join-Path $ctx.destination 'bin/synthetic.exe') $ctx;[IO.File]::Delete((Join-Path $ctx.destination 'bin/synthetic.exe'));Expect-Rejection {Confirm-PgInstallation $ctx}}
  'missing-receipt' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;Assert-PgWritablePath (Join-Path $ctx.destination 'installation.json') $ctx;[IO.File]::Delete((Join-Path $ctx.destination 'installation.json'));Expect-Rejection {Confirm-PgInstallation $ctx}}
  'receipt-scope' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;$p=Join-Path $ctx.destination 'installation.json';$r=Get-Content -LiteralPath $p -Raw|ConvertFrom-Json;$r.scope='STAGED_BINARIES_ONLY';[IO.File]::WriteAllText($p,($r|ConvertTo-Json -Depth 5 -Compress));Expect-Rejection {Confirm-PgInstallation $ctx}}
  'manifest-tampering' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;[IO.File]::WriteAllText((Join-Path $ctx.destination 'inventory.json'),'{}');Expect-Rejection {Confirm-PgInstallation $ctx}}
  'attempt-binding' {Invoke-PgCreateOnlyStage $ctx $vendor|Out-Null;$p=Join-Path $ctx.destination 'staging-attempt.json';$r=Get-Content -LiteralPath $p -Raw|ConvertFrom-Json;$r.destination='C:\wrong';[IO.File]::WriteAllText($p,($r|ConvertTo-Json -Depth 5 -Compress));Expect-Rejection {Confirm-PgInstallation $ctx}}
  'wrong-target' {$ctx.destination='C:\ZcashTools\PostgreSQL\18.6-5';Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor};Expect-Rejection {Set-PgNewAcl $root $ctx}}
  'vendor-parser' {
   $p=Get-PgStageProfile
   foreach($s in @($p.archive_sha256,($p.archive_sha256+'  '+$p.checksum_filename+"`r`n"))){$v=Convert-PgVendorChecksum ([Text.Encoding]::UTF8.GetBytes($s)) $p;Check ($v.archive_sha256 -ceq $p.archive_sha256)}
   foreach($s in @(('0'*64),($p.archive_sha256+'  wrong.zip'),($p.archive_sha256+"`nextra"),('x'*513))){Expect-Rejection {Convert-PgVendorChecksum ([Text.Encoding]::UTF8.GetBytes($s)) $p}}
   Expect-Rejection {Convert-PgVendorChecksum ([byte[]]@(255)) $p}
  }
  'production-guards' {
   $p=New-PgProductionContext;$p.destination=$ctx.destination;Expect-Rejection {Assert-PgContext $p}
   $p=New-PgProductionContext;$p.source=$ctx.source;Expect-Rejection {Assert-PgContext $p}
   Expect-Rejection {Set-PgNewAcl 'C:\ProgramData' $ctx}
   Check (-not (Test-Path -LiteralPath $ctx.destination))
  }
  'retained-archive-inventory' {
   # Public software archive inspection ONLY. No real payload extraction or execution.
   $p=Get-PgStageProfile;$real=New-PgProductionContext
   Check ((Get-FileHash -LiteralPath $real.source -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $p.archive_sha256)
   $zip=[IO.Compression.ZipFile]::OpenRead($real.source)
   try{$manifest=Get-PgArchiveManifest $zip;Check ((Get-PgManifestHash $manifest) -ceq $p.inventory_sha256);Check (@($manifest.files).Count -eq $p.inventory_files);Check (@($manifest.directories).Count -eq $p.inventory_directories)}finally{$zip.Dispose()}
   Check (-not (Test-Path -LiteralPath $ctx.destination))
  }
  {$_ -in @('production-manifest-byte-count','production-inventory-rejection')} {
   # Invoke the SAME read-only gate used by production; never invoke real Stage/Verify.
   Check ($PSVersionTable.PSEdition -ceq 'Desktop')
   Check ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1)
   $p=Get-PgStageProfile;$real=New-PgProductionContext
   $length=(Get-Item -LiteralPath $real.source).Length
   $zip=[IO.Compression.ZipFile]::OpenRead($real.source)
   try{$manifest=Get-PgArchiveManifest $zip}finally{$zip.Dispose()}
   Check ((Get-PgManifestHash $manifest) -ceq $p.inventory_sha256)
   Check ($manifest.files[0] -is [Collections.Specialized.OrderedDictionary])
   Assert-PgProductionInventory $manifest $length
   if($Scenario -ceq 'production-manifest-byte-count'){
    [long]$sum=0;foreach($record in $manifest.files){$sum += [long]$record['size']}
    Check ($sum -eq 147931704)
   }else{
    function Reject-Inventory($Work,[string]$Expected){
     $reason='NO_REJECTION';try{&$Work}catch{$reason=Get-PgFailureReason $_}
     Check ($reason -ceq $Expected)
    }
    Reject-Inventory {Assert-PgProductionInventory $manifest ($length-1)} 'PG_ARCHIVE_SIZE_REJECTED'
    $manifest.files[0]['size']++
    Reject-Inventory {Assert-PgProductionInventory $manifest $length} 'PG_INVENTORY_BYTES_REJECTED'
    $manifest.files[0]['size']--
    $original=$manifest.files;$manifest.files=@($original|Select-Object -Skip 1)
    Reject-Inventory {Assert-PgProductionInventory $manifest $length} 'PG_INVENTORY_COUNT_REJECTED'
    $manifest.files=$original
    $originalDirs=$manifest.directories;$manifest.directories=@($originalDirs|Select-Object -Skip 1)
    Reject-Inventory {Assert-PgProductionInventory $manifest $length} 'PG_INVENTORY_COUNT_REJECTED'
    $manifest.directories=$originalDirs
    Assert-PgProductionInventory $manifest $length
    Check ((Get-PgManifestHash $manifest) -ceq $p.inventory_sha256)
   }
   Check (-not (Test-Path -LiteralPath $ctx.destination))
  }
  'failure-reason-redaction' {
   foreach($code in @('PG_INVENTORY_BYTES_REJECTED','PG_INVENTORY_COUNT_REJECTED','PG_ARCHIVE_SIZE_REJECTED','PG_ACL_REJECTED','PG_ARCHIVE_HASH_REJECTED','PG_DESTINATION_OCCUPIED')){
    try{throw $code}catch{Check ((Get-PgFailureReason $_) -ceq $code)}
   }
   foreach($message in @('SYNTHETIC_PRIVATE_SENTINEL C:\private\credential.xml','PG_ACL_REJECTED secret','pg_acl_rejected')){
    try{throw $message}catch{Check ((Get-PgFailureReason $_) -ceq 'PG_UNEXPECTED_FAILURE')}
   }
   try{throw 'V2 storage rejected'}catch{Check ((Get-PgFailureReason $_) -ceq 'PG_LOCAL_PATH_REJECTED')}
   try{throw [UnauthorizedAccessException]::new('SYNTHETIC_PRIVATE_SENTINEL')}catch{Check ((Get-PgFailureReason $_) -ceq 'PG_ACCESS_DENIED')}
   try{throw [IO.IOException]::new('SYNTHETIC_PRIVATE_SENTINEL')}catch{Check ((Get-PgFailureReason $_) -ceq 'PG_IO_FAILURE')}
   try{throw [Net.WebException]::new('SYNTHETIC_PRIVATE_SENTINEL')}catch{Check ((Get-PgFailureReason $_) -ceq 'PG_VENDOR_UNAVAILABLE')}
  }
  'cli-failure-reason' {
   # Plan with an invalid approval combination rejects before any network/creation.
   $cli=Join-Path $PSScriptRoot '../../../../scripts/dev/postgresql-staging.ps1'
   $start=New-Object Diagnostics.ProcessStartInfo
   $start.FileName=Join-Path $PSHOME 'powershell.exe'
   $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$cli+'" -Action Plan -ExtractionApproved'
   $start.UseShellExecute=$false;$start.CreateNoWindow=$true
   $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.RedirectStandardInput=$true
   $child=New-Object Diagnostics.Process;$child.StartInfo=$start
   try{
    Check ($child.Start());$child.StandardInput.Close()
    if(-not $child.WaitForExit(10000)){$child.Kill();throw 'fixture CLI timeout'}
    $output=$child.StandardOutput.ReadToEnd();$errors=$child.StandardError.ReadToEnd()
    $phase='CLI_EXIT';Check ($child.ExitCode -eq 1)
    Check ($output.Length -lt 4096 -and $errors.Length -eq 0)
   }finally{$child.Dispose()}
   $result=$output|ConvertFrom-Json
   $phase='CLI_STATUS'
   Check ($result.status -ceq 'POSTGRESQL_STAGING_NOT_CONFIRMED')
   $phase='CLI_REASON'
   Check ($result.reason -ceq 'PG_ARGUMENTS_REJECTED')
   $phase='CLI_STAGE'
   Check ($result.stage -ceq 'PROFILE')
   $phase='CLI_FIELDS'
   Check (((@($result.PSObject.Properties.Name)|Sort-Object) -join ',') -ceq 'financial_authorization,partial_state,production_trust,reason,stage,status')
   $phase='CLI_AUTHORIZATION'
   Check ($result.financial_authorization -ceq 'NOT_GRANTED' -and $result.production_trust -ceq 'UNAVAILABLE')
   $phase='CLI_REDACTION'
   Check (($output -join '') -notmatch 'C:\\|Exception|StackTrace|SYNTHETIC_PRIVATE_SENTINEL')
  }
  'production-acl-policy' {
   $acl=New-PgAclDefinition (New-PgProductionContext) $true
   Check $acl.AreAccessRulesProtected
   Check ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544')
   $operator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
   $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
   Check ($rules.Count -eq 3)
   foreach($r in $rules){
    Check ($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow)
    if($r.IdentityReference.Value -ceq $operator){Check (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::WriteData) -eq 0);Check (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute)}else{Check ($r.IdentityReference.Value -in @('S-1-5-18','S-1-5-32-544'));Check ($r.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl)}
   }
  }
  'reparse-target' {
   $alias=Join-Path $root 'alias-target';New-PgProtectedDirectory $alias $ctx
   # Only a new junction between two exact paths in this disposable scope.
   Check ([IO.Path]::GetFullPath($alias).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase))
   Check ([IO.Path]::GetFullPath($ctx.destination).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase))
   New-Item -ItemType Junction -Path $ctx.destination -Target $alias -ErrorAction Stop|Out-Null
   try{Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor}}finally{
    $link=Get-Item -Force -LiteralPath $ctx.destination
    Check (($link.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    Check (@($link.Target)[0] -ieq $alias)
    [IO.Directory]::Delete($ctx.destination) # Nonrecursive removal of this junction only.
   }
   Check (@(Get-ChildItem -LiteralPath $alias -Force).Count -eq 0)
  }
  'directory-collision' {
   New-PgProtectedDirectory $ctx.destination $ctx
   $before=Get-PgBytesHash ((Get-Acl -LiteralPath $ctx.destination).GetSecurityDescriptorBinaryForm())
   Expect-Rejection {New-PgProtectedDirectory $ctx.destination $ctx}
   Expect-Rejection {Invoke-PgCreateOnlyStage $ctx $vendor}
   Check ((Get-PgBytesHash ((Get-Acl -LiteralPath $ctx.destination).GetSecurityDescriptorBinaryForm())) -ceq $before)
   Check (@(Get-ChildItem -LiteralPath $ctx.destination -Force).Count -eq 0)
  }
  'vendor-unavailable' {
   $p=Get-PgStageProfile;$data=[Text.Encoding]::UTF8.GetBytes($p.archive_sha256)
   foreach($status in @(0,301,302,404,503)){Expect-Rejection {Convert-PgVendorResponse $status $p.checksum_url $data $p}}
   Expect-Rejection {Convert-PgVendorResponse 200 'https://example.invalid/checksum' $data $p}
   Expect-Rejection {Convert-PgVendorResponse 200 $p.checksum_url ([byte[]]@()) $p}
   Check (-not (Test-Path -LiteralPath $ctx.destination))
  }
 }
 [ordered]@{stage='DISPOSABLE_PG_STAGING';scenario=$Scenario;status='PASS';sql=$false;binary_execution=$false;financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
}catch{[ordered]@{stage=$phase;scenario=$Scenario;status='FAIL';reason=$_.Exception.Message}|ConvertTo-Json -Compress}

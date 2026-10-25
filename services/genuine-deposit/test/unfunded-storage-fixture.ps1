$ErrorActionPreference='Stop'
if($env:DARKPOOL_UNFUNDED_STORAGE_TEST_ONLY -cne '1'){throw 'disposable storage fixture only'}
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $repo 'scripts/dev/v2-security.ps1')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/dev/genuine-receiver.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PowerShell parsing failed'}
# Load only filesystem functions, never launcher/top-level statements.
foreach($name in @('Assert-ReceiverAcl','Set-ReceiverAcl')){
 $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
 if(-not $f){throw 'storage check missing'}
 . ([scriptblock]::Create($f.Extent.Text))
}
$nonce=[Guid]::NewGuid().ToString('N')
$root=Join-Path ([IO.Path]::GetTempPath()) ('darkpool-unfunded-acl-'+$nonce)
$checks=@()
function New-FixtureAcl {
 $value=New-Object Security.AccessControl.DirectorySecurity;$value.SetAccessRuleProtection($true,$false)
 $current=[Security.Principal.WindowsIdentity]::GetCurrent().User;$value.SetOwner($current)
 $value.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 return $value
}
try{
 New-Item -ItemType Directory -Path $root|Out-Null
 Set-ReceiverAcl $root
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($sid)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 (Get-Item -LiteralPath $root).SetAccessControl($acl)
 Assert-ReceiverAcl $root;$checks+='RESTRICTED_OWNER_PASS'
 $loose=New-FixtureAcl
 $loose.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','Allow')))
 (Get-Item -LiteralPath $root).SetAccessControl($loose)
 $denied=$false;try{Assert-ReceiverAcl $root}catch{$denied=$true}
 if(-not $denied){throw 'broad ACL not rejected'};$checks+='UNLISTED_READER_REJECTED'
 (Get-Item -LiteralPath $root).SetAccessControl($acl)
 $loose=New-FixtureAcl
 $loose.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-11')),'Write','Allow')))
 (Get-Item -LiteralPath $root).SetAccessControl($loose)
 $denied=$false;try{Assert-ReceiverAcl $root @('S-1-5-11')}catch{$denied=$true}
 if(-not $denied){throw 'reader write not rejected'};$checks+='RUNTIME_WRITE_REJECTED'
 (Get-Item -LiteralPath $root).SetAccessControl($acl)
 New-Item -ItemType Directory -Path (Join-Path $root 'owned')|Out-Null
 New-Item -ItemType Junction -Path (Join-Path $root 'link') -Target (Join-Path $root 'owned')|Out-Null
 $denied=$false;try{Assert-V2LocalPath (Join-Path $root 'link\future-child')}catch{$denied=$true}
 if(-not $denied){throw 'reparse ancestor not rejected'};$checks+='REPARSE_ANCESTOR_REJECTED'
 # Remove only our junction, never its target recursively.
 [IO.Directory]::Delete((Join-Path $root 'link'))
 $checks+='POWERSHELL_51_PARSE_PASS'
}finally{
 $resolved=[IO.Path]::GetFullPath($root)
 $expected=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('darkpool-unfunded-acl-'+$nonce)))
 if($resolved -cne $expected -or -not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'cleanup identity rejected'}
 if(Test-Path -LiteralPath (Join-Path $root 'link')){[IO.Directory]::Delete((Join-Path $root 'link'))}
 if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
@{scope='DISPOSABLE_FILESYSTEM_ONLY';status='PASS';checks=$checks;accounts_created=0;wallet_access=$false}|ConvertTo-Json -Compress

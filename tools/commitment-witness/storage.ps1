param([ValidateSet('init','check','protect','unprotect')][string]$Action)
$ErrorActionPreference='Stop'
try {
 $witnessIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $witnessPrincipal=New-Object Security.Principal.WindowsPrincipal($witnessIdentity)
 if($witnessPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Non-elevated user required'}
 $witnessSid=$witnessIdentity.User.Value
 $witnessRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolCommitmentWitness'
 $witnessAbsolute=[IO.Path]::GetFullPath($witnessRoot)
 for($witnessAncestor=$witnessAbsolute;$witnessAncestor;){
  if(Test-Path -LiteralPath $witnessAncestor){if(((Get-Item -Force -LiteralPath $witnessAncestor).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Storage redirect rejected'}}
  $witnessParent=Split-Path -Parent $witnessAncestor
  if($witnessParent -eq $witnessAncestor){break};$witnessAncestor=$witnessParent
 }
 if($Action -eq 'init' -and -not(Test-Path -LiteralPath $witnessRoot)){
  New-Item -ItemType Directory -Path $witnessRoot|Out-Null
  $witnessAcl=New-Object Security.AccessControl.DirectorySecurity
  $witnessAcl.SetOwner($witnessIdentity.User);$witnessAcl.SetAccessRuleProtection($true,$false)
  foreach($witnessAllowed in @($witnessSid,'S-1-5-18','S-1-5-32-544')){
   $witnessRule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($witnessAllowed)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
   $witnessAcl.AddAccessRule($witnessRule)
  }
  Set-Acl -LiteralPath $witnessRoot -AclObject $witnessAcl
  foreach($witnessChild in @('keys','archive','exports')){New-Item -ItemType Directory -Path (Join-Path $witnessRoot $witnessChild)|Out-Null}
 }
 $witnessItems=@(Get-Item -Force -LiteralPath $witnessRoot)
 if(-not $witnessItems[0].PSIsContainer){throw 'Directory required'}
 for($witnessIndex=0;$witnessIndex -lt $witnessItems.Count;$witnessIndex++){
  if($witnessItems.Count -gt 4096){throw 'Storage inventory limit'}
  $witnessItem=$witnessItems[$witnessIndex]
  if(($witnessItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Storage redirect rejected'}
  $witnessAcl=Get-Acl -LiteralPath $witnessItem.FullName
  if($witnessAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $witnessSid){throw 'Owner mismatch'}
  if($witnessItem.FullName -eq $witnessRoot -and -not $witnessAcl.AreAccessRulesProtected){throw 'Protected root required'}
  $witnessFull=$false
  foreach($witnessRule in $witnessAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($witnessRule.AccessControlType -ne 'Allow' -or @($witnessSid,'S-1-5-18','S-1-5-32-544') -notcontains $witnessRule.IdentityReference.Value){throw 'Unexpected permission'}
   if($witnessRule.IdentityReference.Value -eq $witnessSid -and ($witnessRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$witnessFull=$true}
  }
  if(-not $witnessFull){throw 'Restricted user access required'}
  if($witnessItem.PSIsContainer){$witnessItems+=@(Get-ChildItem -Force -LiteralPath $witnessItem.FullName)}
 }
 if($Action -in @('protect','unprotect')){
  Add-Type -AssemblyName System.Security
  $witnessInput=[Console]::In.ReadToEnd()
  if($witnessInput.Length -gt 8192){throw 'Input limit'}
  $witnessBytes=[Convert]::FromBase64String($witnessInput)
  $witnessEntropy=[Text.Encoding]::ASCII.GetBytes('DARKPOOL_WITNESS_KEY_V1')
  try{
   if($Action -eq 'protect'){$witnessOutput=[Security.Cryptography.ProtectedData]::Protect($witnessBytes,$witnessEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
   else{$witnessOutput=[Security.Cryptography.ProtectedData]::Unprotect($witnessBytes,$witnessEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
   [Console]::Out.Write([Convert]::ToBase64String($witnessOutput))
  }finally{[Array]::Clear($witnessBytes,0,$witnessBytes.Length);if($witnessOutput){[Array]::Clear($witnessOutput,0,$witnessOutput.Length)}}
 } else {Write-Output 'WITNESS_STORAGE_OK'}
}catch{[Console]::Error.WriteLine('Witness storage rejected');exit 1}

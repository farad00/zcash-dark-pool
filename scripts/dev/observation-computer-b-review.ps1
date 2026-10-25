[CmdletBinding()]
param(
 [ValidateSet('Check','Verify')][string]$Action='Check',
 [Parameter(Mandatory=$true)][string]$BundleDirectory,
 [Parameter(Mandatory=$true)][string]$NodePath,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$AgeSha256
)
$ErrorActionPreference='Stop';$credential=$null;$pointer=[IntPtr]::Zero;$child=$null
try{
 if($args.Count -ne 0){throw 'fixed inputs'}
 . "$PSScriptRoot/v2-security.ps1"
 $repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
 Assert-V2Acl $repo -ProtectedRoot
 foreach($relative in @('scripts/dev/observation-computer-b-review.ps1','scripts/dev/v2-security.ps1','scripts/dev/run-bounded.mjs','services/backup/physical.mjs','services/backup/crypto.mjs','services/rehearsal-preparation/plan.mjs','services/rehearsal-preparation/target.proposed.json','services/rehearsal-preparation/observation-v1/bootstrap-plan.mjs','services/rehearsal-preparation/observation-v1/bootstrap-recovery.mjs','services/rehearsal-preparation/observation-v1/computer-b-review.mjs','services/rehearsal-preparation/observation-v1/computer-b-review-cli.mjs','.tools/backup-target/debug/darkpool-backup-age.exe')){Assert-V2Acl (Join-Path $repo $relative)}
 $bundle=[IO.Path]::GetFullPath($BundleDirectory);$node=[IO.Path]::GetFullPath($NodePath)
 Assert-V2LocalPath $bundle;Assert-V2Acl $bundle -ProtectedRoot;Assert-V2LocalPath $node
 if(-not $node.StartsWith($repo+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'private pinned runtime copy required'}
 Assert-V2Acl $node
 foreach($name in @('cluster.age','manifest.json')){Assert-V2Acl (Join-Path $bundle $name)}
 $cli=Join-Path $repo 'services/rehearsal-preparation/observation-v1/computer-b-review-cli.mjs'
 function Invoke-ReviewChild([string]$Mode,[Security.SecureString]$Key){
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$node;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear();foreach($k in @('SystemRoot','WINDIR','TEMP','TMP','PATH')){$v=[Environment]::GetEnvironmentVariable($k,'Process');if($v){$info.EnvironmentVariables[$k]=$v}}
  $info.Arguments='"'+$cli+'" '+$Mode+' "'+$bundle+'" '+$ManifestSha256+' '+$AgeSha256
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$started=$false
  try{
   if(-not $process.Start()){throw 'child unavailable'};$started=$true
   $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
   if($Key){$keyPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Key);try{$process.StandardInput.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)}}
   $process.StandardInput.Close()
   if(-not $process.WaitForExit(45000)){throw 'review timeout'}
   $output=$stdout.Result
   if($process.ExitCode -ne 0 -or $output.Length -gt 4096 -or $stderr.Result.Length -ne 0){throw 'review not confirmed'}
   return ($output|ConvertFrom-Json)
  }finally{if($started -and -not $process.HasExited){$process.Kill()};$process.Dispose()}
 }
 $preflight=Invoke-ReviewChild 'check' $null
 if($preflight.status -cne 'TRANSFER_INTEGRITY_ONLY'){throw 'preflight not confirmed'}
 if($Action -ceq 'Check'){$preflight|ConvertTo-Json -Compress}
 else{
  $credential=Read-Host 'SYNTHETIC offline recovery key (local input only)' -AsSecureString
  $result=Invoke-ReviewChild 'verify' $credential
  if($result.status -cne 'SYNTHETIC_BACKUP_DECRYPTION_AND_BINDINGS_VERIFIED'){throw 'decryption not confirmed'}
  $result|ConvertTo-Json -Compress
 }
}catch{[ordered]@{status='RECOVERY_REVIEW_NOT_CONFIRMED';financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Compress;exit 1}
finally{if($credential){$credential.Dispose()}}

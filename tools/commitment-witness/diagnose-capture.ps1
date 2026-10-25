param([string]$Config='-', [string]$Request='-', [string]$ClockB='-')
# Read-only diagnostic launcher. Never forwards native stderr or unvalidated stdout.
$ErrorActionPreference='Stop'
$stage='DIAGNOSTIC_PROCESS';$child=$null;$start=$null;$output=$null
try {
 $node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
 $arguments=@((Join-Path $PSScriptRoot 'diagnose-capture.mjs'),$Config,$Request,$ClockB)
 $quoted=@();foreach($argument in $arguments){
  if(-not $argument -or $argument -match '["\r\n\x00]'){throw 'Rejected'}
  $quoted+='"'+[regex]::Replace($argument,'(\\+)$','$1$1')+'"'
 }
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=$node;$start.Arguments=$quoted -join ' '
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.RedirectStandardInput=$true
 $start.EnvironmentVariables.Clear()
 foreach($name in @('SystemRoot','WINDIR','LOCALAPPDATA')){
  $value=[Environment]::GetEnvironmentVariable($name,'Process');if($value){$start.EnvironmentVariables[$name]=$value}
 }
 $child=New-Object Diagnostics.Process;$child.StartInfo=$start
 if(-not $child.Start()){throw 'Rejected'}
 $child.StandardInput.Close()
 $outBuffer=New-Object char[] 257;$errBuffer=New-Object char[] 1
 $stdout=$child.StandardOutput.ReadBlockAsync($outBuffer,0,257)
 $stderr=$child.StandardError.ReadBlockAsync($errBuffer,0,1)
 if(-not $child.WaitForExit(30000)){$child.Kill();$child.WaitForExit();throw 'Rejected'}
 $n=$stdout.GetAwaiter().GetResult();$e=$stderr.GetAwaiter().GetResult()
 if($n -gt 256 -or $e -ne 0){throw 'Rejected'}
 $output=New-Object string($outBuffer,0,$n);$v=$output|ConvertFrom-Json
 $allowed=@('BOOTSTRAP','RUNTIME','PUBLIC_INPUT_PATHS','CONFIGURATION_JSON','HANDOFF_JSON','SYNTHETIC_BINDINGS','PUBLIC_WITNESS_IDENTITY','STORAGE_VALIDATION','OPERATION_LOCK','KEY_FILE_METADATA','ARCHIVE_LAYOUT','CLOCK_INTEGRITY','CLOCK_FRESHNESS','AUDIT_PATH','RECORD_ABSENT','READ_ONLY_CHECKS','DIAGNOSTIC_PROCESS')
 if((@($v.PSObject.Properties.Name|Sort-Object) -join ',') -cne 'stage,status' -or $allowed -cnotcontains $v.stage -or @('PASS','FAIL') -cnotcontains $v.status){throw 'Rejected'}
 if(($v.status -ceq 'PASS' -and ($v.stage -cne 'READ_ONLY_CHECKS' -or $child.ExitCode -ne 0)) -or ($v.status -ceq 'FAIL' -and $child.ExitCode -ne 1)){throw 'Rejected'}
 $stage=$v.stage;$status=$v.status
} catch {$stage='DIAGNOSTIC_PROCESS';$status='FAIL'}
finally {if($child){$child.Dispose()};$output=$null;$start=$null}
[Console]::Out.WriteLine(('{"stage":"'+$stage+'","status":"'+$status+'"}'))
if($status -ceq 'FAIL'){exit 1}

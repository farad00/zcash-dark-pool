param(
  [Parameter(Mandatory=$true)][string]$Endpoint,
  [ValidateRange(1,10000)][int]$DeadlineMs = 10000
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$probe = New-Object System.Diagnostics.Process
$clock = [Diagnostics.Stopwatch]::StartNew()
$exitCode = $null
$timeout = $false
try {
  $probe.StartInfo.FileName = Join-Path $PSScriptRoot '../../target/debug/darkpool-zcash.exe'
  $probe.StartInfo.UseShellExecute = $false
  $probe.StartInfo.CreateNoWindow = $true
  $probe.StartInfo.RedirectStandardOutput = $true
  $probe.StartInfo.RedirectStandardError = $true
  # No wallet, database, product, network-selection or credential environment inputs.
  $probe.StartInfo.EnvironmentVariables.Clear()
  if ($env:SystemRoot) { $probe.StartInfo.EnvironmentVariables['SystemRoot'] = $env:SystemRoot }
  # URI characters cannot be command-line quotes, whitespace or control characters.
  if ($Endpoint -match '[\s"\x00-\x1f]') { throw 'Invalid diagnostic endpoint' }
  $probe.StartInfo.Arguments = 'diagnose-connection "' + $Endpoint + '"'
  if (-not $probe.Start()) { throw 'Diagnostic start failed' }
  $stdout = $probe.StandardOutput.ReadToEndAsync()
  $stderr = $probe.StandardError.ReadToEndAsync()
  $timeout = -not $probe.WaitForExit($DeadlineMs)
  if ($timeout) { $probe.Kill(); $probe.WaitForExit() }
  $clock.Stop()
  $exitCode = $probe.ExitCode
  $output = $stdout.GetAwaiter().GetResult().Trim()
  $errorOutput = $stderr.GetAwaiter().GetResult()
  $result = 'DIAGNOSTIC_INVALID'
  if ($timeout) { $result = 'OUTER_TIMEOUT' }
  elseif ($errorOutput.Length -eq 0 -and $exitCode -eq 0 -and $output -ceq 'CONNECT_OK') { $result = 'CONNECT_OK' }
  elseif ($errorOutput.Length -eq 0 -and $exitCode -eq 1 -and $output.Length -le 256) {
    try {
      $failure = $output | ConvertFrom-Json
      $names = @($failure.PSObject.Properties.Name | Sort-Object)
      if (($names -join ',') -ceq 'class,elapsed_ms,exit_code,grpc_code' -and
          $failure.class -cin @('TLS_CONNECT','RPC_CONNECT','RPC_TIMEOUT') -and
          $failure.exit_code -eq 1 -and $failure.elapsed_ms -is [ValueType] -and
          ($null -eq $failure.grpc_code -or ($failure.grpc_code -is [ValueType] -and $failure.grpc_code -ge 0 -and $failure.grpc_code -le 16))) {
        $result = $failure.class
      }
    } catch { $result = 'DIAGNOSTIC_INVALID' }
  }
  # Wrapper statuses are not invented connection failure classes. Raw output is discarded.
  [ordered]@{result=$result;elapsed_ms=$clock.ElapsedMilliseconds;exit_code=$exitCode;outer_timeout=$timeout} | ConvertTo-Json -Compress
  if ($result -eq 'CONNECT_OK') { exit 0 }
  exit 1
} catch {
  $clock.Stop()
  # Wrapper failures carry no source text, paths or endpoint values.
  [ordered]@{result='DIAGNOSTIC_INVALID';elapsed_ms=$clock.ElapsedMilliseconds;exit_code=$exitCode;outer_timeout=$timeout} | ConvertTo-Json -Compress
  exit 1
} finally {
  try {
    if (-not $probe.HasExited) { $probe.Kill(); $probe.WaitForExit() }
  } catch { }
  $probe.Dispose()
}

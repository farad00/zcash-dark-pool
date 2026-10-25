param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference='Stop'
$taskRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskArtifacts=[IO.Path]::GetFullPath((Join-Path $taskRepo $ArtifactDirectory))
$taskPrefix=Join-Path $taskRepo '.tools/phase9-focused/'
if(-not $taskArtifacts.StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $taskArtifacts)){throw 'Fresh offline artifact directory required'}
[IO.Directory]::CreateDirectory($taskArtifacts) | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'phase9-focused-native-v1.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
Add-Type -Path (Join-Path $PSScriptRoot 'phase9-focused-fixture-v1.cs') -OutputAssembly (Join-Path $taskArtifacts 'fixture.exe') -OutputType ConsoleApplication
[IO.File]::WriteAllText((Join-Path $taskArtifacts 'fixed fixture.cmd'),"@echo off`r`nif not `"%~1`"==`"run`" exit /b 93`r`nif not `"%~2`"==`"build:web`" exit /b 94`r`nif not `"%~3`"==`"`" exit /b 95`r`necho offline cmd fixture`r`nexit /b 0`r`n",[Text.Encoding]::ASCII)
$taskSentinelStart=New-Object Diagnostics.ProcessStartInfo
$taskSentinelStart.FileName=Join-Path $taskArtifacts 'fixture.exe'
$taskSentinelStart.Arguments='sentinel';$taskSentinelStart.UseShellExecute=$false;$taskSentinelStart.CreateNoWindow=$true
$taskSentinel=[Diagnostics.Process]::Start($taskSentinelStart)
$taskSentinelCreation=$taskSentinel.StartTime.ToUniversalTime().ToString('o')
$taskResults=@();$taskChecks=@()
function Assert-Offline([bool]$value,[string]$name){$script:taskChecks+=@{name=$name;passed=$value};if(-not $value){throw "Offline assertion failed: $name"}}
try {
  $taskManifest=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'phase9-focused-v1.json') | ConvertFrom-Json
  foreach($taskStage in $taskManifest.stages) {
    $taskResolved=[FocusedNativeV1]::InspectStage($taskRepo,$taskStage.id)
    Assert-Offline (($taskResolved.command -join [char]0) -ceq ($taskStage.command -join [char]0) -and [IO.File]::Exists($taskResolved.executable)) ($taskStage.id+' exact native command resolves without execution')
  }
  Assert-Offline ([FocusedNativeV1]::ObserveCreation($PID) -eq ([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString())) 'native supervisor observation matches exact retained process creation time'
  $taskGuardDir=Join-Path $taskArtifacts 'rejected-entry-probes';[IO.Directory]::CreateDirectory($taskGuardDir)|Out-Null
  $taskPriorEnvironment=@{}
  Get-ChildItem Env: | Where-Object {$_.Name -match '^(PG|DARKPOOL_|ZCASH_)'} | ForEach-Object {$taskPriorEnvironment[$_.Name]=$_.Value;Remove-Item -LiteralPath ('Env:'+ $_.Name)}
  try {
    $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
    $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:ZCASH_NETWORK='testnet';$env:DARKPOOL_PG_PROFILE=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test/profile.json'
    foreach($taskProbe in @(@{name='PGPORT';value='55434';code='TEST_ENVIRONMENT_REQUIRED'},@{name='DARKPOOL_LIVE_INSTANCE';value='v1';code='LIVE_SELECTOR_FORBIDDEN'},@{name='DARKPOOL_PG_PROFILE';value='C:/invalid-profile';code='TEST_PROFILE_REQUIRED'},@{name='PGOPTIONS';value='unapproved';code='LIBPQ_OVERRIDE_FORBIDDEN'})) {
      $taskPrevious=[Environment]::GetEnvironmentVariable($taskProbe.name,'Process');[Environment]::SetEnvironmentVariable($taskProbe.name,$taskProbe.value,'Process');$taskRejected=$false
      try {
        # Unapproved stage identity is a SECOND independent barrier: no approved command can run.
        [FocusedNativeV1]::RunStage($taskRepo,'never-an-approved-stage',$taskGuardDir,(Join-Path $taskArtifacts 'never.stop'),[uint32]$PID,'0')|Out-Null
      } catch {$taskRejected=$_.Exception.InnerException.Message -eq $taskProbe.code}
      finally {[Environment]::SetEnvironmentVariable($taskProbe.name,$taskPrevious,'Process')}
      Assert-Offline $taskRejected ('native entry rejects '+$taskProbe.name+' before stage resolution or process creation')
    }
  } finally {
    Get-ChildItem Env: | Where-Object {$_.Name -match '^(PG|DARKPOOL_|ZCASH_)'} | ForEach-Object {Remove-Item -LiteralPath ('Env:'+ $_.Name)}
    foreach($taskName in $taskPriorEnvironment.Keys){[Environment]::SetEnvironmentVariable($taskName,$taskPriorEnvironment[$taskName],'Process')}
  }
  foreach($taskMode in @('success','nonzero','short-descendant','persistent-descendant','query-failure','pid-mismatch','interrupt','nonzero-descendant','cmd-quoting','supervisor-exit','utc-reversal')) {
    $taskOut=Join-Path $taskArtifacts $taskMode;[IO.Directory]::CreateDirectory($taskOut)|Out-Null
    $taskStop=Join-Path $taskArtifacts ($taskMode+'.stop')
    # Cancellation is delivered while the fixture is running, without PID-based termination.
    $taskTimer=$null
    if($taskMode -eq 'interrupt') {
      Add-Type -TypeDefinition 'public static class FocusedOfflineCancelV1 { public static System.Threading.Timer Start(string path) { return new System.Threading.Timer(delegate(object state) { System.IO.File.WriteAllText((string)state,"offline cancellation"); },path,400,System.Threading.Timeout.Infinite); } }'
      $taskTimer=[FocusedOfflineCancelV1]::Start($taskStop)
    }
    try {$taskTrace=[FocusedNativeV1]::RunFixture($taskRepo,$taskArtifacts,$taskMode,$taskOut,$taskStop)} finally {if($null -ne $taskTimer){$taskTimer.Dispose()}}
    $taskResults+=@{mode=$taskMode;trace=$taskTrace}
    Assert-Offline ($taskTrace.version -eq 3) "$taskMode versioned native trace"
    if($taskMode -eq 'utc-reversal'){Assert-Offline (@($taskTrace.processes|Where-Object {$_.observed_utc -lt $_.creation_utc}).Count -gt 0) 'offline injected UTC reversals retained without changing the system clock'}
    Assert-Offline $taskTrace.assigned_before_resume "$taskMode assigned before resume"
    Assert-Offline $taskTrace.cleanup_succeeded "$taskMode bounded cleanup observed"
    Assert-Offline $taskTrace.zero_observed "$taskMode successful native zero query"
    Assert-Offline (-not $taskSentinel.HasExited) "$taskMode unrelated sentinel survives"
    Assert-Offline ($taskSentinel.StartTime.ToUniversalTime().ToString('o') -eq $taskSentinelCreation) "$taskMode sentinel creation identity unchanged"
    if($taskMode -in @('success','short-descendant','cmd-quoting','utc-reversal')) {
      Assert-Offline ($null -eq $taskTrace.first_failure) "$taskMode natural completion"
      Assert-Offline ($null -ne $taskTrace.ownership) "$taskMode reporter ownership produced"
      Assert-Offline $taskTrace.identity_inventory_complete "$taskMode total-process identity reconciliation"
    } else {
      Assert-Offline ($null -ne $taskTrace.first_failure) "$taskMode failure retained"
    }
    if($taskMode -in @('nonzero','nonzero-descendant')){Assert-Offline ($taskTrace.root_exit_code -eq 17) "$taskMode original child failure 17 retained"}
    if($taskMode -eq 'short-descendant'){Assert-Offline (@($taskTrace.processes | Where-Object {$_.pid -ne $taskTrace.root_pid -and $_.exit_utc -gt $taskTrace.root_exit_utc}).Count -ge 1) 'short descendant identity and lifetime retained'}
    if($taskMode -eq 'persistent-descendant'){Assert-Offline ($taskTrace.termination_requested -and $null -eq $taskTrace.ownership) 'persistent descendant terminated only as failure'}
    if($taskMode -eq 'query-failure'){Assert-Offline (@($taskTrace.accounting | Where-Object {-not $_.succeeded -and $null -ne $_.win32_error}).Count -gt 0) 'genuine failed Win32 query retained'}
    if($taskMode -eq 'pid-mismatch'){Assert-Offline ($taskTrace.first_failure -eq 'CREATION_TIME_MISMATCH') 'same held PID with incorrect creation time rejected'}
    if($taskMode -eq 'interrupt'){Assert-Offline ($taskTrace.first_failure -eq 'INTERRUPTED' -and $taskTrace.termination_requested) 'interruption stops and cleans only owned job'}
    if($taskMode -eq 'supervisor-exit'){Assert-Offline ($taskTrace.first_failure -eq 'SUPERVISOR_EXITED' -and $taskTrace.termination_requested -and $taskTrace.supervisor_creation_filetime) 'supervisor loss detected through retained native identity handle'}
    Assert-Offline (([datetime]$taskTrace.ended_utc-[datetime]$taskTrace.started_utc).TotalMilliseconds -lt 8000) "$taskMode offline lifecycle wall time bounded"
  }
  foreach($taskMode in @('incomplete-history','assignment-failure','breakaway','journal-overflow','qpc-failure')) {
    $taskOut=Join-Path $taskArtifacts $taskMode;[IO.Directory]::CreateDirectory($taskOut)|Out-Null
    $taskTrace=[FocusedNativeV1]::RunFixture($taskRepo,$taskArtifacts,$taskMode,$taskOut,(Join-Path $taskArtifacts ($taskMode+'.stop')))
    $taskResults+=@{mode=$taskMode;trace=$taskTrace}
    Assert-Offline (-not $taskSentinel.HasExited) "$taskMode unrelated sentinel survives"
    Assert-Offline ($taskSentinel.StartTime.ToUniversalTime().ToString('o') -eq $taskSentinelCreation) "$taskMode sentinel identity unchanged"
    if($taskMode -eq 'incomplete-history') {
      Assert-Offline ($taskTrace.total_processes -gt $taskTrace.processes.Count -and $taskTrace.processes.Count -ge 1) 'native fixture retains actual lifetime and observed counts without assuming platform child count'
      Assert-Offline (-not $taskTrace.identity_inventory_complete) 'incomplete history never labeled complete'
      Assert-Offline ($taskTrace.tree_completion_verified -and $taskTrace.zero_observed -and $taskTrace.cleanup_succeeded -and -not $taskTrace.termination_requested) 'incomplete history has genuine natural zero completion'
      Assert-Offline ($null -ne $taskTrace.ownership -and $taskTrace.ownership.historical.missing_identity_count -eq ($taskTrace.total_processes-$taskTrace.processes.Count)) 'unknown identities reported independently from actual counts'
      Assert-Offline ($taskTrace.acquisition_failures.Count -eq 4) 'offline omissions explicitly retained as acquisition limitations'
    } else {
      Assert-Offline ($null -ne $taskTrace.first_failure -and $null -eq $taskTrace.ownership -and -not $taskTrace.tree_completion_verified) "$taskMode never produces completion proof"
      if($taskMode -eq 'assignment-failure'){Assert-Offline (-not $taskTrace.assigned_before_resume -and $taskTrace.cleanup_succeeded) 'real invalid-job assignment fails and original suspended root is cleaned'}
      if($taskMode -eq 'breakaway'){Assert-Offline ($taskTrace.first_failure -eq 'BREAKAWAY_OR_UNEXPECTED_LIMITS' -and $taskTrace.root_pid -eq 0) 'native breakaway flag readback rejected before child creation'}
    }
  }
  foreach($taskTrace in ($taskResults | ForEach-Object {$_.trace})) {
    Assert-Offline (@($taskTrace.processes | Where-Object {-not $_.membership_verified -or -not $_.handle_closed -or -not $_.creation_filetime -or -not $_.handle_binding}).Count -eq 0) 'all observed identities native-bound and handles released'
    if($null -ne $taskTrace.total_processes){Assert-Offline ($taskTrace.identity_inventory_complete -eq ($taskTrace.total_processes -eq $taskTrace.processes.Count -and @($taskTrace.processes|Where-Object {-not $_.exit_utc}).Count -eq 0)) 'history completeness reflects observed identities and exits independently of safe delayed handle release'}
    if($null -ne $taskTrace.ordering) {
      Assert-Offline ($taskTrace.ordering.record_count -eq $taskTrace.ordering.events.Count) 'native journal retains exact record count'
      Assert-Offline (@($taskTrace.ordering.events | Where-Object {$_.thread_id -ne $taskTrace.ordering.thread_id -or $_.session_id -ne $taskTrace.ordering.session_id}).Count -eq 0) 'every native event retains actual observer thread and session'
      if($taskTrace.ordering.complete){Assert-Offline ([long]$taskTrace.ordering.frequency -eq [Diagnostics.Stopwatch]::Frequency) 'native QPC frequency matches independent managed QPC frequency'}
    }
  }
} finally {
  # This Process instance retains the handle of OUR sentinel, never a global PID lookup.
  if(-not $taskSentinel.HasExited){$taskSentinel.Kill();if(-not $taskSentinel.WaitForExit(5000)){throw 'Owned sentinel cleanup failed'}}
  $taskSentinel.Dispose()
  $taskSummary=@{checks=$taskChecks;total=$taskChecks.Count;passed=@($taskChecks|Where-Object {$_.passed}).Count;cases=$taskResults.Count;application_tests=0;manifest_executions=0;sentinel_creation_utc=$taskSentinelCreation}
  [IO.File]::WriteAllText((Join-Path $taskArtifacts 'summary.json'),($taskSummary | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
}
[pscustomobject]$taskSummary | Select-Object total,passed,cases,application_tests,manifest_executions | ConvertTo-Json -Compress

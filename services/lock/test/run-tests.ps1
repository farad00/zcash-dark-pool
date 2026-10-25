param([ValidateSet('phase11','phase9')][string]$Action='phase11',[string]$NamePattern='')
$ErrorActionPreference='Stop'
$phase11Repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
. (Join-Path $phase11Repo 'scripts/dev/activate.ps1')
$phase11TestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
$phase11Credential=Import-Clixml -LiteralPath (Join-Path $phase11TestRoot 'maintenance.xml')
if($phase11Credential.UserName -ne 'darkpool_test_maintenance'){throw 'TEST credential identity rejected'}
$phase11Names=@('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE')
$phase11Previous=@{}
foreach($name in $phase11Names){$phase11Previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
 $env:PGPASSWORD=$phase11Credential.GetNetworkCredential().Password
 $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
 $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $phase11TestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
 Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
 if($Action -eq 'phase11') {
  $phase11Args=@('--test','--test-concurrency=1')
  if($NamePattern){$phase11Args+=@('--test-name-pattern',$NamePattern)}
  $phase11Args+=(Join-Path $phase11Repo 'db/test/lock.test.mjs')
  & node @phase11Args
 }
 else { & node --test --test-concurrency=1 (Join-Path $phase11Repo 'db/test/watcher.test.mjs') }
 if($LASTEXITCODE -ne 0){throw 'Focused TEST-only checks failed'}
} finally {
 foreach($name in $phase11Names){[Environment]::SetEnvironmentVariable($name,$phase11Previous[$name],'Process')}
}

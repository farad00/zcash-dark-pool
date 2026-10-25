param([ValidateSet('unit','postgres','native')][string]$Action='unit')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$backupRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$prior=@{}
foreach($key in @('PGPASSWORD','PGHOST','PGPORT','PGUSER','PGDATABASE','DARKPOOL_PG_ENV','DARKPOOL_PG_PROFILE','DARKPOOL_TEST_ONLY','DARKPOOL_LIVE_INSTANCE','APP_ENV','ZCASH_NETWORK','DARKPOOL_BACKUP_TEST_ONLY')){$prior[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
Push-Location $backupRepo
try{
 cargo build --manifest-path tools/backup-age/Cargo.toml --target-dir .tools/backup-target --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Backup helper build failed'}
 $env:DARKPOOL_BACKUP_TEST_ONLY='1';$env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
 $env:APP_ENV='development';$env:ZCASH_NETWORK='testnet';Remove-Item Env:DARKPOOL_LIVE_INSTANCE -ErrorAction SilentlyContinue
 if($Action -eq 'native'){
  cargo test --manifest-path tools/backup-age/Cargo.toml --target-dir .tools/backup-target --offline --locked
 }elseif($Action -eq 'unit'){
  node --test services/backup/test/crypto.test.mjs
 }else{
  $root=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
  $credential=Import-Clixml -LiteralPath (Join-Path $root 'maintenance.xml')
  if($credential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST identity required'}
  $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGDATABASE='postgres';$env:PGUSER=$credential.UserName;$env:PGPASSWORD=$credential.GetNetworkCredential().Password
  $env:DARKPOOL_PG_PROFILE=Join-Path $root 'profile.json'
  node --test --test-concurrency=1 services/backup/test/recovery.test.mjs
 }
 if($LASTEXITCODE -ne 0){throw 'Backup TEST rehearsal failed'}
}finally{
 foreach($key in $prior.Keys){[Environment]::SetEnvironmentVariable($key,$prior[$key],'Process')}
 $credential=$null;Pop-Location
}

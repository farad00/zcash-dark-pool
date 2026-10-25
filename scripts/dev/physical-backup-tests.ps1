$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$physicalRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$physicalSaved=@{}
$physicalKeys=@(Get-ChildItem Env: | Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','APP_ENV','ZCASH_NETWORK')} | Select-Object -ExpandProperty Name)
foreach($physicalKey in @($physicalKeys+@('DARKPOOL_BACKUP_TEST_ONLY','DARKPOOL_PHYSICAL_REHEARSAL','DARKPOOL_PG_ENV','DARKPOOL_TEST_ONLY') | Sort-Object -Unique)){
 $physicalSaved[$physicalKey]=[Environment]::GetEnvironmentVariable($physicalKey,'Process')
 [Environment]::SetEnvironmentVariable($physicalKey,$null,'Process')
}
Push-Location $physicalRepo
try {
 cargo build --manifest-path tools/backup-age/Cargo.toml --target-dir .tools/backup-target --offline --locked
 if($LASTEXITCODE -ne 0){throw 'Physical helper build failed'}
 $env:DARKPOOL_BACKUP_TEST_ONLY='1';$env:DARKPOOL_PHYSICAL_REHEARSAL='1';$env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_TEST_ONLY='TEST_ONLY'
 node --test --test-concurrency=1 services/backup/test/physical.test.mjs
 if($LASTEXITCODE -ne 0){throw 'Disposable physical recovery rehearsal failed'}
}finally{
 foreach($physicalKey in $physicalSaved.Keys){[Environment]::SetEnvironmentVariable($physicalKey,$physicalSaved[$physicalKey],'Process')}
 Pop-Location
}

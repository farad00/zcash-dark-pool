$ErrorActionPreference='Stop'
. "$PSScriptRoot/activate.ps1"
$developmentRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$developmentPrevious=@{}
$developmentNames=@(Get-ChildItem Env:|Where-Object {$_.Name -match '^PG' -or $_.Name -match '^DARKPOOL_' -or $_.Name -in @('DATABASE_URL','WALLET_DB_PATH','APP_ENV','ZCASH_NETWORK')}|Select-Object -ExpandProperty Name)
foreach($developmentName in @($developmentNames+@('DARKPOOL_DEV_REHEARSAL')|Sort-Object -Unique)){
 $developmentPrevious[$developmentName]=[Environment]::GetEnvironmentVariable($developmentName,'Process');[Environment]::SetEnvironmentVariable($developmentName,$null,'Process')
}
Push-Location $developmentRepo
try{
 $env:DARKPOOL_DEV_REHEARSAL='1'
 node --test --test-concurrency=1 db/test/v2-development.test.mjs
 if($LASTEXITCODE -ne 0){throw 'Disposable development bootstrap tests failed'}
}finally{
 foreach($developmentName in $developmentPrevious.Keys){[Environment]::SetEnvironmentVariable($developmentName,$developmentPrevious[$developmentName],'Process')};Pop-Location
}

param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$ArtifactDirectory,[Parameter(Mandatory=$true)][string]$StopFile,[Parameter(Mandatory=$true)][uint32]$OwnerPid,[Parameter(Mandatory=$true)][string]$OwnerCreation)
$ErrorActionPreference='Stop'
$taskRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskManifest=Join-Path $PSScriptRoot 'phase9-focused-v1.json'
if((Get-FileHash -LiteralPath $taskManifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne '5e01a728d362c098303e63b27c7d578112a51a5986284e564d67ec0e049f3986'){throw 'Unapproved manifest'}
$taskSpec=Get-Content -Raw -LiteralPath $taskManifest|ConvertFrom-Json
if(@($taskSpec.stages|Where-Object {$_.id -ceq $Stage}).Count -ne 1){throw 'Unknown stage'}
. (Join-Path $taskRepo 'scripts/dev/activate.ps1')
# Discard inherited database selectors/options. Only the protected TEST maintenance identity is loaded.
Get-ChildItem Env: | Where-Object {$_.Name -match '^(PG|DARKPOOL_|ZCASH_)'} | ForEach-Object {Remove-Item -LiteralPath ('Env:'+ $_.Name)}
$taskTestRoot=Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-test'
$taskCredentialPath=Join-Path $taskTestRoot 'maintenance.xml'
if(((Get-Item -LiteralPath $taskCredentialPath).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Credential redirect rejected'}
$taskCredential=Import-Clixml -LiteralPath $taskCredentialPath
if($taskCredential.UserName -cne 'darkpool_test_maintenance'){throw 'TEST credential identity rejected'}
try {
 $env:PGHOST='127.0.0.1';$env:PGPORT='55433';$env:PGUSER='darkpool_test_maintenance';$env:PGDATABASE='postgres'
 $env:PGPASSWORD=$taskCredential.GetNetworkCredential().Password
 $env:DARKPOOL_PG_ENV='TEST';$env:DARKPOOL_PG_PROFILE=Join-Path $taskTestRoot 'profile.json';$env:DARKPOOL_TEST_ONLY='TEST_ONLY';$env:ZCASH_NETWORK='testnet'
 Add-Type -Path (Join-Path $PSScriptRoot 'phase9-focused-native-v1.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
 $taskResult=[FocusedNativeV1]::RunStage($taskRepo,$Stage,$ArtifactDirectory,$StopFile,$OwnerPid,$OwnerCreation)
 if($null -ne $taskResult.root_exit_code -and $taskResult.root_exit_code -ne 0){exit $taskResult.root_exit_code}
 if($null -ne $taskResult.first_failure -or $null -eq $taskResult.ownership){exit 1}
 exit 0
} finally {$env:PGPASSWORD=$null;$taskCredential=$null}

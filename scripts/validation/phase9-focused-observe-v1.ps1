param([Parameter(Mandatory=$true)][uint32]$OwnerPid)
# Native/file observations only. No SQL, credentials, application imports or lifecycle operations.
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'phase9-focused-native-v1.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
$taskOwnerCreation=[FocusedNativeV1]::ObserveCreation($OwnerPid)
$taskProcesses=@(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object {$_.CommandLine -match 'postgres-test|phase9_payment_v1|phase9_payment_v2'} | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine)
$taskListeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in 55433,55434,55435} | Select-Object LocalAddress,LocalPort,OwningProcess)
@{processes=$taskProcesses;listeners=$taskListeners;supervisor=@{pid=$OwnerPid;creation_filetime=$taskOwnerCreation}} | ConvertTo-Json -Depth 6 -Compress

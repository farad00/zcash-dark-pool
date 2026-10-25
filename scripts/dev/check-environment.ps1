$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/activate.ps1"
foreach ($tool in @('git','rustc','cargo','rustup','node','npm.cmd','psql','pg_config','postgres','docker','cmake','ninja','clang','protoc')) {
  $found = Get-Command $tool -ErrorAction SilentlyContinue
  if ($found) { Write-Output "$tool : $($found.Source)" }
  else { Write-Output "$tool : MISSING FROM PATH" }
}
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
if (Test-Path $vswhere) {
  & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}

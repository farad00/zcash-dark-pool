# Dot-source from PowerShell: . ./scripts/dev/activate.ps1
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (Test-Path (Join-Path $repoRoot '.tools/cargo/bin/cargo.exe')) {
  $env:CARGO_HOME = Join-Path $repoRoot '.tools/cargo'
  $env:RUSTUP_HOME = Join-Path $repoRoot '.tools/rustup'
  $env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
}
$nodeDir = Get-ChildItem (Join-Path $repoRoot '.tools') -Directory -Filter 'node-*-win-x64' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nodeDir) { $env:PATH = "$($nodeDir.FullName);$env:PATH" }
$pgBin = Join-Path $repoRoot '.tools/pgsql/bin'
if (Test-Path $pgBin) { $env:PATH = "$pgBin;$env:PATH" }

param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/v2-security.ps1"
try{
 if($env:DARKPOOL_DEV_REHEARSAL -cne '1'){throw 'rehearsal only'}
 $developmentFixture=[IO.Path]::GetFullPath($Directory)
 if((Split-Path -Parent $developmentFixture).TrimEnd('\') -ine ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $developmentFixture) -cnotmatch '^darkpool-backup-fixture-[a-f0-9]{32}$'){throw 'fixture path required'}
 Assert-V2Acl $developmentFixture -ProtectedRoot
 $developmentProfile=Get-Content -LiteralPath (Join-Path $developmentFixture 'development-profile.json') -Raw|ConvertFrom-Json
 $developmentSuffix=(Split-Path -Leaf $developmentFixture).Substring(40)
 if($developmentProfile.kind -cne 'DEVELOPMENT_ONLY' -or $developmentProfile.execution -cne 'DISPOSABLE_REHEARSAL' -or $developmentProfile.financial_authorized -ne $false){throw 'fixture kind required'}
 $developmentCredentials=@{}
 foreach($developmentPurpose in @('maintenance','read')){
  $developmentFile=Join-Path $developmentFixture ($developmentPurpose+'.xml');Assert-V2Acl $developmentFile
  $developmentSaved=Import-Clixml -LiteralPath $developmentFile
  $developmentExpected=if($developmentPurpose -eq 'maintenance'){'darkpool_devmaint_'}else{'darkpool_devread_'}
  if($developmentSaved.UserName -cne ($developmentExpected+$developmentSuffix)){throw 'fixture login required'}
  $developmentCredentials[$developmentPurpose]=$developmentSaved.GetNetworkCredential().Password
 }
 # Private pipe to the Node fixture only. Never invoke at an interactive console.
 $developmentCredentials|ConvertTo-Json -Compress
}catch{Write-Output 'DEVELOPMENT_FIXTURE_CREDENTIAL_REJECTED';exit 1}

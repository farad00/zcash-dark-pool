[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. "$PSScriptRoot/v2-security.ps1"
. "$PSScriptRoot/postgresql-staging-core.ps1"
$stage='ACCOUNT'
try {
 if($args.Count -ne 0){throw 'fixed target only'}
 $who=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=[Security.Principal.WindowsPrincipal]::new($who)
 if($who.Name -cne 'ABDULSAMAD\Admin' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'normal operator required'}
 if($env:ProgramData -ine 'C:\ProgramData'){throw 'ProgramData mismatch'}
 $stage='PATHS'
 $roots=@('C:\ProgramData\ZcashDarkPoolRehearsal\testnet_observation_v1','C:\ProgramData\ZcashDarkPoolSigning\testnet_observation_v1')
 foreach($root in $roots){Assert-V2LocalPath $root;if(Test-Path -LiteralPath $root){throw 'target occupied'}}
 # Read listener metadata only; no connection, bind, SQL or service lifecycle action.
 $stage='PORT'
 if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 55436).Count -ne 0){throw 'port occupied'}
 $stage='ACCOUNT_NAMES'
 $names=@('ZDPRehearsalPg','ZDPRehearsalView','ZDPRehearsalWeb','ZDPSigner1','ZDPRecoveryOperator')
 if(@(Get-LocalUser -ErrorAction Stop|Where-Object Name -in $names).Count -ne 0){throw 'account name occupied'}
 $stage='DISK'
 $disk=Get-Volume -DriveLetter C -ErrorAction Stop
 if($disk.FileSystem -cne 'NTFS' -or $disk.HealthStatus -cne 'Healthy' -or $disk.SizeRemaining -lt 10GB){throw 'storage unavailable'}
 $stage='ANCESTORS'
 $ancestors=@()
 foreach($at in @('C:\','C:\ProgramData','C:\ProgramData\ZcashDarkPoolRehearsal','C:\ProgramData\ZcashDarkPoolSigning')){
  if(Test-Path -LiteralPath $at){
   $acl=Get-Acl -LiteralPath $at
   $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
   if($owner -notin @('S-1-5-18','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')){throw 'unexpected ancestor owner'}
   $ancestors+=@{path=$at;owner_sid=$owner;reparse_point=$false}
  }
 }
 $stage='PINNED_TOOL_INSTALLATION'
 $tools=Confirm-PgInstallation (New-PgProductionContext)
 # Manifest pins identify the reviewed version without running even --version.
 [ordered]@{status='PHYSICAL_AVAILABILITY_PASS';instance='testnet_observation_v1';host='127.0.0.1';port=55436;database='darkpool_testnet_observation_v1';account=$who.Name;elevated=$false;target_roots_absent=$true;service_account_names_available=$true;filesystem=$disk.FileSystem;free_bytes=$disk.SizeRemaining;ancestors=$ancestors;postgres_version=(Get-PgStageProfile).build;postgres_tools=$tools;binary_execution='NOT_EXECUTED';acl_application='NOT_EXECUTED';service_sid_separation='NOT_PROVISIONED';off_device_recovery='NOT_CONFIGURED';persistent_creation='NOT_APPROVED';financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Depth 5
}catch{[ordered]@{status='PREFLIGHT_BLOCKED';stage=$stage;persistent_creation='NOT_APPROVED';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress;exit 1}

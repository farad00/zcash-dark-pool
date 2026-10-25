[CmdletBinding()]
param([ValidateSet('Plan','ReviewProvenance','Verify','Stage')][string]$Action='Plan',[switch]$ExtractionApproved)
$ErrorActionPreference='Stop'
$stage='CORE_LOAD'
try{
 . "$PSScriptRoot/postgresql-staging-core.ps1"
 $stage='PROFILE'
 $p=Get-PgStageProfile
 if($args.Count -ne 0 -or ($ExtractionApproved -and $Action -cne 'Stage')){throw 'PG_ARGUMENTS_REJECTED'}
 switch($Action){
  'Plan' {[ordered]@{status='STAGING_PLAN_ONLY';destination=$p.destination;archive_sha256=$p.archive_sha256;inventory_sha256=$p.inventory_sha256;administrator_required_for_stage=$true;extraction_authorization='SEPARATE_APPROVAL_REQUIRED';binary_execution='NOT_AUTHORIZED';financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Compress}
  'ReviewProvenance' {$stage='VENDOR_PROVENANCE';Get-PgVendorChecksum $p|ConvertTo-Json -Compress}
  'Verify' {$stage='INSTALLATION_VERIFICATION';Confirm-PgInstallation (New-PgProductionContext)|ConvertTo-Json -Compress}
  'Stage' {
   $stage='EXTRACTION_APPROVAL';if(-not $ExtractionApproved){throw 'PG_EXTRACTION_APPROVAL_REQUIRED'}
   $stage='OPERATOR';$who=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($who)
   if($who.Name -cne 'ABDULSAMAD\Admin' -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'PG_ADMIN_REQUIRED'}
   $stage='VENDOR_PROVENANCE';$vendor=Get-PgVendorChecksum $p
   $stage='CREATE_ONLY_STAGE';Invoke-PgCreateOnlyStage (New-PgProductionContext) $vendor|ConvertTo-Json -Depth 5 -Compress
  }
 }
}catch{
 $reason=if($stage -ceq 'CORE_LOAD'){'PG_CORE_UNAVAILABLE'}else{Get-PgFailureReason $_}
 [ordered]@{status='POSTGRESQL_STAGING_NOT_CONFIRMED';stage=$stage;reason=$reason;partial_state='PRESERVE_AND_REVIEW_IF_PRESENT';financial_authorization='NOT_GRANTED';production_trust='UNAVAILABLE'}|ConvertTo-Json -Compress
 exit 1
}

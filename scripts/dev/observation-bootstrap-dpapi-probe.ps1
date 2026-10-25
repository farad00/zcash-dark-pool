[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ExpectedSid)
$ErrorActionPreference='Stop'
try {
 if($args.Count -ne 0 -or $env:DARKPOOL_OBSERVATION_V1_TEST_ONLY -cne '1'){throw 'fixture only'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 if($ExpectedSid -cne $sid){throw 'wrong identity'}
 Add-Type -AssemblyName System.Security
 $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
 $plain=New-Object byte[] 32;$entropy=New-Object byte[] 32
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
 try{$rng.GetBytes($plain);$rng.GetBytes($entropy)}finally{$rng.Dispose()}
 try {
  $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,$scope)
  $recovered=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,$scope)
  if([BitConverter]::ToString($plain) -cne [BitConverter]::ToString($recovered)){throw 'roundtrip failed'}
  $other=$entropy.Clone();$other[0]=$other[0] -bxor 1
  $denied=$false;try{[void][Security.Cryptography.ProtectedData]::Unprotect($cipher,$other,$scope)}catch{$denied=$true}
  if(-not $denied){throw 'binding failed'}
  $cipher[$cipher.Length-1]=$cipher[$cipher.Length-1] -bxor 1
  $denied=$false;try{[void][Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,$scope)}catch{$denied=$true}
  if(-not $denied){throw 'tamper failed'}
 }finally{foreach($buffer in @($plain,$entropy,$recovered)){if($buffer){[Array]::Clear($buffer,0,$buffer.Length)}}}
 [ordered]@{stage='CURRENT_USER_DPAPI_PROBE';status='PASS';wrong_entropy_rejected=$true;tampering_rejected=$true;cross_account='NOT_TESTED';service_user='NOT_TESTED';financial_authorization='NOT_GRANTED'}|ConvertTo-Json -Compress
}catch{
 [ordered]@{stage='CURRENT_USER_DPAPI_PROBE';status='FAIL';reason='IDENTITY_OR_DPAPI_CHECK_REJECTED'}|ConvertTo-Json -Compress
 exit 1
}

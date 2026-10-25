param([Parameter(Mandatory=$true)][string]$Case)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../../scripts/dev/publication-credentials.ps1')
$fixture=$null;$secret=$null;$token=$null;$start=$null
function Require($Condition){if(-not $Condition){throw 'SYNTHETIC_ASSERTION_FAILED'}}
function Reject([scriptblock]$Work){$rejected=$false;try{& $Work|Out-Null}catch{$rejected=$true;Require (-not $_.ToString().Contains($token))};Require $rejected}
function Replace-Payload([scriptblock]$Change){
  $v=Read-PublicationCredential $root;& $Change $v
  $bytes=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Compress))
  try {$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,(Get-PublicationEntropy),[Security.Cryptography.DataProtectionScope]::CurrentUser)}finally{[Array]::Clear($bytes,0,$bytes.Length);$v=$null}
  [IO.File]::WriteAllText($path,([ordered]@{version=1;protected_payload=[Convert]::ToBase64String($cipher)}|ConvertTo-Json -Compress))
}
try {
  if($env:NODE_TEST_CONTEXT -cne 'child-v8'){throw 'SYNTHETIC_ONLY'}
  $id=[Guid]::NewGuid().ToString('N')
  $fixture=Join-Path ([IO.Path]::GetTempPath()) ('darkpool-publication-credentials-'+$id)
  New-Item -ItemType Directory -Path $fixture|Out-Null
  [IO.File]::WriteAllText((Join-Path $fixture 'fixture-identity.txt'),$id)
  $root=Join-Path $fixture 'private';$path=Join-Path $root 'github-token.json'
  $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$rng.GetBytes($bytes);$token='SYNTHETIC_'+([BitConverter]::ToString($bytes)).Replace('-','')}finally{$rng.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}
  $secret=ConvertTo-SecureString $token -AsPlainText -Force
  $expiry=[DateTime]::UtcNow.AddHours(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  if($Case -ne 'missing') {Write-PublicationCredential $root $secret $expiry}
  switch($Case) {
    'roundtrip' {
      $v=Read-PublicationCredential $root;Require ($v.token -ceq $token);Require ($v.repository_id -ceq '1427973036')
      Assert-PublicationAcl $root -Root;Assert-PublicationAcl $path
      Require (-not [IO.File]::ReadAllText($path).Contains($token));$v=$null
    }
    'duplicate' {$before=[IO.File]::ReadAllText($path);Reject {Write-PublicationCredential $root $secret $expiry};Require ([IO.File]::ReadAllText($path) -ceq $before)}
    'wrong-user' {Replace-Payload {param($v)$v.user_sid='S-1-5-21-111-222-333-444'};Reject {Read-PublicationCredential $root}}
    'wrong-repository' {Replace-Payload {param($v)$v.repository_id='1428218674'};Reject {Read-PublicationCredential $root}}
    'wrong-repository-name' {Replace-Payload {param($v)$v.repository='https://github.com/0xfarad/commitment-witness'};Reject {Read-PublicationCredential $root}}
    'metadata-type' {Replace-Payload {param($v)$v.repository_id=1427973036};Reject {Read-PublicationCredential $root}}
    'expired' {Replace-Payload {param($v)$v.expires_at='2020-01-01T00:00:00.000Z'};Reject {Read-PublicationCredential $root}}
    'missing-expiry' {Replace-Payload {param($v)$v.expires_at=''};Reject {Read-PublicationCredential $root}}
    'invalid-expiry' {Reject {Get-PublicationExpiry '2026-02-30T00:00:00Z'};Reject {Get-PublicationExpiry '2030-01-01T00:00:00+01:00'};Reject {Get-PublicationExpiry ([DateTime]::UtcNow.AddSeconds(15).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"))}}
    'corruption' {$v=Get-Content -Raw -LiteralPath $path|ConvertFrom-Json;$raw=[Convert]::FromBase64String($v.protected_payload);$raw[30]=$raw[30] -bxor 1;$v.protected_payload=[Convert]::ToBase64String($raw);[IO.File]::WriteAllText($path,($v|ConvertTo-Json -Compress));Reject {Read-PublicationCredential $root}}
    'wrong-entropy' {$v=Read-PublicationCredential $root;$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Compress));try{$raw=[Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('WRONG_SYNTHETIC_CONTEXT'),[Security.Cryptography.DataProtectionScope]::CurrentUser)}finally{[Array]::Clear($b,0,$b.Length);$v=$null};[IO.File]::WriteAllText($path,([ordered]@{version=1;protected_payload=[Convert]::ToBase64String($raw)}|ConvertTo-Json -Compress));Reject {Read-PublicationCredential $root}}
    'extra-field' {$v=Get-Content -Raw -LiteralPath $path|ConvertFrom-Json;$v|Add-Member unexpected 'synthetic';[IO.File]::WriteAllText($path,($v|ConvertTo-Json -Compress));Reject {Read-PublicationCredential $root}}
    'oversize' {[IO.File]::WriteAllText($path,('x'*32769));Reject {Read-PublicationCredential $root}}
    'file-acl' {$acl=Get-Acl -LiteralPath $path;$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),'Read','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $path -AclObject $acl;Reject {Read-PublicationCredential $root}}
    'root-acl' {$badRoot=Join-Path $fixture 'inherited';New-Item -ItemType Directory -Path $badRoot|Out-Null;Require (-not(Get-Acl -LiteralPath $badRoot).AreAccessRulesProtected);Copy-Item -LiteralPath $path -Destination (Join-Path $badRoot 'github-token.json');Reject {Read-PublicationCredential $badRoot}}
    'missing' {Reject {Read-PublicationCredential $root};Require (-not(Test-Path -LiteralPath $root))}
    'invalid-token' {$other=ConvertTo-SecureString ($token+"`n") -AsPlainText -Force;try{Reject {Write-PublicationCredential (Join-Path $fixture 'other') $other $expiry}}finally{$other.Dispose()}}
    {$_ -in @('child-isolation','child-output-redaction','child-error-redaction','child-timeout','child-oversize')} {
      $repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
      $node=Join-Path $repo '.tools/node-v24.21.0-win-x64/node.exe'
      $entry=Join-Path $fixture 'probe.mjs'
      $good='console.log(JSON.stringify({scope:"SYNTHETIC_TEST_ONLY",status:"GITHUB_FILE_RETRIEVED_NO_RECEIPT",repository_id:"1427973036",commit:"11".repeat(20),content_sha256:"657516b70067fa75c284359428acb75d92fb300a7b136133c3865a3d56843a2c",financial_authorization:"NOT_GRANTED"}));'
      $body=switch($Case){
        'child-isolation' {'if(!process.env.DARKPOOL_GITHUB_TOKEN||process.env.PGPASSWORD||process.env.NODE_OPTIONS||process.argv.some(v=>v.includes(process.env.DARKPOOL_GITHUB_TOKEN)))process.exit(2);'+$good}
        'child-output-redaction' {'console.log(process.env.DARKPOOL_GITHUB_TOKEN)'}
        'child-error-redaction' {'console.error(process.env.DARKPOOL_GITHUB_TOKEN);process.exitCode=1'}
        'child-timeout' {'setInterval(()=>{},1000)'}
        'child-oversize' {'process.stdout.write("x".repeat(8193))'}
      }
      [IO.File]::WriteAllText($entry,$body)
      $env:DARKPOOL_GITHUB_TOKEN='SYNTHETIC_PARENT_SENTINEL';$env:PGPASSWORD='SYNTHETIC_DB_SENTINEL';$env:NODE_OPTIONS='SYNTHETIC_UNSAFE_OPTION'
      $start=New-PublicationChild $node $entry $repo $token $expiry ('a'*64) $fixture
      Require ($env:DARKPOOL_GITHUB_TOKEN -ceq 'SYNTHETIC_PARENT_SENTINEL');Require ($start.EnvironmentVariables['DARKPOOL_GITHUB_TOKEN'] -ceq $token)
      Require (-not $start.EnvironmentVariables.ContainsKey('PGPASSWORD'));Require (-not $start.EnvironmentVariables.ContainsKey('NODE_OPTIONS'));Require (-not $start.Arguments.Contains($token))
      if($Case -eq 'child-isolation'){$r=Invoke-PublicationChild $start;Require ($r.status -ceq 'GITHUB_FILE_RETRIEVED_NO_RECEIPT')}
      else {Reject {Invoke-PublicationChild $start 1500}}
      Require (-not $start.EnvironmentVariables.ContainsKey('DARKPOOL_GITHUB_TOKEN'));Require (-not $start.EnvironmentVariables.ContainsKey('DARKPOOL_GITHUB_TOKEN_EXPIRES_AT'))
      Require ($env:DARKPOOL_GITHUB_TOKEN -ceq 'SYNTHETIC_PARENT_SENTINEL')
      Remove-Item Env:DARKPOOL_GITHUB_TOKEN,Env:PGPASSWORD,Env:NODE_OPTIONS
    }
    'exclusive-marker' {$marker=Join-Path $root 'synthetic.attempt.json';Write-PublicationMarker $marker @{scope='SYNTHETIC_TEST_ONLY'};$before=[IO.File]::ReadAllText($marker);Reject {Write-PublicationMarker $marker @{changed='NO'}};Require ([IO.File]::ReadAllText($marker) -ceq $before)}
    default {throw 'UNKNOWN_CASE'}
  }
  # All data files created by this fixture remain free of plaintext token bytes.
  foreach($item in @(Get-ChildItem -LiteralPath $fixture -File -Recurse)){Require (-not [IO.File]::ReadAllText($item.FullName).Contains($token))}
  [Console]::Out.WriteLine('SYNTHETIC_PASS:'+$Case)
} catch {
  [Console]::Error.WriteLine('SYNTHETIC_FIXTURE_FAILED:'+$Case)
  foreach($diagnostic in @($Error|Select-Object -First 4)){
    [Console]::Error.WriteLine('SYNTHETIC_ERROR_TYPE:'+$diagnostic.Exception.GetType().FullName+';LINE:'+$diagnostic.InvocationInfo.ScriptLineNumber)
  }
  exit 1
}
finally {
  if($secret){$secret.Dispose()};$token=$null
  if($fixture){
    $absolute=[IO.Path]::GetFullPath($fixture);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(-not $absolute.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $absolute) -cne ('darkpool-publication-credentials-'+$id) -or [IO.File]::ReadAllText((Join-Path $absolute 'fixture-identity.txt')) -cne $id){throw 'SYNTHETIC_CLEANUP_IDENTITY_UNCERTAIN'}
    Remove-Item -LiteralPath $absolute -Recurse -Force
  }
}

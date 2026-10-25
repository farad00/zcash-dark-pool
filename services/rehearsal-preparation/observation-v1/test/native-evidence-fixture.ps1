param([ValidateSet('durable','reparse','acl','owner','ancestor-acl','collision','interrupted','result','result-failure','result-acl-failure','ordering')][string]$Case)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$source=Join-Path $repo 'scripts/dev/observation-native-windows.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failure'}
$names=@('Assert-V2LocalPath','Assert-EvidencePath','New-EvidenceAcl','Assert-EvidenceAcl','Assert-EvidenceAncestors','New-EvidenceDirectory','Initialize-NativeEvidence','Write-EvidenceDurable','Save-NativeResult')
$functions=foreach($name in $names){$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);if(-not $f){throw 'missing helper'};$f.Extent.Text}
# Load only pure storage helpers. The runner body, accounts and services never run.
. ([ScriptBlock]::Create(($functions -join "`n")))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# TEMP on the development machine permits additional sandbox identities to
# delete children. Exercise the unchanged strict ancestor policy under the
# private LocalAppData parent instead; never broaden its SID allowlist.
$fixtureParent='C:\Users\Admin\AppData\Local'
$root=Join-Path $fixtureParent ('darkpool-evidence-test-'+[Guid]::NewGuid().ToString('N'))
$link=$null;$held=$null
function Expect-Rejection($Work,[string]$Reason){
 $caught=$false
 try{& $Work|Out-Null}catch{$caught=$true;if($Reason -and $_.Exception.Message -cne $Reason){throw 'unexpected rejection'}}
 if(-not $caught){throw 'rejection required'}
}
function Assert-Test($Value){if(-not $Value){throw 'fixture assertion'}}
try{
 New-EvidenceDirectory $root $sid
 $parent=Join-Path $root 'evidence'
 $id=[Guid]::NewGuid().ToString('N')
 switch($Case){
  'ordering'{
   $body=Get-Content -LiteralPath $source -Raw
   Assert-Test ($body.IndexOf("Initialize-NativeEvidence 'C:\ProgramData\ZcashDarkPoolRehearsalEvidence'") -lt $body.IndexOf("`$stage='FRESH_FIXTURE'"))
   Assert-Test (-not $body.Contains("`$parent=Join-Path `$repo '.tools/observation-native-windows'"))
   Assert-Test ($body.Contains("-not `$elevated -or `$id.Name -cne 'ABDULSAMAD\Admin'"))
  }
  'reparse'{
   $target=Join-Path $root 'target';New-EvidenceDirectory $target $sid
   $link=Join-Path $root 'junction';New-Item -ItemType Junction -Path $link -Target $target|Out-Null
   Expect-Rejection {Initialize-NativeEvidence (Join-Path $link 'evidence') $id $sid} 'EVIDENCE_REPARSE_REJECTED'
   Assert-Test (-not(Test-Path -LiteralPath (Join-Path $target 'evidence')))
  }
  'acl'{
   New-EvidenceDirectory $parent $sid
   $a=[IO.Directory]::GetAccessControl($parent,[Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadAndExecute','Allow'));[IO.Directory]::SetAccessControl($parent,$a)
   Expect-Rejection {Initialize-NativeEvidence $parent $id $sid} 'EVIDENCE_ACL_REJECTED'
   Assert-Test (-not(Test-Path -LiteralPath (Join-Path $parent $id)))
  }
  'owner'{Expect-Rejection {Assert-EvidenceAcl $root 'S-1-5-21-1-2-3-4001'} 'EVIDENCE_ACL_REJECTED'}
  'ancestor-acl'{
   $a=[IO.Directory]::GetAccessControl($root,[Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'DeleteSubdirectoriesAndFiles','Allow'));[IO.Directory]::SetAccessControl($root,$a)
   Expect-Rejection {Initialize-NativeEvidence $parent $id $sid} 'EVIDENCE_ACL_REJECTED'
   Assert-Test (-not(Test-Path -LiteralPath $parent))
  }
  default{
   $directory=Initialize-NativeEvidence $parent $id $sid
   Assert-EvidenceAcl $parent $sid;Assert-EvidenceAcl $directory $sid
   $bytes=[Text.Encoding]::UTF8.GetBytes('{"scope":"SYNTHETIC_STORAGE_TEST_ONLY"}')
   switch($Case){
    'durable'{
     Write-EvidenceDurable $directory '00-event.json' $bytes $sid
     $p=Join-Path $directory '00-event.json';Assert-EvidenceAcl $p $sid
     Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) -ceq [Convert]::ToBase64String($bytes))
     Expect-Rejection {Write-EvidenceDurable $directory '../escape.json' $bytes $sid} 'EVIDENCE_PATH_REJECTED'
    }
    'collision'{
     Write-EvidenceDurable $directory '00-event.json' $bytes $sid
     $hash=(Get-FileHash -LiteralPath (Join-Path $directory '00-event.json')).Hash
     Expect-Rejection {Initialize-NativeEvidence $parent $id $sid} 'EVIDENCE_COLLISION'
     Expect-Rejection {Write-EvidenceDurable $directory '00-event.json' ([byte[]]@(1,2)) $sid}
     Assert-Test ((Get-FileHash -LiteralPath (Join-Path $directory '00-event.json')).Hash -ceq $hash)
    }
    'interrupted'{
     # Simulate the retained prefix from an interrupted write. Never repair,
     # truncate or overwrite it; exclusive handles also reject another writer.
     $p=Join-Path $directory '00-event.json'
     $held=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
     $held.WriteByte(123);$held.Flush($true)
     Expect-Rejection {Write-EvidenceDurable $directory '00-event.json' $bytes $sid}
     $held.Dispose();$held=$null
     $hash=(Get-FileHash -LiteralPath $p).Hash
     Expect-Rejection {Write-EvidenceDurable $directory '00-event.json' $bytes $sid}
     Assert-Test ((Get-FileHash -LiteralPath $p).Hash -ceq $hash)
     Assert-Test ((Get-Item -LiteralPath $p).Length -eq 1)
    }
    default{
     $report=[ordered]@{status='FAIL_OR_BLOCKED';failure=[ordered]@{stage='SYNTHETIC_TEST';reason='ORIGINAL_FAILURE'};financial_authorization='NOT_GRANTED'}
     if($Case -ceq 'result-failure'){
      Write-EvidenceDurable $directory 'result.json' ([byte[]]@(123)) $sid
      $hash=(Get-FileHash -LiteralPath (Join-Path $directory 'result.json')).Hash
     }
     if($Case -ceq 'result-acl-failure'){
      $a=[IO.Directory]::GetAccessControl($directory,[Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));[IO.Directory]::SetAccessControl($directory,$a)
     }
     Save-NativeResult $report $directory $sid
     if($Case -ceq 'result'){
      $retained=Get-Content -LiteralPath (Join-Path $directory 'result.json') -Raw|ConvertFrom-Json
      Assert-Test ($retained.failure.reason -ceq 'ORIGINAL_FAILURE');Assert-EvidenceAcl (Join-Path $directory 'result.json') $sid
     }else{
      Assert-Test ($report.status -ceq 'FAIL_OR_BLOCKED' -and $report.failure.stage -ceq 'RESULT_PERSISTENCE' -and $report.failure.reason -ceq 'RESULT_PERSISTENCE_FAILED' -and $report.original_failure.reason -ceq 'ORIGINAL_FAILURE')
      if($Case -ceq 'result-failure'){Assert-Test ((Get-FileHash -LiteralPath (Join-Path $directory 'result.json')).Hash -ceq $hash)}
      else{Assert-Test ($report.failure.evidence_reason -ceq 'EVIDENCE_ACL_REJECTED');Assert-Test (-not(Test-Path -LiteralPath (Join-Path $directory 'result.json')))}
     }
    }
   }
  }
 }
}finally{
 if($held){$held.Dispose()}
 if($link -and (Test-Path -LiteralPath $link)){
  $item=Get-Item -LiteralPath $link -Force
  if($item.FullName -ine (Join-Path $root 'junction') -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){throw 'junction cleanup identity'}
  [IO.Directory]::Delete($link)
 }
 if(Test-Path -LiteralPath $root){
  Assert-EvidencePath $root
  if((Split-Path -Parent $root).TrimEnd('\') -ine $fixtureParent -or (Split-Path -Leaf $root) -cnotmatch '^darkpool-evidence-test-[a-f0-9]{32}$'){throw 'cleanup identity'}
  function Assert-TestTree([string]$At){Assert-EvidencePath $At;foreach($child in Get-ChildItem -LiteralPath $At -Force){Assert-EvidencePath $child.FullName;if($child.PSIsContainer){Assert-TestTree $child.FullName}}}
  Assert-TestTree $root;Remove-Item -LiteralPath $root -Recurse -Force
 }
}
[ordered]@{status='PASS';case=$Case;cleanup_confirmed=(-not(Test-Path -LiteralPath $root));accounts_created=0;persistent_creation='DISABLED'}|ConvertTo-Json -Compress

# OFFLINE ONLY: exercises the real private artifact writer with synthetic objects.
# No application command, credential, database or process launcher is used.
param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference='Stop'
$taskRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskArtifacts=[IO.Path]::GetFullPath((Join-Path $taskRepo $ArtifactDirectory))
$taskPrefix=Join-Path $taskRepo '.tools/phase9-focused/'
if(-not $taskArtifacts.StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $taskArtifacts)){throw 'Fresh offline artifact directory required'}
[IO.Directory]::CreateDirectory($taskArtifacts)|Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'phase9-focused-native-v1.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
# Typed bridge avoids PowerShell PSObject wrappers in reflection argument arrays.
Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class FocusedArtifactProbeV1 {
    public static JavaScriptSerializer Serializer(Type type,string name) {
        return (JavaScriptSerializer)type.GetField(name,BindingFlags.Static|BindingFlags.NonPublic).GetValue(null);
    }
    public static void Write(Type type,string path,object value) {
        type.GetMethod("Write",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{path,value});
    }
    public static object Payload(int length) {
        return new Dictionary<string,object>{{"evidence_class","offline-synthetic-serialization-only"},
            {"payload",new string('x',length)},{"creation_filetime","134368991372484421"},{"unicode","\u03bb\u6c34"}};
    }
    public static object Cycle() { var value=new Dictionary<string,object>(); value.Add("cycle",value); return value; }
}
'@ -ReferencedAssemblies System.Web.Extensions,System.Core
$taskChecks=@()
function Assert-Artifact([bool]$value,[string]$name){$script:taskChecks+=@{name=$name;passed=$value};if(-not $value){throw "Offline assertion failed: $name"}}
function Write-Probe([string]$path,[object]$value){[FocusedArtifactProbeV1]::Write([FocusedNativeV1],$path,$value)}
$taskOutput=[FocusedArtifactProbeV1]::Serializer([FocusedNativeV1],'EvidenceJson')
$taskInput=[FocusedArtifactProbeV1]::Serializer([FocusedNativeV1],'Json')
Assert-Artifact ($taskOutput.MaxJsonLength -eq 67108864) 'explicit finite 64 Mi-character evidence budget'
Assert-Artifact ($taskInput.MaxJsonLength -eq 2097152) 'manifest input serializer unchanged'
$taskLarge=Join-Path $taskArtifacts 'large-synthetic.json'
Write-Probe $taskLarge ([FocusedArtifactProbeV1]::Payload(2097152))
$taskBytes=[IO.File]::ReadAllBytes($taskLarge)
$taskText=[Text.Encoding]::UTF8.GetString($taskBytes)
$taskDecoded=$taskOutput.DeserializeObject($taskText)
Assert-Artifact ($taskText.Length -gt 2097152) 'payload exceeds original failing serializer ceiling'
Assert-Artifact ($taskDecoded['payload'].Length -eq 2097152) 'large payload retained without truncation'
Assert-Artifact ($taskDecoded['creation_filetime'] -ceq '134368991372484421') 'native precision string retained exactly'
Assert-Artifact ($taskDecoded['unicode'] -ceq ([string][char]0x03bb+[char]0x6c34)) 'UTF8 round trip'
Assert-Artifact (-not ($taskBytes[0] -eq 239 -and $taskBytes[1] -eq 187 -and $taskBytes[2] -eq 191)) 'artifact has no BOM'
$taskRejected=$false
try {Write-Probe $taskLarge ([FocusedArtifactProbeV1]::Payload(1))}catch{$taskRejected=$_.Exception.GetBaseException() -is [IO.IOException]}
Assert-Artifact $taskRejected 'duplicate destination rejected by exclusive creation'
Assert-Artifact ([Convert]::ToBase64String([IO.File]::ReadAllBytes($taskLarge)) -ceq [Convert]::ToBase64String($taskBytes)) 'historical destination bytes never overwritten'
$taskFailure=Join-Path $taskArtifacts 'over-budget.json'
$taskLimit=$taskOutput.MaxJsonLength
try {
    # Offline object-only fault injection; production limit is restored in finally.
    $taskOutput.MaxJsonLength=1024
    $taskRejected=$false
    try {Write-Probe $taskFailure ([FocusedArtifactProbeV1]::Payload(2048))}catch{$taskRejected=$_.Exception.GetBaseException().Message -match 'maxJsonLength'}
    Assert-Artifact $taskRejected 'serialization limit still fails closed'
    Assert-Artifact (-not [IO.File]::Exists($taskFailure)) 'serialization failure leaves no empty trace placeholder'
}finally{$taskOutput.MaxJsonLength=$taskLimit}
Assert-Artifact ($taskOutput.MaxJsonLength -eq 67108864) 'offline limit fault restored'
$taskCycle=Join-Path $taskArtifacts 'malformed-cycle.json'
$taskRejected=$false
try {Write-Probe $taskCycle ([FocusedArtifactProbeV1]::Cycle())}catch{$taskRejected=$true}
Assert-Artifact $taskRejected 'cyclic unserializable evidence rejected'
Assert-Artifact (-not [IO.File]::Exists($taskCycle)) 'malformed object creates no success artifact'
$taskInvalid=Join-Path $taskArtifacts 'absent-parent/native-trace.json'
$taskRejected=$false
try {Write-Probe $taskInvalid ([FocusedArtifactProbeV1]::Payload(1))}catch{$taskRejected=$_.Exception.GetBaseException() -is [IO.DirectoryNotFoundException]}
Assert-Artifact $taskRejected 'invalid artifact parent fails rather than redirects'
Assert-Artifact (-not [IO.File]::Exists((Join-Path $taskArtifacts 'native-trace.json'))) 'no fabricated native trace'
$taskSummary=@{evidence_class='offline-synthetic-serialization-only';checks=$taskChecks.Count;passed=@($taskChecks|Where-Object {$_.passed}).Count;application_commands=0;assertions=$taskChecks}
$taskFile=[IO.File]::Open((Join-Path $taskArtifacts 'summary.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try {$taskSummaryBytes=[Text.Encoding]::UTF8.GetBytes(($taskSummary|ConvertTo-Json -Depth 6));$taskFile.Write($taskSummaryBytes,0,$taskSummaryBytes.Length);$taskFile.Flush($true)}finally{$taskFile.Dispose()}
@{checks=$taskSummary.checks;passed=$taskSummary.passed;application_commands=0}|ConvertTo-Json

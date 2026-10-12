[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Pester 3.4 ships with Windows PowerShell on the supported workstation. Its
# command metric supplements, and cannot represent, the four npm suite metrics.
$pester=Get-Module -ListAvailable Pester | Where-Object {$_.Version -eq [version]'3.4.0'} | Select-Object -First 1
if(-not $pester){Write-Output 'PowerShell command coverage unmeasured: bundled Pester 3.4.0 is unavailable.';return}
Import-Module $pester.Path -Force
$runtimeNames=@('outlook-automation.ps1','outlook-com-export.ps1','outlook-mailbox-cleanup.ps1','outlook-private-runtime.psm1','register-outlook-automation-task.ps1')
$runtimePaths=@($runtimeNames|ForEach-Object{Join-Path $PSScriptRoot $_})
$harnessNames=@('test-outlook-behavior.ps1','test-outlook-run-lifecycle.ps1','test-outlook-cleanup.ps1','test-outlook-collector.ps1','test-outlook-registration.ps1','test-outlook-restore-state.ps1')
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('jsi-synthetic-coverage-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch)|Out-Null
$wrapper=Join-Path $scratch 'Outlook.Tests.ps1'
$lines=[Collections.Generic.List[string]]::new();$lines.Add("Describe 'Synthetic Outlook command coverage' {")
foreach($name in $harnessNames){$path=(Join-Path $PSScriptRoot $name).Replace("'","''");$lines.Add(" It '$name' { & '$path' }")}
$lines.Add('}')
[IO.File]::WriteAllLines($wrapper,$lines,[Text.UTF8Encoding]::new($false))
try{
  $result=Invoke-Pester -Script $wrapper -CodeCoverage $runtimePaths -PassThru -Quiet
  $result=@($result|Where-Object{$_.PSObject.Properties['CodeCoverage']})[-1]
  if($result.FailedCount -gt 0){throw 'Synthetic PowerShell coverage harness failed.'}
  $coverage=$result.CodeCoverage
  $failed=[Collections.Generic.List[string]]::new()
  foreach($path in $runtimePaths){
    $executed=@($coverage.HitCommands|Where-Object{$_.File -eq $path}).Count
    $missed=@($coverage.MissedCommands|Where-Object{$_.File -eq $path}).Count
    $total=$executed+$missed
    $percent=if($total){100.0*$executed/$total}else{0}
    Write-Output ('{0}: {1}/{2} commands ({3:N2}%)' -f [IO.Path]::GetFileName($path),$executed,$total,$percent)
    if($total -eq 0 -or $percent -lt 85){$failed.Add([IO.Path]::GetFileName($path))}
  }
  if($failed.Count){throw ('PowerShell command coverage below 85%: '+($failed -join ', '))}
}finally{
  # Only this generated synthetic-test wrapper is removed; no recursive deletion.
  if([IO.File]::Exists($wrapper)){[IO.File]::Delete($wrapper)}
  if([IO.Directory]::Exists($scratch)){[IO.Directory]::Delete($scratch,$false)}
}

[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Assert-InstalledState([bool]$Condition,[string]$Name){if(-not $Condition){throw "Installed uploader state regression failed: $Name"}}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('jsi-installed-state-'+[guid]::NewGuid().ToString('N'))
$privateRoot=Join-Path $testRoot 'private-state'
$bin=Join-Path $privateRoot 'bin'
$sourceRoot=Join-Path $testRoot 'source-fixtures'
[IO.Directory]::CreateDirectory($bin)|Out-Null
[IO.Directory]::CreateDirectory($sourceRoot)|Out-Null
$engines=[Collections.Generic.List[string]]::new()
if($PSVersionTable.PSEdition -eq 'Core'){$engines.Add([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)}
elseif($env:SystemRoot){$engines.Add((Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'))}
if($env:SystemRoot){$windowsPowerShell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe';if((Test-Path -LiteralPath $windowsPowerShell) -and -not $engines.Contains($windowsPowerShell)){$engines.Add($windowsPowerShell)}}
try{
  foreach($name in 'outlook-automation.ps1','outlook-private-runtime.psm1','outlook-com-export.ps1','outlook-mailbox-cleanup.ps1'){
    $source=Join-Path $PSScriptRoot $name;$copy=Join-Path $bin $name
    Copy-Item -LiteralPath $source -Destination $copy
    Assert-InstalledState ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) "installed fixture is byte-identical: $name"
  }
  if($env:OS -eq 'Windows_NT'){
    $runtime=Join-Path $bin 'outlook-private-runtime.psm1'
    Import-Module $runtime -Force
    $context=New-PrivateRuntimeContext -StateRoot $privateRoot -Environment 'synthetic-installed-state' -MailboxBinding 'owner@example.invalid' -ConfigVersion 'test-v1'
    Set-MaintenanceGate -Context $context -Enabled $true -Reason 'synthetic installation test'
  }else{
    [IO.File]::WriteAllText((Join-Path $privateRoot 'maintenance-gate.invalid'),'synthetic fail-closed gate')
    Write-Output 'Using a synthetic invalid-gate sentinel outside Windows; no environment simulation or DPAPI substitution.'
  }
  foreach($engine in $engines){
      Assert-InstalledState (Test-Path -LiteralPath $engine -PathType Leaf) "supported PowerShell engine exists: $engine"
      $automation=Join-Path $bin 'outlook-automation.ps1'
      $childArguments=@('-NoProfile','-NonInteractive')
      if($env:OS -eq 'Windows_NT'){$childArguments+=@('-ExecutionPolicy','Bypass')}
      $childArguments+=@('-File',$automation,'-Mailbox','owner@example.invalid','-ApiBase','https://jobs-api.example.invalid/api/job-intelligence','-StateDirectory',$privateRoot)
      $savedModulePath=$env:PSModulePath
      if($PSVersionTable.PSEdition -eq 'Core' -and [IO.Path]::GetFileName($engine) -ieq 'powershell.exe'){$env:PSModulePath=$null}
      try{$output=& $engine @childArguments 2>&1;$exitCode=$LASTEXITCODE}finally{$env:PSModulePath=$savedModulePath}
      Assert-InstalledState ($exitCode -eq 0) "installed-layout exact -File launch succeeds before protected gate: $($output -join ' ')"
      $outputText=$output -join "`n"
      Assert-InstalledState ($outputText -match 'maintenance_gate_enabled' -and $outputText -notmatch '(?i)start |call=|coverage=|credential|export=') "gate exits before credential, API, or Outlook work ($engine)"
      $logFiles=@(Get-ChildItem -LiteralPath (Join-Path $privateRoot 'logs') -Filter '*.log' -ErrorAction SilentlyContinue)
      $logText=($logFiles|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw}) -join "`n"
      Assert-InstalledState ($logText -match 'result=maintenance_gate_enabled exit=0') "durable synthetic gate pauses installed launch ($engine)"
      foreach($forbidden in 'automation-credential.xml','upload-queue.dpapi','state.json','collection-state.dpapi') { Assert-InstalledState (-not (Test-Path -LiteralPath (Join-Path $privateRoot $forbidden))) "gate path does not access/create $forbidden ($engine)" }
      if($env:OS -eq 'Windows_NT'){Assert-InstalledState (Test-MaintenanceGate -Context $context) "installed launch preserves the synthetic gate ($engine)"}
      Write-Output "Installed -File gate launch passed: $engine"
  }

  $repoCases=[Collections.Generic.List[object]]::new()
  $gitDirectory=Join-Path $sourceRoot 'git-directory';[IO.Directory]::CreateDirectory((Join-Path $gitDirectory '.git'))|Out-Null
  $repoCases.Add(@{Name='git directory';Root=$gitDirectory})
  $worktree=Join-Path $sourceRoot 'worktree-file';[IO.Directory]::CreateDirectory($worktree)|Out-Null;[IO.File]::WriteAllText((Join-Path $worktree '.git'),'gitdir: C:\synthetic\worktrees\fixture')
  $repoCases.Add(@{Name='worktree .git file';Root=$worktree})
  $appSource=Join-Path $sourceRoot 'source-markers';foreach($path in 'scripts','app/frontend','app/backend'){[IO.Directory]::CreateDirectory((Join-Path $appSource $path))|Out-Null};[IO.File]::WriteAllText((Join-Path $appSource 'package.json'),'{}');[IO.File]::WriteAllText((Join-Path $appSource 'scripts/outlook-automation.ps1'),'')
  $repoCases.Add(@{Name='source markers without Git';Root=$appSource})
  foreach($case in $repoCases){
    $scriptPath=Join-Path $case.Root 'scripts/outlook-automation.ps1'
    if($case.Name -ne 'source markers without Git'){[IO.Directory]::CreateDirectory((Split-Path -Parent $scriptPath))|Out-Null}
    Copy-Item -LiteralPath (Join-Path $bin 'outlook-automation.ps1') -Destination $scriptPath
    foreach($statePath in @($case.Root,(Join-Path $case.Root 'private-child'))){
      $rejected=$false
      try{. $scriptPath -LibraryOnly -StateDirectory $statePath;Initialize-State}catch{$rejected=$_.Exception.Message -match 'outside the repository'}
      Assert-InstalledState $rejected "state root or descendant inside $($case.Name) is rejected"
      if(-not [IO.Path]::GetFullPath($statePath).Equals([IO.Path]::GetFullPath($case.Root),[StringComparison]::OrdinalIgnoreCase)){Assert-InstalledState (-not (Test-Path -LiteralPath $statePath)) "repository rejection precedes state directory creation ($($case.Name))"}
    }
  }
  $privateScript=Join-Path $bin 'outlook-automation.ps1'
  $repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  foreach($statePath in @($repoRoot,(Join-Path $repoRoot ('.synthetic-private-state-test-'+[guid]::NewGuid().ToString('N'))))){
    $rejected=$false
    try{. (Join-Path $PSScriptRoot 'outlook-automation.ps1') -LibraryOnly -StateDirectory $statePath;Initialize-State}catch{$rejected=$_.Exception.Message -match 'outside the repository'}
    Assert-InstalledState $rejected 'actual repository root and descendant are rejected without creating state'
    if(-not $statePath.Equals($repoRoot,[StringComparison]::OrdinalIgnoreCase)){Assert-InstalledState (-not (Test-Path -LiteralPath $statePath)) 'actual repository descendant is rejected before state directory creation'}
    $installedRejected=$false
    try{. $privateScript -LibraryOnly -StateDirectory $statePath;Initialize-State}catch{$installedRejected=$_.Exception.Message -match 'outside the repository'}
    Assert-InstalledState $installedRejected 'installed script rejects state at or below a Git repository before creating state'
  }
  . $privateScript -LibraryOnly -StateDirectory $privateRoot
  Initialize-State
  Write-Output 'Synthetic installed-layout state boundary tests passed.'
}finally{
  Remove-Module outlook-private-runtime -ErrorAction SilentlyContinue
  $tempPrefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  $resolvedTestRoot=[IO.Path]::GetFullPath($testRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  if($resolvedTestRoot.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTestRoot)){Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force}
}

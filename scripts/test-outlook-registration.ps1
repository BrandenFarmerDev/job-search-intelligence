[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:FakeTask=$null
$script:LastRegisteredXml=$null
$script:FailInstallCopy=$false
$script:FailInstallCopyAfter=0
$script:InstallCopyCount=0
$script:FailInstallMoveAfter=0
$script:InstallMoveCount=0
$script:FailTaskRegistration=$false
$script:CapturedTaskStateAtExport=$null
$script:ConstructorCalls=[Collections.Generic.List[string]]::new()
$script:TestMutexName='Local\JSI-OutlookRegistration-'+[guid]::NewGuid().ToString('N')
$script:CurrentGateContext=$null
$script:GateObservedDuringCopy=$false
$script:TestProtect={param([byte[]]$Bytes,[byte[]]$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))}
$script:TestUnprotect={param([byte[]]$Bytes,[byte[]]$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
function New-PrivateRuntimeContext {
  param([string]$StateRoot,[string]$Environment,[string]$MailboxBinding,[string]$ConfigVersion,[scriptblock]$ProtectBytes,[scriptblock]$UnprotectBytes)
  $moduleArgs=@{StateRoot=$StateRoot;Environment=$Environment;MailboxBinding=$MailboxBinding;ConfigVersion=$ConfigVersion;ProtectBytes=$script:TestProtect;UnprotectBytes=$script:TestUnprotect}
  return outlook-private-runtime\New-PrivateRuntimeContext @moduleArgs
}
$script:FixtureContextConstructor=${function:New-PrivateRuntimeContext}.GetNewClosure()
function Import-Module {
  param([Parameter(Position=0)][string]$Name,[switch]$Force)
  Microsoft.PowerShell.Core\Import-Module -Name $Name -Force:$Force
  if([IO.Path]::GetFileName($Name) -eq 'outlook-private-runtime.psm1'){
    # Importing the module re-exports its native constructor into this script
    # scope. Restore the captured synthetic constructor for later fixtures.
    Set-Item -Path Function:script:New-PrivateRuntimeContext -Value $script:FixtureContextConstructor
  }
}
function Get-ScheduledTask { param([string]$TaskName,[object]$ErrorAction) return $script:FakeTask }
function Enable-ScheduledTask { param([string]$TaskName) $script:FakeTask.State='Ready';return $script:FakeTask }
function Disable-ScheduledTask { param([string]$TaskName) $script:FakeTask.State='Disabled';return $script:FakeTask }
function Export-ScheduledTask { param([string]$TaskName,[object]$ErrorAction) $script:CapturedTaskStateAtExport=[string]$script:FakeTask.State;return '<Task>fixture previous definition</Task>' }
function Copy-Item { param([string]$LiteralPath,[string]$Destination,[switch]$Force) $script:InstallCopyCount++;if($script:FailInstallCopy -and $script:InstallCopyCount -ge [Math]::Max(1,$script:FailInstallCopyAfter)){$script:GateObservedDuringCopy=Test-MaintenanceGate $script:CurrentGateContext;throw 'synthetic staged install copy failure'};Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force }
function Move-Item { param([string]$LiteralPath,[string]$Destination,[switch]$Force) $script:InstallMoveCount++;if($script:FailInstallMoveAfter -gt 0 -and $script:InstallMoveCount -ge $script:FailInstallMoveAfter){$script:GateObservedDuringCopy=Test-MaintenanceGate $script:CurrentGateContext;throw 'synthetic mid-install replace failure'};Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force }
function Register-ScheduledTask { param([string]$TaskName,[string]$Xml,[switch]$Force,[object]$Action,[object]$Trigger,[object]$Settings,[object]$Principal,[string]$Description)
  if($script:FailTaskRegistration -and -not $PSBoundParameters.ContainsKey('Xml')){throw 'synthetic scheduler registration failure'}
  if($PSBoundParameters.ContainsKey('Xml')){$script:LastRegisteredXml=$Xml}
  $script:FakeTask=[pscustomobject]@{State='Disabled';Actions=@()};return $script:FakeTask
}
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,[string]$User,[switch]$Daily,[string]$At) $script:ConstructorCalls.Add('Trigger')|Out-Null;return [pscustomobject]@{Delay=''} }
function New-ScheduledTaskAction { param([string]$Execute,[string]$Argument) $script:ConstructorCalls.Add('Action')|Out-Null;return [pscustomobject]@{Execute=$Execute;Argument=$Argument} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,[string]$MultipleInstances,[TimeSpan]$ExecutionTimeLimit,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) $script:ConstructorCalls.Add('Settings')|Out-Null;return [pscustomobject]@{MultipleInstances=$MultipleInstances} }
function New-ScheduledTaskPrincipal { param([string]$UserId,[string]$LogonType,[string]$RunLevel) $script:ConstructorCalls.Add('Principal')|Out-Null;return [pscustomobject]@{UserId=$UserId} }
function Unregister-ScheduledTask { param([string]$TaskName,[switch]$Confirm) $script:FakeTask=$null }
function Assert-Registration([bool]$Value,[string]$Name){if(-not $Value){throw "Registration behavior failed: $Name"}}
function Get-Digest([string]$Path){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function New-Fixture([string]$Root,[string]$PriorTaskState='Disabled'){
  [IO.Directory]::CreateDirectory($Root)|Out-Null
  $mailbox='owner@example.invalid';$taskName='JobSearchIntelligence-OutlookUpload'
  $sha=[Security.Cryptography.SHA256]::Create();try{$bindingBytes=$sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($mailbox+'|'+$taskName)));$binding=([BitConverter]::ToString($bindingBytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  $context=New-PrivateRuntimeContext -StateRoot $Root -Environment 'outlook-registration' -MailboxBinding $binding -ConfigVersion registration-v1
  if(-not $context.ProtectBytes -or -not $context.UnprotectBytes){throw 'Registration fixture context is missing injected synthetic protection callbacks.'}
  $gate=New-MaintenanceGateContext $context;$bin=Join-Path $Root 'bin';Protect-PrivateDirectory $bin
  $names=@('outlook-automation.ps1','outlook-com-export.ps1','outlook-private-runtime.psm1');$hashes=[ordered]@{}
  foreach($name in $names){$path=Join-Path $bin $name;[IO.File]::WriteAllText($path,"current-$name");$hashes[$name]=Get-Digest $path}
  Save-ProtectedJsonAtomic -Path (Join-Path $Root 'registration-installed.dpapi') -Value ([ordered]@{schemaVersion=1;mailbox=$mailbox;installedAt=[DateTime]::UtcNow.ToString('o');fileHashes=$hashes}) -Context $context
  $record=[ordered]@{schemaVersion=1;approvalHash='approved-fixture-hash';taskName=$taskName;mailbox=$mailbox;previousTaskState=$PriorTaskState;previousTaskXml='<Task>fixture prior definition</Task>';previousFiles=[ordered]@{};backupRoot=(Join-Path $Root 'registration-backups');capturedAt=[DateTime]::UtcNow.ToString('o')}
  Protect-PrivateDirectory $record.backupRoot
  foreach($name in $names){$old=[Text.Encoding]::UTF8.GetBytes("prior-$name");$backup=Join-Path $record.backupRoot ($name+'.dpapi');Save-ProtectedBytesAtomic -Path $backup -Bytes $old -Context $context;$sha=[Security.Cryptography.SHA256]::Create();try{$oldHash=([BitConverter]::ToString($sha.ComputeHash($old))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};$record.previousFiles[$name]=[ordered]@{backupPath=$backup;sha256=$oldHash;bytes=$old.Length}}
  Save-ProtectedJsonAtomic -Path (Join-Path $Root 'registration-maintenance.dpapi') -Value $record -Context $context
  Set-MaintenanceGate -Context $gate -Enabled $true -Reason synthetic
  $script:FakeTask=[pscustomobject]@{State=$PriorTaskState;Actions=@()}
  return [pscustomobject]@{Root=$Root;Mailbox=$mailbox;Context=$context;Gate=$gate;Bin=$bin;Names=$names;Record=$record}
}

Set-PrivateRuntimeMutexFactory ({param($Name)[Threading.Mutex]::new($false,$script:TestMutexName)}.GetNewClosure())
$registration=Join-Path $PSScriptRoot 'register-outlook-automation-task.ps1'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('jsi-registration-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot)|Out-Null
try {
  # A busy uploader/cleanup mutex prevents completion. The durable gate and
  # disabled task remain in place, so no overlapping phase is admitted.
  $busy=New-Fixture (Join-Path $testRoot 'busy')
  $signal=Join-Path $testRoot 'mutex-held.signal';$releaseSignal=Join-Path $testRoot 'mutex-release.signal'
  $job=Start-Job -ArgumentList $signal,$releaseSignal,$script:TestMutexName -ScriptBlock {param($signalPath,$releasePath,$mutexName)$mutex=[Threading.Mutex]::new($false,$mutexName);try{[void]$mutex.WaitOne();[IO.File]::WriteAllText($signalPath,'held');$deadline=[DateTime]::UtcNow.AddSeconds(60);while(-not(Test-Path -LiteralPath $releasePath) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}}finally{try{$mutex.ReleaseMutex()}catch{};$mutex.Dispose()}}
  $waitUntil=[DateTime]::UtcNow.AddSeconds(15);while(-not (Test-Path -LiteralPath $signal) -and [DateTime]::UtcNow -lt $waitUntil){Start-Sleep -Milliseconds 100}
  Assert-Registration (Test-Path -LiteralPath $signal) 'mutex holder started'
  $busyError='';try{. $registration -Mailbox $busy.Mailbox -StateDirectory $busy.Root -CompleteMaintenance -MaintenanceApprovalHash $busy.Record.approvalHash}catch{$busyError=[string]$_.Exception.Message}
  Assert-Registration ($busyError -eq 'Maintenance completion requires the shared mutex to be free.') 'completion refuses a held shared mutex for the expected mutex contention reason'
  Assert-Registration (Test-MaintenanceGate $busy.Gate) 'busy completion preserves durable gate'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'busy completion leaves task disabled'
  [IO.File]::WriteAllText($releaseSignal,'release')
  Wait-Job $job|Out-Null;Remove-Job $job -Force

  # Installed unit tampering fails closed under the acquired mutex.
  $bad=New-Fixture (Join-Path $testRoot 'tampered')
  [IO.File]::WriteAllText((Join-Path $bad.Bin $bad.Names[0]),'tampered installed file')
  $badRejected=$false;try{. $registration -Mailbox $bad.Mailbox -StateDirectory $bad.Root -CompleteMaintenance -MaintenanceApprovalHash $bad.Record.approvalHash}catch{$badRejected=$true}
  Assert-Registration $badRejected 'completion rejects installed hash mismatch'
  Assert-Registration (Test-MaintenanceGate $bad.Gate) 'failed verification keeps maintenance gate set'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'failed verification leaves task disabled'

  # Completing a prior Disabled task never enables it implicitly. Enabling is
  # only possible with a new, explicit -Enable request during completion.
  $disabled=New-Fixture (Join-Path $testRoot 'disabled')
  . $registration -Mailbox $disabled.Mailbox -StateDirectory $disabled.Root -CompleteMaintenance -MaintenanceApprovalHash $disabled.Record.approvalHash
  Assert-Registration (-not (Test-MaintenanceGate $disabled.Gate)) 'accepted completion clears durable gate'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'prior disabled task remains disabled by default'
  $enabled=New-Fixture (Join-Path $testRoot 'explicit-enable')
  . $registration -Mailbox $enabled.Mailbox -StateDirectory $enabled.Root -CompleteMaintenance -MaintenanceApprovalHash $enabled.Record.approvalHash -Enable
  Assert-Registration ($script:FakeTask.State -eq 'Ready') 'explicit enable is applied only after accepted completion'

  $statusFixture=New-Fixture (Join-Path $testRoot 'status')
  $statusResult=. $registration -Mailbox $statusFixture.Mailbox -StateDirectory $statusFixture.Root -ShowMaintenanceStatus
  Assert-Registration ($statusResult.ApprovalHash -eq $statusFixture.Record.approvalHash) 'maintenance status reports the protected approval hash'
  Assert-Registration ($statusResult.MaintenanceGate -eq $true -and $statusResult.CurrentTaskState -eq 'Disabled') 'maintenance status reports gate and disabled task state'
  $unregister=New-Fixture (Join-Path $testRoot 'unregister')
  . $registration -Unregister -StateDirectory $unregister.Root
  Assert-Registration ($null -eq $script:FakeTask) 'unregister removes only the disabled scheduled task'

  # Rollback verifies protected prior bytes, restores the prior task definition
  # in disabled state, and leaves the gate set for another acceptance phase.
  $rollback=New-Fixture (Join-Path $testRoot 'rollback')
  . $registration -Mailbox $rollback.Mailbox -StateDirectory $rollback.Root -RollbackMaintenance -MaintenanceApprovalHash $rollback.Record.approvalHash
  foreach($name in $rollback.Names){Assert-Registration ([IO.File]::ReadAllText((Join-Path $rollback.Bin $name)) -eq "prior-$name") "rollback restores prior bytes for $name"}
  Assert-Registration ($script:LastRegisteredXml -eq '<Task>fixture prior definition</Task>') 'rollback restores snapshotted task definition'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'rollback restores task only in disabled state'
  Assert-Registration (Test-MaintenanceGate $rollback.Gate) 'rollback retains maintenance gate'

  $corrupt=New-Fixture (Join-Path $testRoot 'corrupt-backup')
  $firstBackup=[string]$corrupt.Record.previousFiles[$corrupt.Names[0]].backupPath
  [IO.File]::WriteAllBytes($firstBackup,[byte[]](1,2,3))
  $corruptRejected=$false;try{. $registration -Mailbox $corrupt.Mailbox -StateDirectory $corrupt.Root -RollbackMaintenance -MaintenanceApprovalHash $corrupt.Record.approvalHash}catch{$corruptRejected=$true}
  Assert-Registration $corruptRejected 'rollback rejects a corrupt DPAPI prior-file backup'
  Assert-Registration (Test-MaintenanceGate $corrupt.Gate) 'invalid backup leaves maintenance gate set'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'invalid backup leaves task disabled'

  # The gate is already durable at the first staged-file mutation, and a
  # failed mutation leaves both gate and disabled task in place.
  $failedInstall=New-Fixture (Join-Path $testRoot 'install-failure')
  Set-MaintenanceGate -Context $failedInstall.Gate -Enabled $false -Reason synthetic_preinstall
  $script:CurrentGateContext=$failedInstall.Gate;$script:GateObservedDuringCopy=$false;$script:FailInstallCopy=$true;$script:FailInstallCopyAfter=1;$script:InstallCopyCount=0
  $installRejected=$false;try{. $registration -Mailbox $failedInstall.Mailbox -StateDirectory $failedInstall.Root}catch{$installRejected=$true}
  $script:FailInstallCopy=$false
  Assert-Registration $installRejected 'synthetic installation mutation failure is surfaced'
  Assert-Registration $script:GateObservedDuringCopy 'gate is set before the first installed-file mutation'
  Assert-Registration (Test-MaintenanceGate $failedInstall.Gate) 'failed install keeps maintenance gate set'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'failed install leaves task disabled'

  # Exercise the complete install path with all Task Scheduler constructors
  # replaced by deterministic in-process fixtures. Snapshot state is captured
  # before disabling, and the new task stays disabled behind the gate.
  $install=New-Fixture (Join-Path $testRoot 'happy-install') 'Ready'
  Set-MaintenanceGate -Context $install.Gate -Enabled $false -Reason synthetic_preinstall
  $script:ConstructorCalls.Clear();$script:CapturedTaskStateAtExport=$null;$script:FailTaskRegistration=$false
  . $registration -Mailbox $install.Mailbox -StateDirectory $install.Root
  Assert-Registration ($script:CapturedTaskStateAtExport -eq 'Ready') 'prior task state is captured before task disable'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'successful registration leaves the task disabled'
  Assert-Registration (Test-MaintenanceGate $install.Gate) 'successful registration retains acceptance gate'
  foreach($constructor in @('Trigger','Action','Settings','Principal')){Assert-Registration ($script:ConstructorCalls.Contains($constructor)) "install constructs scheduled task $constructor"}
  $installedManifest=Read-ProtectedJson -Path (Join-Path $install.Root 'registration-installed.dpapi') -Context $install.Context
  foreach($name in $install.Names){Assert-Registration ([string]$installedManifest.fileHashes.$name -eq (Get-Digest (Join-Path $install.Bin $name))) "installed digest recorded for $name"}

  # Fail after the staged copy has succeeded and the first installed file has
  # been replaced. Rollback must restore every prior byte and task definition.
  $midCopy=New-Fixture (Join-Path $testRoot 'mid-copy-failure') 'Ready'
  Set-MaintenanceGate -Context $midCopy.Gate -Enabled $false -Reason synthetic_preinstall
  $script:FailInstallCopy=$false;$script:InstallMoveCount=0;$script:FailInstallMoveAfter=2;$script:CurrentGateContext=$midCopy.Gate;$script:GateObservedDuringCopy=$false
  $midRejected=$false;try{. $registration -Mailbox $midCopy.Mailbox -StateDirectory $midCopy.Root}catch{$midRejected=$true}
  $script:FailInstallMoveAfter=0
  Assert-Registration $midRejected 'mid-copy failure is surfaced'
  Assert-Registration (Test-MaintenanceGate $midCopy.Gate) 'mid-copy failure keeps gate set'
  $midRecord=Read-ProtectedJson -Path (Join-Path $midCopy.Root 'registration-maintenance.dpapi') -Context $midCopy.Context
  . $registration -Mailbox $midCopy.Mailbox -StateDirectory $midCopy.Root -RollbackMaintenance -MaintenanceApprovalHash $midRecord.approvalHash
  foreach($name in $midCopy.Names){Assert-Registration ([IO.File]::ReadAllText((Join-Path $midCopy.Bin $name)) -eq "current-$name") "mid-copy rollback restores $name"}
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'mid-copy rollback restores task disabled'

  # Scheduler registration failure occurs after all new files are installed;
  # the protected snapshot still permits an exact rollback.
  $schedulerFailure=New-Fixture (Join-Path $testRoot 'scheduler-failure') 'Ready'
  Set-MaintenanceGate -Context $schedulerFailure.Gate -Enabled $false -Reason synthetic_preinstall
  $script:FailTaskRegistration=$true;$schedulerRejected=$false
  try{. $registration -Mailbox $schedulerFailure.Mailbox -StateDirectory $schedulerFailure.Root}catch{$schedulerRejected=$true}
  $script:FailTaskRegistration=$false
  Assert-Registration $schedulerRejected 'scheduler registration failure is surfaced'
  Assert-Registration (Test-MaintenanceGate $schedulerFailure.Gate) 'scheduler failure keeps gate set'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'scheduler failure leaves existing task disabled'
  $schedulerRecord=Read-ProtectedJson -Path (Join-Path $schedulerFailure.Root 'registration-maintenance.dpapi') -Context $schedulerFailure.Context
  . $registration -Mailbox $schedulerFailure.Mailbox -StateDirectory $schedulerFailure.Root -RollbackMaintenance -MaintenanceApprovalHash $schedulerRecord.approvalHash
  foreach($name in $schedulerFailure.Names){Assert-Registration ([IO.File]::ReadAllText((Join-Path $schedulerFailure.Bin $name)) -eq "current-$name") "scheduler-failure rollback restores $name"}

  # A prior first-time install has no task or installed files. Rollback removes
  # only newly created managed files, unregisters the new task, and records the
  # absent state. Missing encrypted backups fail closed before rollback writes.
  $absent=New-Fixture (Join-Path $testRoot 'absent-rollback') 'Absent'
  foreach($name in $absent.Names){Remove-Item -LiteralPath (Join-Path $absent.Bin $name) -Force}
  $script:FakeTask=$null
  $absentRecord=$absent.Record;$absentRecord.previousTaskState='Absent';$absentRecord.previousTaskXml='';$absentRecord.previousFiles=[ordered]@{}
  Save-ProtectedJsonAtomic -Path (Join-Path $absent.Root 'registration-maintenance.dpapi') -Value $absentRecord -Context $absent.Context
  Set-MaintenanceGate -Context $absent.Gate -Enabled $false -Reason synthetic_preinstall
  . $registration -Mailbox $absent.Mailbox -StateDirectory $absent.Root
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'first install creates a disabled task'
  $firstRecord=Read-ProtectedJson -Path (Join-Path $absent.Root 'registration-maintenance.dpapi') -Context $absent.Context
  . $registration -Mailbox $absent.Mailbox -StateDirectory $absent.Root -RollbackMaintenance -MaintenanceApprovalHash $firstRecord.approvalHash
  Assert-Registration ($null -eq $script:FakeTask) 'absent-state rollback unregisters first-time task'
  foreach($name in $absent.Names){Assert-Registration (-not (Test-Path -LiteralPath (Join-Path $absent.Bin $name))) "absent-state rollback removes $name"}
  $firstRecord=Read-ProtectedJson -Path (Join-Path $absent.Root 'registration-maintenance.dpapi') -Context $absent.Context
  . $registration -Mailbox $absent.Mailbox -StateDirectory $absent.Root -CompleteMaintenance -MaintenanceApprovalHash $firstRecord.approvalHash
  Assert-Registration (-not (Test-MaintenanceGate $absent.Gate)) 'absent-state rollback can be accepted under the shared mutex'

  $missing=New-Fixture (Join-Path $testRoot 'missing-backup')
  $missingBackup=[string]$missing.Record.previousFiles[$missing.Names[0]].backupPath
  Remove-Item -LiteralPath $missingBackup -Force
  $missingRejected=$false;try{. $registration -Mailbox $missing.Mailbox -StateDirectory $missing.Root -RollbackMaintenance -MaintenanceApprovalHash $missing.Record.approvalHash}catch{$missingRejected=$true}
  Assert-Registration $missingRejected 'rollback rejects a missing protected old-file backup'
  Assert-Registration (Test-MaintenanceGate $missing.Gate) 'missing backup leaves gate set'
  Assert-Registration ($script:FakeTask.State -eq 'Disabled') 'missing backup leaves task disabled'

  # Unregister runs in a fresh PowerShell process with no module preloaded. Its
  # Import-Module call is observed and injects a per-process mutex name only for
  # the synthetic test, so the production named mutex is never touched.
  $freshRoot=Join-Path $testRoot 'fresh-unregister';[IO.Directory]::CreateDirectory($freshRoot)|Out-Null
  $job=Start-Job -ArgumentList $registration,$freshRoot,('Local\JSI-FreshUnregister-'+[guid]::NewGuid().ToString('N')) -ScriptBlock {
    param($registrationPath,$statePath,$mutexName)
    Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
    $global:FreshFakeTask=[pscustomobject]@{State='Disabled'};$global:FreshModuleImportObserved=$false;$global:FreshUnregistered=$false
    function Get-ScheduledTask {param([string]$TaskName,[object]$ErrorAction)return $global:FreshFakeTask}
    function Unregister-ScheduledTask {param([string]$TaskName,[switch]$Confirm)$global:FreshModuleImportObserved=($null -ne (Get-Module outlook-private-runtime));$global:FreshFakeTask=$null;$global:FreshUnregistered=$true}
    function Import-Module {param([string]$Name,[switch]$Force)Microsoft.PowerShell.Core\Import-Module -Name $Name -Force:$Force;if([IO.Path]::GetFileName($Name) -eq 'outlook-private-runtime.psm1'){outlook-private-runtime\Set-PrivateRuntimeMutexFactory ({param($ignored)[Threading.Mutex]::new($false,$mutexName)}.GetNewClosure())}}
    & $registrationPath -Unregister -StateDirectory $statePath
    [pscustomobject]@{Imported=$global:FreshModuleImportObserved;Unregistered=$global:FreshUnregistered;TaskAbsent=($null -eq $global:FreshFakeTask)}
  }
  $freshResult=Receive-Job -Job $job -Wait -AutoRemoveJob
  Assert-Registration ([bool]$freshResult.Imported) 'fresh unregister imports runtime before mutex use'
  Assert-Registration ([bool]$freshResult.Unregistered -and [bool]$freshResult.TaskAbsent) 'fresh process unregisters only the disabled mock task'
  Write-Output 'Synthetic Outlook registration behavior tests passed.'
} catch {
  [Console]::Error.WriteLine(('Registration harness runtime: PowerShell '+$PSVersionTable.PSVersion+'; '+[Environment]::OSVersion))
  [Console]::Error.WriteLine(('Registration harness failure stack: '+$_.ScriptStackTrace))
  throw
} finally {
  Get-Job -ErrorAction SilentlyContinue|Stop-Job -ErrorAction SilentlyContinue;Get-Job -ErrorAction SilentlyContinue|Remove-Job -Force -ErrorAction SilentlyContinue
  if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse -Force}
}

[CmdletBinding()]
param(
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')][string]$Mailbox,
  [ValidatePattern('^https://[^/\s]+(/\S*)?$')][string]$ApiBase,
  [string]$StateDirectory,
  [ValidateRange(1048576,1073741824)][long]$QueueMaxBytes=268435456,
  [string]$MaintenanceApprovalHash,
  [switch]$Enable,
  [switch]$ShowMaintenanceStatus,
  [switch]$CompleteMaintenance,
  [switch]$RollbackMaintenance,
  [switch]$Unregister
)

# Existing installations are snapshotted before their task is disabled. Refresh
# installs hold the shared mutex and leave the durable gate set until the owner
# explicitly completes maintenance with the emitted exact approval hash.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskName='JobSearchIntelligence-OutlookUpload'
$stateRoot=if($StateDirectory){[IO.Path]::GetFullPath($StateDirectory)}elseif($env:LOCALAPPDATA){Join-Path $env:LOCALAPPDATA 'JobSearchIntelligence'}else{throw 'No state directory is available.'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
if($stateRoot.Equals($repo,[StringComparison]::OrdinalIgnoreCase) -or $stateRoot.StartsWith($repo+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Private Outlook state must be outside the repository.'}
Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1')
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($Unregister){
  if($existing){
    if([string]$existing.State -ne 'Disabled'){throw 'Disable the task and let its current run finish before unregistering.'}
    $unregisterMutex=New-PrivateRuntimeMutex 'Local\JobSearchIntelligenceOutlookUpload';$unregisterHeld=$false
    try{try{$unregisterHeld=$unregisterMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$unregisterHeld=$true};if(-not $unregisterHeld){throw 'The shared uploader/cleanup mutex is active; refusing to unregister.'};Unregister-ScheduledTask -TaskName $taskName -Confirm:$false;Write-Host "Removed scheduled task $taskName. Private state and backups remain in $stateRoot."}
    finally{if($unregisterHeld){try{$unregisterMutex.ReleaseMutex()}catch{}};$unregisterMutex.Dispose()}
  }else{Write-Host "Scheduled task $taskName is not registered."}
  return
}
if(-not $Mailbox){throw 'Mailbox is required.'}

Protect-PrivateDirectory $stateRoot
$bindingSha=[Security.Cryptography.SHA256]::Create()
try {
  $bindingBytes=$bindingSha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Mailbox.Trim().ToLowerInvariant()+'|'+$taskName)))
  $binding=([BitConverter]::ToString($bindingBytes)).Replace('-','').ToLowerInvariant()
} finally {$bindingSha.Dispose()}
$context=New-PrivateRuntimeContext -StateRoot $stateRoot -Environment 'outlook-registration' -MailboxBinding $binding -ConfigVersion 'registration-v1'
$gateContext=New-MaintenanceGateContext $context
$manifestPath=Join-Path $stateRoot 'registration-maintenance.dpapi'
$installedPath=Join-Path $stateRoot 'registration-installed.dpapi'
$bin=Join-Path $stateRoot 'bin'
$names=@('outlook-automation.ps1','outlook-com-export.ps1','outlook-private-runtime.psm1')

function Get-FileDigest([string]$Path) {
  $sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Get-ApprovalDigest([object]$Value) {
  $json=ConvertTo-Json -InputObject $Value -Depth 20 -Compress
  $sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Remove-InstallStage([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path);$prefix=$stateRoot.TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetDirectoryName($full).TrimEnd([IO.Path]::DirectorySeparatorChar) -ne $stateRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) -or [IO.Path]::GetFileName($full) -notmatch '^bin\.stage-[0-9a-f]{32}$'){throw 'Install staging path failed its exact private-root check.'}
  if(Test-Path -LiteralPath $full){$pending=[Collections.Generic.Stack[string]]::new();$pending.Push($full);while($pending.Count){$current=$pending.Pop();$attributes=[IO.File]::GetAttributes($current);if(($attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Install staging tree contains a reparse point.'};if(($attributes -band [IO.FileAttributes]::Directory)-ne 0){foreach($child in [IO.Directory]::GetFileSystemEntries($current)){$pending.Push($child)}}};Remove-Item -LiteralPath $full -Recurse -Force}
}
function Save-PreInstallSnapshot([object]$Task) {
  $backupRoot=Join-Path (Join-Path $stateRoot 'registration-backups') ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N'))
  Protect-PrivateDirectory $backupRoot
  $previousFiles=[ordered]@{}
  foreach($name in $names){$path=Join-Path $bin $name;if(Test-Path -LiteralPath $path){$attributes=[IO.File]::GetAttributes($path);if(($attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0 -or ($attributes -band [IO.FileAttributes]::Directory)-ne 0){throw 'Installed unit file is not a regular file.'};$bytes=[IO.File]::ReadAllBytes($path);$protectedPath=Join-Path $backupRoot ($name+'.dpapi');Save-ProtectedBytesAtomic -Path $protectedPath -Bytes $bytes -Context $context;$previousFiles[$name]=[ordered]@{backupPath=$protectedPath;sha256=(Get-FileDigest $path);bytes=$bytes.Length}}}
  $xml=if($Task){[string](Export-ScheduledTask -TaskName $taskName -ErrorAction Stop)}else{''}
  return [ordered]@{schemaVersion=1;taskName=$taskName;mailbox=$Mailbox.Trim().ToLowerInvariant();previousTaskState=if($Task){[string]$Task.State}else{'Absent'};previousTaskXml=$xml;previousFiles=$previousFiles;backupRoot=$backupRoot;capturedAt=[DateTime]::UtcNow.ToString('o')}
}
function Register-DisabledTask {
  $arguments="-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $bin 'outlook-automation.ps1')`" -Mailbox $Mailbox -StateDirectory `"$stateRoot`" -QueueMaxBytes $QueueMaxBytes"
  if($ApiBase){$arguments+=" -ApiBase $ApiBase"}
  $user="$env:USERDOMAIN\$env:USERNAME";$logon=New-ScheduledTaskTrigger -AtLogOn -User $user;$logon.Delay='PT10M'
  $triggers=@((New-ScheduledTaskTrigger -Daily -At '07:00'),$logon)
  $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  [void](Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Exports job-search mail from classic Outlook and uploads it to the private Job Search Intelligence API.' -Force)
  [void](Disable-ScheduledTask -TaskName $taskName)
}

if($ShowMaintenanceStatus){
  $record=Read-ProtectedJson -Path $manifestPath -Context $context -QuarantineInvalid
  $current=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  [pscustomobject]@{ApprovalHash=if($record){[string]$record.approvalHash}else{''};PreviousTaskState=if($record){[string]$record.previousTaskState}else{''};CurrentTaskState=if($current){[string]$current.State}else{'Absent'};MaintenanceGate=(Test-MaintenanceGate $gateContext);BackupRoot=if($record){[string]$record.backupRoot}else{''};InstalledAt=if($record -and $record.PSObject.Properties['installedAt']){[string]$record.installedAt}else{''}}
  return
}

if($CompleteMaintenance){
  if(-not $MaintenanceApprovalHash){throw 'CompleteMaintenance requires the exact accepted maintenance approval hash.'}
  $record=Read-ProtectedJson -Path $manifestPath -Context $context -QuarantineInvalid
  if(-not $record -or [string]$record.approvalHash -cne $MaintenanceApprovalHash){throw 'Maintenance approval hash does not match the protected registration snapshot.'}
  $current=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if(-not $current -and [string]$record.previousTaskState -eq 'Absent' -and $record.rolledBackAt){
    if($Enable){throw 'Cannot enable a task that was rolled back to an absent prior state.'}
    if(-not (Test-MaintenanceGate $gateContext)){throw 'The durable maintenance gate is not set; refusing completion.'}
    $coordinator=New-PrivateRuntimeMutex 'Local\JobSearchIntelligenceOutlookUpload';$held=$false
    try{try{$held=$coordinator.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Maintenance completion requires the shared mutex to be free.'};Set-MaintenanceGate -Context $gateContext -Enabled $false -Reason absent_installation_rollback_completed;Write-Host 'First-time registration rollback accepted; no scheduled task exists.'}
    catch{try{Set-MaintenanceGate -Context $gateContext -Enabled $true -Reason completion_failed_owner_recovery_required}catch{};throw}
    finally{if($held){try{$coordinator.ReleaseMutex()}catch{}};$coordinator.Dispose()}
    return
  }
  $coordinator=New-PrivateRuntimeMutex 'Local\JobSearchIntelligenceOutlookUpload';$held=$false
  try {
    try{$held=$coordinator.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Maintenance completion requires the shared mutex to be free.'}
    $installed=Read-ProtectedJson -Path $installedPath -Context $context -QuarantineInvalid
    foreach($name in $names){$path=Join-Path $bin $name;$expected=$installed.fileHashes.PSObject.Properties[$name];if(-not $expected -or -not (Test-Path -LiteralPath $path) -or (Get-FileDigest $path) -cne [string]$expected.Value){throw "Installed unit verification failed for $name."}}
    $current=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if([string]$current.State -ne 'Disabled'){throw 'The task must remain disabled until maintenance completion is recorded.'}
    if(-not (Test-MaintenanceGate $gateContext)){throw 'The durable maintenance gate is not set; refusing completion without an active maintenance phase.'}
    Set-MaintenanceGate -Context $gateContext -Enabled $false -Reason maintenance_completed
    if($Enable){[void](Enable-ScheduledTask -TaskName $taskName)}
    Write-Host "Maintenance completed for $taskName. Approval hash: $MaintenanceApprovalHash. Task state: $((Get-ScheduledTask -TaskName $taskName).State)."
  } catch {try{Set-MaintenanceGate -Context $gateContext -Enabled $true -Reason completion_failed_owner_recovery_required}catch{};throw}
  finally{if($held){try{$coordinator.ReleaseMutex()}catch{}};$coordinator.Dispose()}
  return
}

if($RollbackMaintenance){
  if(-not $MaintenanceApprovalHash){throw 'RollbackMaintenance requires the exact protected snapshot approval hash.'}
  $record=Read-ProtectedJson -Path $manifestPath -Context $context -QuarantineInvalid
  if(-not $record -or [string]$record.approvalHash -cne $MaintenanceApprovalHash){throw 'Rollback approval hash does not match the protected registration snapshot.'}
  if(-not (Test-MaintenanceGate $gateContext)){throw 'Rollback requires the durable maintenance gate.'}
  $current=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($current -and [string]$current.State -ne 'Disabled'){throw 'Rollback requires the scheduled task to remain disabled.'}
  $mutex=New-PrivateRuntimeMutex 'Local\JobSearchIntelligenceOutlookUpload';$held=$false
  try {
    try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
    if(-not $held){throw 'Rollback could not acquire the shared uploader/cleanup mutex.'}
    Protect-PrivateDirectory $bin
    foreach($name in $names){
      $destination=Join-Path $bin $name
      $previous=$record.previousFiles.PSObject.Properties[$name]
      if($previous){
        $saved=$previous.Value;$plain=Read-ProtectedBytes -Path ([string]$saved.backupPath) -Context $context
        $sha=[Security.Cryptography.SHA256]::Create();try{$digest=([BitConverter]::ToString($sha.ComputeHash($plain))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        if($digest -cne [string]$saved.sha256){throw "Protected prior install verification failed for $name."}
        $temporary=Join-Path $bin ('.restore-'+[guid]::NewGuid().ToString('N')+'.tmp');[IO.File]::WriteAllBytes($temporary,$plain)
        if([IO.File]::Exists($destination)){$replaceBackup="$temporary.previous";[IO.File]::Replace($temporary,$destination,$replaceBackup,$true);if([IO.File]::Exists($replaceBackup)){[IO.File]::Delete($replaceBackup)}}else{[IO.File]::Move($temporary,$destination)}
      } elseif(Test-Path -LiteralPath $destination){Remove-Item -LiteralPath $destination -Force}
    }
    if([string]$record.previousTaskState -eq 'Absent'){
      $current=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;if($current){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
    } elseif([string]$record.previousTaskXml){
      [void](Register-ScheduledTask -TaskName $taskName -Xml ([string]$record.previousTaskXml) -Force)
      [void](Disable-ScheduledTask -TaskName $taskName)
    } else {throw 'Protected snapshot does not contain a recoverable prior task definition.'}
    $restored=[ordered]@{schemaVersion=1;mailbox=$Mailbox.Trim().ToLowerInvariant();installedAt=[DateTime]::UtcNow.ToString('o');fileHashes=[ordered]@{}}
    foreach($name in $names){$path=Join-Path $bin $name;if(Test-Path -LiteralPath $path){$restored.fileHashes[$name]=Get-FileDigest $path}}
    Save-ProtectedJsonAtomic -Path $installedPath -Value $restored -Context $context
    $record|Add-Member -MemberType NoteProperty -Name rolledBackAt -Value ([DateTime]::UtcNow.ToString('o')) -Force;Save-ProtectedJsonAtomic -Path $manifestPath -Value $record -Context $context
    Write-Host "Prior files and task definition restored in disabled state. Maintenance gate remains set. Approval hash: $MaintenanceApprovalHash."
  } finally {if($held){try{$mutex.ReleaseMutex()}catch{}};$mutex.Dispose()}
  return
}

if($Enable){throw 'Enable requires a separate -CompleteMaintenance invocation with its exact accepted approval hash.'}
if(-not $Mailbox){throw 'Mailbox is required.'}
$snapshot=Save-PreInstallSnapshot $existing
$snapshot.approvalHash=Get-ApprovalDigest $snapshot
Save-ProtectedJsonAtomic -Path $manifestPath -Value $snapshot -Context $context
$coordinator=New-PrivateRuntimeMutex 'Local\JobSearchIntelligenceOutlookUpload';$held=$false
try {
  if($existing){[void](Disable-ScheduledTask -TaskName $taskName)}
  try{$held=$coordinator.WaitOne([TimeSpan]::FromMinutes(3))}catch [Threading.AbandonedMutexException]{$held=$true}
  if(-not $held){throw 'Timed out waiting for the previous Outlook holder to finish; task remains disabled and the snapshot is preserved.'}

  # The old holder is drained and the mutex is ours. Persist the gate before
  # the first filesystem/task mutation so a crash cannot expose a partial unit.
  Set-MaintenanceGate -Context $gateContext -Enabled $true -Reason registration_in_progress
  Protect-PrivateDirectory $bin
  $stage=Join-Path $stateRoot ('bin.stage-'+[guid]::NewGuid().ToString('N'));Protect-PrivateDirectory $stage
  $hashes=[ordered]@{}
  try {
    foreach($name in $names){$source=Join-Path $PSScriptRoot $name;if(-not (Test-Path -LiteralPath $source)){throw "Required installed unit is missing: $name"};Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name);$hashes[$name]=Get-FileDigest (Join-Path $stage $name)}
    foreach($name in $names){Move-Item -LiteralPath (Join-Path $stage $name) -Destination (Join-Path $bin $name) -Force}
    foreach($name in $names){if((Get-FileDigest (Join-Path $bin $name)) -cne [string]$hashes[$name]){throw "Installed unit verification failed for $name."}}
  } finally {Remove-InstallStage $stage}
  $installed=[ordered]@{schemaVersion=1;mailbox=$Mailbox.Trim().ToLowerInvariant();installedAt=[DateTime]::UtcNow.ToString('o');fileHashes=$hashes}
  Save-ProtectedJsonAtomic -Path $installedPath -Value $installed -Context $context
  Register-DisabledTask
  $snapshot.installedFileHashes=$hashes;$snapshot.taskStateAfterInstall='Disabled'
  Save-ProtectedJsonAtomic -Path $manifestPath -Value $snapshot -Context $context
  Set-MaintenanceGate -Context $gateContext -Enabled $true -Reason registration_requires_owner_acceptance
  Write-Host "Installed disabled gate-aware unit at $bin. Maintenance gate remains set. Verify acceptance, then complete with -CompleteMaintenance -MaintenanceApprovalHash $($snapshot.approvalHash)."
} catch {
  try{Set-MaintenanceGate -Context $gateContext -Enabled $true -Reason registration_failed_owner_recovery_required}catch{}
  throw
} finally {
  if($held){try{$coordinator.ReleaseMutex()}catch{}}
  $coordinator.Dispose()
}

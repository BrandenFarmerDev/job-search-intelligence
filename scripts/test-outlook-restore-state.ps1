Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library
function Assert-Restore($Value,[string]$Name){if(-not $Value){throw "Restore-state behavior failed: $Name"}}
function New-RestoredFixture([bool]$WasSent){
  $copy=[pscustomobject]@{ReceivedTime=([datetime]'2026-10-11T12:00:00Z').ToUniversalTime();Sent=$WasSent;Flags=$(if($WasSent){18}else{26});SaveCount=0;FailSet=$false;IgnoreSet=$false;ChangeStateOnReopen=$false;EntryID='synthetic-restored';Parent=[pscustomobject]@{StoreID='synthetic-store'}}
  $accessor=[pscustomobject]@{Owner=$copy}
  $accessor|Add-Member ScriptMethod GetProperty {param($Property);return $this.Owner.Flags}
  $accessor|Add-Member ScriptMethod SetProperty {param($Property,$Value);if($Property -like '*0x0E070003'){throw 'MSGFLAG_UNSENT is read-only after the first save'};if($this.Owner.FailSet){throw 'synthetic denied state update'};if(-not $this.Owner.IgnoreSet){$this.Owner.ReceivedTime=[datetime]$Value}}
  $copy|Add-Member NoteProperty PropertyAccessor $accessor
  $copy|Add-Member ScriptMethod Save {$this.SaveCount++}
  $namespace=[pscustomobject]@{Copy=$copy}
  $namespace|Add-Member ScriptMethod GetItemFromID {param($Id,$Store);if($Id -ne 'synthetic-restored' -or $Store -ne 'synthetic-store'){throw 'wrong restored locator'};if($this.Copy.ChangeStateOnReopen){$this.Copy.Sent=-not $this.Copy.Sent};return $this.Copy}
  return [pscustomobject]@{Copy=$copy;Namespace=$namespace;Proof=[pscustomobject]@{receivedAt='2026-10-01T12:00:00.0000000Z';wasSent=$WasSent}}
}
foreach($wasSent in @($true,$false)){
  $fixture=New-RestoredFixture $wasSent
  $actual=Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace
  Assert-Restore ($actual.Sent -eq $wasSent -and $actual.ReceivedTime.ToUniversalTime().Ticks -eq ([datetime]'2026-10-01T12:00:00Z').ToUniversalTime().Ticks) 'delivery timestamp restores when provider rejects writes to the already-correct read-only sent/draft state'
  Assert-Restore ($actual.Flags -eq $(if($wasSent){18}else{26})) 'restoration preserves all existing MAPI message flag bits'
  [void](Restore-BackupReceivedTime $actual $fixture.Proof $fixture.Namespace)
  Assert-Restore ($actual.SaveCount -eq 1) 'unchanged restored state does not save twice'
  $fixture=New-RestoredFixture $wasSent;$fixture.Copy.Sent=-not $wasSent;$before=$fixture.Copy.ReceivedTime;$refused=$false
  try{[void](Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace)}catch{$refused=$_.Exception.Message -like '*read-only state*'}
  Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 0 -and $fixture.Copy.ReceivedTime -eq $before) 'incorrect imported sent/draft state fails before mutating the saved copy'
}
$fixture=New-RestoredFixture $true;$refused=$false
try{[void](Restore-BackupReceivedTime $fixture.Copy ([pscustomobject]@{receivedAt='2026-10-01T12:00:00Z'}) $fixture.Namespace)}catch{$refused=$true}
Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 0) 'missing sent/draft proof fails before changing the copy'
$fixture=New-RestoredFixture $true;$fixture.Copy.FailSet=$true;$refused=$false
try{[void](Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace)}catch{$refused=$true}
Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 0) 'provider refusal stops restoration without accepting a changed timestamp'
$fixture=New-RestoredFixture $true;$fixture.Copy.IgnoreSet=$true;$refused=$false
try{[void](Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace)}catch{$refused=$true}
Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 1) 'provider silently ignoring the timestamp update cannot produce an accepted restoration'
$fixture=New-RestoredFixture $true;$fixture.Copy.ChangeStateOnReopen=$true;$refused=$false
try{[void](Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace)}catch{$refused=$true}
Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 1) 'reopened destination must still preserve the verified sent/draft state'
Write-Output 'Synthetic restore-state behavior tests passed.'

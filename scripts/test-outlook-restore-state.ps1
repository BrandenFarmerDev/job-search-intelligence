Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library
function Assert-Restore($Value,[string]$Name){if(-not $Value){throw "Restore-state behavior failed: $Name"}}
function New-RestoredFixture([bool]$WasSent){
  $copy=[pscustomobject]@{ReceivedTime=([datetime]'2026-10-11T12:00:00Z').ToUniversalTime();Sent=$false;Flags=26;SaveCount=0;FailSet=$false;EntryID='synthetic-restored';Parent=[pscustomobject]@{StoreID='synthetic-store'}}
  $accessor=[pscustomobject]@{Owner=$copy}
  $accessor|Add-Member ScriptMethod GetProperty {param($Property);return $this.Owner.Flags}
  $accessor|Add-Member ScriptMethod SetProperty {param($Property,$Value);if($this.Owner.FailSet){throw 'synthetic denied state update'};if($Property -like '*0x0E070003'){$this.Owner.Flags=[int]$Value;$this.Owner.Sent=(([int]$Value -band 8) -eq 0)}else{$this.Owner.ReceivedTime=[datetime]$Value}}
  $copy|Add-Member NoteProperty PropertyAccessor $accessor
  $copy|Add-Member ScriptMethod Save {$this.SaveCount++}
  $namespace=[pscustomobject]@{Copy=$copy}
  $namespace|Add-Member ScriptMethod GetItemFromID {param($Id,$Store);if($Id -ne 'synthetic-restored' -or $Store -ne 'synthetic-store'){throw 'wrong restored locator'};return $this.Copy}
  return [pscustomobject]@{Copy=$copy;Namespace=$namespace;Proof=[pscustomobject]@{receivedAt='2026-10-01T12:00:00.0000000Z';wasSent=$WasSent}}
}
foreach($wasSent in @($true,$false)){
  $fixture=New-RestoredFixture $wasSent
  $actual=Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace
  Assert-Restore ($actual.Sent -eq $wasSent -and $actual.ReceivedTime.ToUniversalTime().Ticks -eq ([datetime]'2026-10-01T12:00:00Z').ToUniversalTime().Ticks) 'restored copy preserves proven sent/draft state and original received UTC'
  Assert-Restore (($actual.Flags -band (-bnot 8)) -eq (26 -band (-bnot 8))) 'restoration preserves unrelated MAPI message flag bits'
  [void](Restore-BackupReceivedTime $actual $fixture.Proof $fixture.Namespace)
  Assert-Restore ($actual.SaveCount -eq 1) 'unchanged restored state does not save twice'
}
$fixture=New-RestoredFixture $true;$refused=$false
try{[void](Restore-BackupReceivedTime $fixture.Copy ([pscustomobject]@{receivedAt='2026-10-01T12:00:00Z'}) $fixture.Namespace)}catch{$refused=$true}
Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 0) 'missing sent/draft proof fails before changing the copy'
$fixture=New-RestoredFixture $true;$fixture.Copy.FailSet=$true;$refused=$false
try{[void](Restore-BackupReceivedTime $fixture.Copy $fixture.Proof $fixture.Namespace)}catch{$refused=$true}
Assert-Restore ($refused -and $fixture.Copy.SaveCount -eq 0) 'provider refusal stops restoration without accepting a changed timestamp'
Write-Output 'Synthetic restore-state behavior tests passed.'

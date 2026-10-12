[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

# Keep full-size synthetic parser and canonical-hash regression checks outside
# Pester's command debugger. They remain mandatory under check-powershell on
# both supported engines, while the smaller behavior tests exercise the same
# parser branches under command coverage.
$runtimePath=Join-Path $PSScriptRoot 'outlook-private-runtime.psm1'
Import-Module $runtimePath -Force
$runtimeModule=Get-Module outlook-private-runtime
if(-not $runtimeModule){throw 'Private runtime module did not load.'}
$rows=[Collections.Generic.List[string]]::new()
for($index=0;$index -lt 17000;$index++){
  $rows.Add('{"subject":"2026-10-11T07:15:30.1234567-07:00","body":"synthetic '+$index+'"}')
}
$json='{"items":['+([string]::Join(',',$rows.ToArray()))+']}'
$watch=[Diagnostics.Stopwatch]::StartNew()
$parsed=$runtimeModule.Invoke({param($value) ConvertFrom-JsonPreservingStrings $value},$json)
$watch.Stop()
if(@($parsed.items).Count -ne 17000){throw 'Large synthetic JSON parse lost array entries.'}
if([string]$parsed.items[16999].subject -cne '2026-10-11T07:15:30.1234567-07:00'){
  throw 'Large synthetic JSON parse changed an ISO-looking subject string.'
}
if($watch.Elapsed.TotalSeconds -ge 60){throw ('Large synthetic JSON parsing exceeded 60 seconds ({0:N2}s).' -f $watch.Elapsed.TotalSeconds)}
Write-Output ('Synthetic 17,000-row JSON parse completed in {0:N2}s.' -f $watch.Elapsed.TotalSeconds)

# Full-size canonical manifest hashing is measured outside Pester command
# coverage instrumentation so the approval-window performance check reflects
# production serializer cost under both PowerShell engines.
. (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library
$manifestRows=[Collections.Generic.List[object]]::new()
for($index=0;$index -lt 17155;$index++){
  $manifestRows.Add([ordered]@{
    rowId=('{0:x64}' -f $index);storeId='synthetic-store-id';folderId='synthetic-inbox-id';folder='Inbox'
    entryId=('synthetic-entry-{0:D8}' -f $index);searchKey='AQIDBAUGBwg='
    internetMessageId=('<fixture-{0}@example.invalid>' -f $index);conversationId=('synthetic-conversation-{0:D8}' -f $index)
    subject='Application received for Software Engineer';sender='jobs@example.invalid'
    receivedAt='2026-10-01T12:00:00.0000000Z';modifiedAt='2026-10-01T12:01:00.0000000Z'
    fingerprint=('a'*64);bodyHash=('b'*64);bodyLength=192;bodyStatus='complete'
    unread=$false;flagged=$false;categories='';attachmentCount=0;attachmentMetadata=@()
    protected=$false;class='Application receipts';confidence='high';reason='submission_confirmation'
    sensitive=$false;action='move';destination='Application receipts'
  })
}
$largeManifest=[ordered]@{
  schema='outlook-cleanup-manifest.v1';schemaVersion=1;utilityVersion='1.0.0';ruleVersion='cleanup-rules-2026-10-11.1'
  createdAt='2026-10-11T19:00:00.0000000Z';mailboxBinding=('c'*64);storeId='synthetic-store-id'
  sources=@(@{folderId='synthetic-inbox-id';folder='Inbox';defaultFolderId=6},@{folderId='synthetic-junk-id';folder='Junk';defaultFolderId=23})
  complete=$true;evidenceComplete=$true;itemCount=$manifestRows.Count
  summary=@{byClass=@{'Application receipts'=$manifestRows.Count};unreadDeleteCount=0;flaggedDeleteCount=0;sensitiveDeleteCount=0;attachmentDeleteCount=0;preFloorDeleteCount=0}
  items=$manifestRows.ToArray();manifestHash='ignored-at-root'
}
$hashWatch=[Diagnostics.Stopwatch]::StartNew()
$manifestHash=Get-ManifestHash $largeManifest
$hashWatch.Stop()
if($manifestHash -notmatch '^[0-9a-f]{64}$' -or $hashWatch.Elapsed.TotalSeconds -ge 60){
  throw ('17,155-row canonical manifest hashing exceeded its 60-second approval-proof budget ({0:N2}s).' -f $hashWatch.Elapsed.TotalSeconds)
}
Write-Output ('Synthetic 17,155-row canonical hash completed in {0:N2}s.' -f $hashWatch.Elapsed.TotalSeconds)

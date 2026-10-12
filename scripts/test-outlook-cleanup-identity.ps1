[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library
function Assert-IdentityTest([bool]$Value,[string]$Name){if(-not $Value){throw "Synthetic cleanup identity test failed: $Name"}}
function New-IdentityItems([object[]]$Rows){$items=[pscustomobject]@{Rows=$Rows};$items|Add-Member ScriptProperty Count {$this.Rows.Count};$items|Add-Member ScriptMethod Item {param($Index)if($Index -lt 1 -or $Index -gt $this.Rows.Count){throw 'item index outside fixture'};return $this.Rows[$Index-1]};return $items}
function New-IdentityFolder([string]$Id,[string]$Name,[string]$Store,[object[]]$Rows=@()){$folder=[pscustomobject]@{EntryID=$Id;Name=$Name;StoreID=$Store;Items=(New-IdentityItems $Rows);Parent=$null};return $folder}

$storeId='synthetic-identity-store';$source=New-IdentityFolder 'identity-inbox' 'Inbox' $storeId; $junk=New-IdentityFolder 'identity-junk' 'Junk E-mail' $storeId
$root=New-IdentityFolder 'identity-root' 'Job Search' $storeId;$root.Parent=$source
$destination=New-IdentityFolder 'identity-destination' 'Offers' $storeId;$destination.Parent=$root
$item=[pscustomobject]@{Class=43;EntryID='identity-entry';Subject='Offer letter for Product Engineer';Body='We are pleased to offer you employment as a Product Engineer. Please review the compensation package.';SenderEmailAddress='recruiter@example.invalid';ConversationID='identity-thread';ReceivedTime=[datetime]'2026-10-01T12:00:00Z';LastModificationTime=[datetime]'2026-10-01T12:05:00Z';UnRead=$true;FlagStatus=2;Categories='Synthetic';Attachments=[pscustomobject]@{Count=0};Parent=$source}
$identityAccessor=[pscustomobject]@{};$identityAccessor|Add-Member ScriptMethod GetProperty {param($Uri) if($Uri -like '*0x1035001F'){return '<identity-fixture@example.invalid>'};if($Uri -like '*0x300B0102'){return ,[byte[]](9,8,7)};throw 'MAPI property unavailable'};$item|Add-Member NoteProperty PropertyAccessor $identityAccessor
$source.Items=New-IdentityItems @($item)
$script:IdentityFolders=@{'identity-inbox'=$source;'identity-junk'=$junk;'identity-root'=$root;'identity-destination'=$destination};$script:IdentityItem=$item;$script:FailGetItemById=$false
$namespace=[pscustomobject]@{};$namespace|Add-Member ScriptMethod GetFolderFromID {param($EntryID,$StoreID)if($StoreID -cne $script:IdentityStoreId){throw 'store mismatch'};if(-not $script:IdentityFolders.ContainsKey($EntryID)){throw 'folder missing'};return $script:IdentityFolders[$EntryID]};$namespace|Add-Member ScriptMethod GetItemFromID {param($EntryID,$StoreID)if($script:FailGetItemById){throw 'injected stale EntryID'};if($EntryID -eq $script:IdentityItem.EntryID){return $script:IdentityItem};throw 'item missing'}
$script:IdentityStoreId=$storeId;$session=[pscustomobject]@{Namespace=$namespace;StoreId=$storeId;Inbox=$source;Junk=$junk;Deleted=(New-IdentityFolder 'identity-deleted' 'Deleted Items' $storeId)}
try {
  # These are the exact physical capture rules used by rollout receipts. Alerts,
  # non-job deletes, pre-floor rows, and malformed dates must not inflate proof.
  $captureRows=@(
    [pscustomobject]@{rowId='a';action='move';class='Offers';actionEligible=$true;evidenceComplete=$true;receivedAt='2026-09-30T00:00:00.000001-07:00'},
    [pscustomobject]@{rowId='b';action='move';class='Job alerts';receivedAt='2026-10-01T12:00:00Z'},
    [pscustomobject]@{rowId='c';action='delete_to_deleted_items';class='Delete candidate';receivedAt='2026-10-01T12:00:00Z'},
    [pscustomobject]@{rowId='d';action='move';class='Interviews';actionEligible=$true;evidenceComplete=$true;receivedAt='2026-09-30T06:59:59.9999999Z'},
    [pscustomobject]@{rowId='e';action='move';class='Assessments';actionEligible=$true;evidenceComplete=$true;receivedAt='not-a-date'},
    [pscustomobject]@{rowId='f';action='move';class='Rejections';actionEligible=$true;evidenceComplete=$true;receivedAt='2026-09-30T07:00:00.0000001Z'},
    [pscustomobject]@{rowId='g';action='move';class='Application receipts';actionEligible=$true;evidenceComplete=$true;receivedAt='2026-09-30T07:00:00Z'},
    [pscustomobject]@{rowId='h';action='move';class='Recruiter follow-ups';actionEligible=$true;evidenceComplete=$true;receivedAt='2026-10-01T12:00:00Z'}
  )
  $required=Get-RequiredCaptureRows ([pscustomobject]@{items=$captureRows})
  Assert-IdentityTest (($required.rowId -join ',') -eq 'a,f,g,h') 'capture proof uses exact in-floor job-evidence classes, UTC date normalization, and fractional floor boundaries'
  $backupCandidates=@([pscustomobject]@{rowId='ready';action='move'},[pscustomobject]@{rowId='done';action='move'},[pscustomobject]@{rowId='delete';action='delete_to_deleted_items'},[pscustomobject]@{rowId='review';action='review'})
  $needing=Get-ActionRowsNeedingBackup ([pscustomobject]@{items=$backupCandidates}) ([ordered]@{ready=@{status='backup_verified'};done=@{status='completed'}})
  Assert-IdentityTest (($needing.rowId -join ',') -eq 'delete') 'backup queue includes pending actions only and skips verified or completed rows'
  Assert-IdentityTest (-not (Test-ActionBudget 25 25 ([datetime]::UtcNow.AddMinutes(1)))) 'action count ceiling always stops processing'
  $script:Clock={return [datetime]'2026-10-01T12:00:00Z'}
  Assert-IdentityTest (Test-ActionBudget 0 25 ([datetime]'2026-10-01T12:01:00Z')) 'injected UTC clock permits work within both action limits'
  Assert-IdentityTest (-not (Test-ActionBudget 0 25 ([datetime]'2026-10-01T11:59:59Z'))) 'action deadline stops even before count limit'
  $script:Clock=$null
  Assert-IdentityTest ((Get-CleanupUtcNow).Kind -eq [DateTimeKind]::Utc) 'production UTC clock returns a UTC instant'
  Assert-IdentityTest ((ConvertTo-CleanupUtcDate ([datetime]'2026-10-01T05:00:00-07:00')).ToString('o') -eq '2026-10-01T12:00:00.0000000Z') 'typed timestamps normalize to UTC'
  Assert-IdentityTest ((ConvertTo-CleanupUtcDate '2026-10-01T05:00:00-07:00').ToString('o') -eq '2026-10-01T12:00:00.0000000Z') 'serialized timestamp strings parse with round-trip timezone'
  $classifications=@(
    (Get-Classification 'Job offer tips' 'We are pleased to offer you employment.' 'careers@example.invalid'),
    (Get-Classification 'Interview invitation and assessment' 'Please complete our coding exercise.' 'recruiter@example.invalid'),
    (Get-Classification 'Jobs for you this week' 'Curated jobs with many links https://example.invalid/a' 'alerts@example.invalid'),
    (Get-Classification 'Recruiter follow-up on your application' 'I would like to discuss the role with you.' 'recruiter@example.invalid'),
    (Get-Classification 'Verify your account' 'Please click here to restore access.' 'security@example.invalid'),
    (Get-Classification 'Bank statement' 'Your monthly bank statement is attached for your records.' 'bank@example.invalid' $true),
    (Get-Classification 'A note' 'short' 'sender@example.invalid'),
    (Get-Classification 'Offer letter' 'We are pleased to offer you employment.' 'recruiter@example.invalid' $false $true)
  )
  Assert-IdentityTest ($classifications[0].Class -eq 'Offers' -and $classifications[1].Class -eq 'Review' -and $classifications[2].Class -eq 'Job alerts' -and $classifications[3].Class -eq 'Recruiter follow-ups' -and $classifications[4].Reason -eq 'suspicious_content' -and $classifications[5].Sensitive -and $classifications[6].Class -eq 'Review' -and $classifications[7].Class -eq 'Review') 'classifier applies purpose conflicts, phishing, sensitive content, generic alerts, and evidence gaps conservatively'
  $falseDelete=Get-Classification 'Next steps at Acme' 'We enjoyed speaking with you about the role. Please send your availability for tomorrow.' 'hr@example.invalid'
  Assert-IdentityTest ($falseDelete.Class -eq 'Review' -and $falseDelete.Reason -eq 'recruiting_conversation_needs_review') 'recruiting follow-up availability cannot be classified as a delete candidate from a sender or broad keyword alone'
  Assert-IdentityTest ((Get-Classification 'Technical test' 'Please review the attached information and reply when ready.' 'jobs@example.invalid').Class -eq 'Assessments' -and (Get-Classification 'Compensation package' 'Please review the attached information and reply when ready.' 'jobs@example.invalid').Class -eq 'Offers') 'definite assessment and offer purpose phrases are recognized from subject'
  Assert-IdentityTest ((Get-Classification 'Thank you for your interest' 'After reviewing all submissions, we have decided to move forward with other applicants.' 'jobs@example.invalid').Class -eq 'Rejections') 'explicit other-applicant decision remains job evidence and cannot become a delete candidate'
  $snapshot=Get-ItemRecord $item $storeId $source.EntryID $source.Name
  Assert-IdentityTest ($snapshot.internetMessageId -eq '<identity-fixture@example.invalid>' -and $snapshot.searchKey -eq [Convert]::ToBase64String([byte[]](9,8,7))) 'physical identity reads Internet Message-ID and search key through MAPI properties'
  $row=[pscustomobject]@{};foreach($key in $snapshot.Keys){$row|Add-Member NoteProperty $key $snapshot[$key]}
  $found=Get-SourceItem $session $row
  Assert-IdentityTest ([object]::ReferenceEquals($found,$item)) 'direct EntryID lookup verifies parent folder identity and returns the physical item'
  $matches=Find-PhysicalMatches $session $source $row
  Assert-IdentityTest ($matches.Count -eq 1 -and [object]::ReferenceEquals($matches[0],$item)) 'physical matching checks content, time, Internet ID, and conversation ID'
  Test-ApprovedSnapshot $snapshot $row
  Test-RecoverySnapshot $snapshot $row
  $badSnapshot=[ordered]@{};foreach($key in $snapshot.Keys){$badSnapshot[$key]=$snapshot[$key]};$badSnapshot.subject='Changed subject';$changedRejected=$false;try{Test-ApprovedSnapshot $badSnapshot $row}catch{$changedRejected=$true}
  Assert-IdentityTest $changedRejected 'fresh subject change blocks an approved move'
  $badSnapshot=[ordered]@{};foreach($key in $snapshot.Keys){$badSnapshot[$key]=$snapshot[$key]};$badSnapshot.flagStatus='1';$flagChangeRejected=$false;try{Test-ApprovedSnapshot $badSnapshot $row}catch{$flagChangeRejected=$true};Assert-IdentityTest $flagChangeRejected 'exact Outlook FlagStatus change blocks an approved move'
  $badSnapshot=[ordered]@{};foreach($key in $snapshot.Keys){$badSnapshot[$key]=$snapshot[$key]};$badSnapshot.attachmentCount=1;$attachmentChangeRejected=$false;try{Test-RecoverySnapshot $badSnapshot $row}catch{$attachmentChangeRejected=$true}
  Assert-IdentityTest $attachmentChangeRejected 'recovery refuses changed attachment count'
  $script:FailGetItemById=$true;$fallback=Get-SourceItem $session $row
  Assert-IdentityTest ([object]::ReferenceEquals($fallback,$item)) 'stale EntryID can resolve only one approved physical fallback in the exact source folder'
  $duplicate=[pscustomobject]@{};foreach($key in $item.PSObject.Properties.Name){$duplicate|Add-Member NoteProperty $key $item.$key};$source.Items=New-IdentityItems @($item,$duplicate)
  $ambiguousRejected=$false;try{Get-SourceItem $session $row|Out-Null}catch{$ambiguousRejected=$true}
  Assert-IdentityTest $ambiguousRejected 'ambiguous physical fallback stops without selecting a duplicate'
  $script:FailGetItemById=$false;$source.Items=New-IdentityItems @($item)
  $approvedFolders=[pscustomobject]@{rootId=$root.EntryID;folders=@([pscustomobject]@{name='Offers';entryId=$destination.EntryID})}
  $verifiedDestination=Get-ApprovedDestination $session $approvedFolders $row
  Assert-IdentityTest ([object]::ReferenceEquals($verifiedDestination,$destination)) 'destination must be the exact same-store approved direct taxonomy child'
  $wrongStore=New-IdentityFolder 'identity-wrong' 'Offers' 'other-store';$wrongStore.Parent=$root;$script:IdentityFolders['identity-wrong']=$wrongStore;$approvedFolders.folders=@([pscustomobject]@{name='Offers';entryId='identity-wrong'});$scopeRejected=$false;try{Get-ApprovedDestination $session $approvedFolders $row|Out-Null}catch{$scopeRejected=$true}
  Assert-IdentityTest $scopeRejected 'destination from a different store is rejected'
  $validScope=[pscustomobject]@{schema='outlook-cleanup-manifest.v2';schemaVersion=2;utilityVersion='1.0.0';ruleVersion='cleanup-rules-2026-10-11.2';storeId=$storeId;sources=@([pscustomobject]@{folderId=$source.EntryID;folder='Inbox';defaultFolderId=6},[pscustomobject]@{folderId=$junk.EntryID;folder='Junk';defaultFolderId=23});items=@()}
  Assert-IdentityTest ((Assert-ManifestActionScope $validScope) -eq $null) 'manifest action scope accepts exactly the selected direct Inbox and Junk defaults'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.sources[1].defaultFolderId=3;try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope rejects substituted default folders'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.items=@([pscustomobject]@{rowId='bad';storeId=$storeId;folderId=$source.EntryID;folder='Inbox';action='move';class='Offers';destination='Offers'});try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope rejects nonopaque physical row keys'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.items=@([pscustomobject]@{rowId=('a'*64);storeId='other';folderId=$source.EntryID;folder='Inbox';action='review';class='Review';destination='Review'});try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope rejects cross-store row edits'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.items=@([pscustomobject]@{rowId=('b'*64);storeId=$storeId;folderId=$source.EntryID;folder='Inbox';action='delete_to_deleted_items';class='Offers';destination='Offers'});try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope rejects converting job mail into a delete action'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.items=@([pscustomobject]@{rowId=('c'*64);storeId=$storeId;folderId=$junk.EntryID;folder='Inbox';action='review';class='Review';destination='Review'});try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope verifies each source folder label against its exact folder ID'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.items=@([pscustomobject]@{rowId=('d'*64);storeId=$storeId;folderId=$source.EntryID;folder='Inbox';action='move';class='Offers';destination='Interviews'});try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope refuses alternate destinations for a job category'
  $scopeFailure=$false;$invalidScope=ConvertTo-MutableMap $validScope;$invalidScope.items=@([pscustomobject]@{rowId=('e'*64);storeId=$storeId;folderId=$source.EntryID;folder='Inbox';action='delete';class='Delete candidate';destination='Delete candidate'});try{Assert-ManifestActionScope $invalidScope}catch{$scopeFailure=$true};Assert-IdentityTest $scopeFailure 'manifest action scope refuses unsupported delete/purge verbs'
  $validDelete=ConvertTo-MutableMap $validScope;$deleteRow=ConvertTo-MutableMap $snapshot;$deleteRow.rowId='f'*64;$deleteRow.folderId=$junk.EntryID;$deleteRow.folder='Junk E-mail';$deleteRow.action='delete_to_deleted_items';$deleteRow.class='Delete candidate';$deleteRow.destination='Delete candidate';$deleteRow.actionEligible=$true;$deleteRow.evidenceComplete=$true;$validDelete.items=@($deleteRow);Assert-IdentityTest ((Assert-ManifestActionScope $validDelete) -eq $null) 'manifest permits only explicit non-job candidate Move to Deleted Items'
  $duplicatePhysical=ConvertTo-MutableMap $deleteRow;$duplicatePhysical.rowId='1'*64;$validDelete.items=@($deleteRow,$duplicatePhysical);$duplicateLocatorRejected=$false;try{Assert-ManifestActionScope $validDelete}catch{$duplicateLocatorRejected=$true};Assert-IdentityTest $duplicateLocatorRejected 'manifest rejects duplicate physical locators even when opaque row IDs differ'
  Assert-IdentityTest (Test-StringSequenceEqual @('one','two') @('one','two')) 'attachment digest sequence comparison accepts an exact match'
  Assert-IdentityTest (-not (Test-StringSequenceEqual @('one','two') @('two','one'))) 'attachment digest sequence comparison preserves order'
  $typedValues=[JobSearchIntelligence.CanonicalManifestJson]::Serialize([ordered]@{offset=[datetimeoffset]'2026-10-01T05:00:00-07:00';byte=[byte]8;decimal=[decimal]1.25;nested=@(@{value='a'})})
  Assert-IdentityTest ($typedValues.Contains('2026-10-01T12:00:00.0000000Z') -and $typedValues.Contains('"byte":8') -and $typedValues.Contains('"decimal":1.25')) 'canonical JSON formats UTC offsets and numeric types deterministically'
  $scalarHash=Get-ManifestHash ([ordered]@{n=12;flag=$true;none=$null;when=[datetime]'2026-10-01T12:00:00Z';list=@('x','y')})
  Assert-IdentityTest ($scalarHash -match '^[0-9a-f]{64}$' -and (Get-StringHash 'x').Length -eq 64) 'canonical manifest serialization handles scalar/date/list values and stable SHA-256'
  $badNumberRejected=$false;try{[JobSearchIntelligence.CanonicalManifestJson]::Serialize([double]::PositiveInfinity)|Out-Null}catch{$badNumberRejected=$true};Assert-IdentityTest $badNumberRejected 'canonical manifests reject non-finite numeric values'
  Write-Output 'Synthetic cleanup physical identity tests passed.'
} finally {$script:IdentityFolders=$null;$script:IdentityItem=$null;$script:IdentityStoreId=$null;$script:FailGetItemById=$false}

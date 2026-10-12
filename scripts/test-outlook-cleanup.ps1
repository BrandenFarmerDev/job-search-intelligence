[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library
function Assert-Test([bool]$Value,[string]$Name){if(-not $Value){throw "Synthetic cleanup behavior failed: $Name"}}
function ConvertTo-CanonicalJsonReferenceString([string]$Value){$escaped=$Value.Replace('\','\\').Replace('"','\"').Replace([string][char]8,'\b').Replace("`t",'\t').Replace("`n",'\n').Replace([string][char]12,'\f').Replace("`r",'\r');$escaped=[regex]::Replace($escaped,'[\x00-\x07\x0b\x0e-\x1f]',[Text.RegularExpressions.MatchEvaluator]{param($match);return ('\u{0:x4}' -f [int][char]$match.Value)});return '"'+$escaped+'"'}
function ConvertTo-CanonicalJsonReference($Value,[bool]$Root=$false){if($null -eq $Value){return 'null'};if($Value -is [bool]){if($Value){return 'true'}else{return 'false'}};if($Value -is [datetime]){$date=$Value.ToUniversalTime();$normalized=$date.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture);return ConvertTo-CanonicalJsonReferenceString $normalized};if($Value -is [datetimeoffset]){$date=$Value.UtcDateTime;$normalized=$date.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture);return ConvertTo-CanonicalJsonReferenceString $normalized};if($Value -is [string]){return ConvertTo-CanonicalJsonReferenceString ([string]$Value)};if($Value -is [Collections.IDictionary]){$keys=[Collections.Generic.List[string]]::new();foreach($key in $Value.Keys){$keys.Add([string]$key)};$keys.Sort([StringComparer]::Ordinal);$parts=[Collections.Generic.List[string]]::new();foreach($key in $keys){if($Root -and $key -ceq 'manifestHash'){continue};$parts.Add((ConvertTo-CanonicalJsonReferenceString $key)+':'+(ConvertTo-CanonicalJsonReference $Value[$key] $false))};return '{'+($parts -join ',')+'}'};if($Value -is [Collections.IEnumerable]){$parts=[Collections.Generic.List[string]]::new();foreach($entry in $Value){$parts.Add((ConvertTo-CanonicalJsonReference $entry $false))};return '['+($parts -join ',')+']'};if($Value -is [byte]){return $Value.ToString([Globalization.CultureInfo]::InvariantCulture)};if($Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64] -or $Value -is [decimal]){return [Convert]::ToString($Value,[Globalization.CultureInfo]::InvariantCulture)};if($Value -is [single] -or $Value -is [double]){if([double]::IsNaN([double]$Value) -or [double]::IsInfinity([double]$Value)){throw 'Non-finite values are not valid in canonical manifests.'};return ([double]$Value).ToString('R',[Globalization.CultureInfo]::InvariantCulture)};$properties=@($Value.PSObject.Properties|Where-Object{$_.MemberType -in 'NoteProperty','Property','AliasProperty'});$keys=[Collections.Generic.List[string]]::new();foreach($property in $properties){$keys.Add([string]$property.Name)};$keys.Sort([StringComparer]::Ordinal);$parts=[Collections.Generic.List[string]]::new();foreach($key in $keys){if($Root -and $key -ceq 'manifestHash'){continue};$property=$Value.PSObject.Properties[$key];$parts.Add((ConvertTo-CanonicalJsonReferenceString $key)+':'+(ConvertTo-CanonicalJsonReference $property.Value $false))};return '{'+($parts -join ',')+'}'}
function New-FakeItems([object[]]$Rows){$x=[pscustomobject]@{Rows=$Rows};$x|Add-Member ScriptProperty Count {$this.Rows.Count};$x|Add-Member ScriptMethod Item {param($Index) if($Index -lt 1 -or $Index -gt $this.Rows.Count){throw 'fake item index'};return $this.Rows[$Index-1]};return $x}
function New-FakeFolder([string]$Id,[object[]]$Rows){return [pscustomobject]@{EntryID=$Id;Items=(New-FakeItems $Rows)}}
function New-FakeStore([string]$Id,$Inbox,$Junk){$x=[pscustomobject]@{StoreID=$Id;Inbox=$Inbox;Junk=$Junk;Deleted=(New-FakeFolder ($Id+'-deleted') @())};$x|Add-Member ScriptMethod GetDefaultFolder {param($FolderId) if($FolderId -eq 6){return $this.Inbox};if($FolderId -eq 23){return $this.Junk};if($FolderId -eq 3){return $this.Deleted};throw 'out of scope folder'};return $x}
function New-FakeAccount([string]$Address,$Store){return [pscustomobject]@{SmtpAddress=$Address;DeliveryStore=$Store}}
function New-FakeAccounts([object[]]$Rows){$x=[pscustomobject]@{Rows=$Rows};$x|Add-Member ScriptProperty Count {$this.Rows.Count};$x|Add-Member ScriptMethod Item {param($Index)return $this.Rows[$Index-1]};return $x}
function New-FakeNamespace($Accounts){$x=[pscustomobject]@{Accounts=$Accounts};$x|Add-Member ScriptMethod GetNamespace {param($Name)return $this};return $x}
function New-FakeOutlook($Namespace){$x=[pscustomobject]@{Namespace=$Namespace};$x|Add-Member ScriptMethod GetNamespace {param($Name)return $this.Namespace};return $x}

# Classification behavior is local and deterministic; no Outlook COM object is created.
$cases=@(
  @{S='Application received';B='Thank you for applying to the software engineer role';Expected='Application receipts'},
  @{S='Interview invitation';B='We received your application. Choose a time for an interview.';Expected='Interviews'},
  @{S='Thank you for applying';B='We have received your application. We would like to interview you.';Expected='Interviews'},
  @{S='Assessment due Friday';B='Complete the technical test by Friday';Expected='Assessments'},
  @{S='Offer letter';B='We are pleased to offer you employment';Expected='Offers'},
  @{S='Application rejected';B='We will not move forward';Expected='Rejections'},
  @{S='Weekly jobs for you';B='New roles matching your profile';Expected='Job alerts'},
  @{S='Recruiter follow-up';B='I would like to discuss the product manager role';Expected='Recruiter follow-ups'},
  @{S='Application status';B='Could you share the status of your candidacy?';Expected='Review'}
)
foreach($case in $cases){$actual=Get-Classification $case.S $case.B 'recruiter@example.invalid';Assert-Test ($actual.Class -eq $case.Expected) "classification $($case.S)"}
$sensitive=Get-Classification 'Statement ready' 'Your credit card payment is due; account number ending 1234.' 'bank@example.invalid'
Assert-Test ($sensitive.Class -eq 'Delete candidate' -and $sensitive.Sensitive) 'sensitive non-job intersection remains a visible delete candidate'
Assert-Test ((Get-Classification 'Job opportunities' '' 'jobs@example.invalid' $true).Class -eq 'Review') 'attachment-only job candidate is held for review'
Assert-Test ((Get-Classification 'Offer: tips for your career' 'A generic newsletter' 'x').Class -ne 'Offers') 'generic offer wording does not trigger offer stage'
$canonicalVector=[ordered]@{schemaVersion=1;z=('Zo'+[char]0x00EB+' <candidate> & O''Brien');a=[ordered]@{html='A&B <x> "quoted"';timestamp='2026-09-30T07:00:00.1234567-07:00';instant='2026-10-01T03:04:05.7654321+08:00'};values=@($true,$false,$null,12.5)}
$canonicalVectorHash=Get-ManifestHash $canonicalVector
Assert-Test ($canonicalVectorHash -eq 'c889f2dc29a32f443d2349d0463006a32a9a341e5d7eecda04006ac7a71404a8') 'canonical hash is stable across PowerShell engines, Unicode, HTML punctuation, timezone, and fractional timestamps'
$canonicalReference=ConvertTo-CanonicalJsonReference $canonicalVector $true;$canonicalNative=[JobSearchIntelligence.CanonicalManifestJson]::Serialize($canonicalVector)
Assert-Test ($canonicalNative -ceq $canonicalReference) 'optimized canonical serializer is byte-for-byte equal to the PowerShell reference serializer'
$representative=[pscustomobject]@{z=@([pscustomobject]@{n=[int64]42;f=[single]1.25;d=[decimal]2.5;u=[datetimeoffset]'2026-10-01T05:00:00.0000001-07:00'});a=[ordered]@{controls=([string][char]0+[char]8+[char]11+[char]31);unicode='Zo'+[char]0x00EB;binary=[byte[]](0,127,255);null=$null};manifestHash='excluded-at-root'}
Assert-Test ([JobSearchIntelligence.CanonicalManifestJson]::Serialize($representative) -ceq (ConvertTo-CanonicalJsonReference $representative $true)) 'canonical serializer preserves escaped controls, UTF-8 text, PSObject properties, ordered maps, byte arrays, and typed numbers'
Assert-Test ((Get-ManifestHash ([ordered]@{subject='2026-09-30T07:00:00Z'})) -ne (Get-ManifestHash ([ordered]@{subject='2026-09-30T00:00:00-07:00'}))) 'date-looking owner text remains exact in approval hashes'
$manyLinks=(@(1..12|ForEach-Object{"https://jobs.example.invalid/role/$_"}) -join ' ')
Assert-Test ((Get-Classification 'Weekly jobs for you' ("New positions matching your preferences: "+$manyLinks) 'alerts@example.invalid').Class -eq 'Job alerts') 'link-rich job alerts are retained and URL count alone is not suspicious'
Assert-Test ((Get-Classification 'Monthly community newsletter' ("This month includes community updates, events, volunteer stories and local news. "+$manyLinks) 'news@example.invalid').Class -eq 'Delete candidate') 'complete non-job newsletters remain candidates despite numerous links'

# Synthetic inventory rows model duplicate and missing Internet Message-IDs. Physical rows survive independently.
$rows=@(
  [ordered]@{rowId='opaque-a';storeId='store-x';folderId='inbox-x';folder='Inbox';entryId='entry-a';internetMessageId='<duplicate@example.invalid>';receivedAt='2026-09-29T18:00:00Z';action='delete_to_deleted_items';class='Delete candidate';sensitive=$true;unread=$true;flagged=$false;attachmentCount=1},
  [ordered]@{rowId='opaque-b';storeId='store-x';folderId='junk-x';folder='Junk E-mail';entryId='entry-b';internetMessageId='<duplicate@example.invalid>';receivedAt='2026-10-01T08:00:00Z';action='delete_to_deleted_items';class='Delete candidate';sensitive=$false;unread=$false;flagged=$true;attachmentCount=0},
  [ordered]@{rowId='opaque-c';storeId='store-x';folderId='inbox-x';folder='Inbox';entryId='entry-c';internetMessageId='';receivedAt='2026-10-02T08:00:00Z';action='review';class='Review';sensitive=$false;unread=$false;flagged=$false;attachmentCount=0}
)
$inventory=@{storeId='store-x';inboxId='inbox-x';junkId='junk-x';complete=$true;items=$rows}
$manifest=New-InventoryManifest $inventory 'synthetic@example.invalid'
Assert-Test ($manifest.itemCount -eq 3) 'physical duplicates are retained as separate rows'
Assert-Test ($manifest.summary.sensitiveDeleteCount -eq 1 -and $manifest.summary.unreadDeleteCount -eq 1 -and $manifest.summary.flaggedDeleteCount -eq 1) 'deletion intersections are counted'
Assert-Test ($manifest.summary.preFloorDeleteCount -eq 1) 'pre-floor candidates remain visible'
$savedHash=$manifest.manifestHash
$manifest.items[0].action='move'
Assert-Test ((Get-ManifestHash $manifest) -ne $savedHash) 'any action-set change invalidates exact approval hash'
$manifest.items[0].action='delete_to_deleted_items'
$runtimePath=Join-Path $PSScriptRoot 'outlook-private-runtime.psm1';Import-Module $runtimePath -Force
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('outlook-cleanup-test-'+[guid]::NewGuid().ToString('N'))
$testContext=New-PrivateRuntimeContext -StateRoot $testRoot -Environment 'synthetic-test' -MailboxBinding 'synthetic-mailbox' -ConfigVersion 'test-v1' -ProtectBytes {param($Bytes,$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))} -UnprotectBytes {param($Bytes,$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
try{Save-ProtectedJsonAtomic -Path (Join-Path $testRoot 'canonical-vector.dpapi') -Value $canonicalVector -Context $testContext;$canonicalRoundTrip=Read-ProtectedJson -Path (Join-Path $testRoot 'canonical-vector.dpapi') -Context $testContext;Assert-Test ((Get-ManifestHash $canonicalRoundTrip) -eq $canonicalVectorHash -and $canonicalRoundTrip.z -ceq $canonicalVector.z) 'protected Unicode/date-like strings remain exact after JSON readback';Save-ProtectedJsonAtomic -Path (Join-Path $testRoot 'manifest.dpapi') -Value $manifest -Context $testContext;$roundTrip=Read-ProtectedJson -Path (Join-Path $testRoot 'manifest.dpapi') -Context $testContext;$roundHash=Get-ManifestHash $roundTrip;Assert-Test ($roundHash -eq $savedHash) "protected manifest filesystem roundtrip preserves canonical exact approval hash ($savedHash vs $roundHash)"
 $journal=[ordered]@{row1=[ordered]@{status='move_started';backupPath='private-backup';backupHash='fixture-hash';fidelity=[ordered]@{bodyHash='body';attachmentHashes=@('a')}}}
 Assert-Test ((Get-JournalStatus $journal 'row1') -eq 'move_started') 'journal engine reads the status field, not the state object'
 Set-JournalItem $journal 'row1' @{status='completed';afterEntryId='opaque-after'}
 Assert-Test ($journal.row1.backupHash -eq 'fixture-hash' -and $journal.row1.fidelity.bodyHash -eq 'body' -and $journal.row1.afterEntryId -eq 'opaque-after') 'phase transitions preserve verified backup evidence'
 $actionManifest=[pscustomobject]@{items=@([pscustomobject]@{rowId='row1';action='move'},[pscustomobject]@{rowId='row2';action='review'},[pscustomobject]@{rowId='row3';action='delete_to_deleted_items'})}
 Assert-Test ((Get-ActionRows $actionManifest).Count -eq 2) 'bounded action selection excludes review rows'
 $script:FakeClockNow=[datetime]'2026-10-11T12:00:00Z';$script:Clock={return $script:FakeClockNow};$deadline=$script:FakeClockNow.AddMinutes(5)
 Assert-Test (Test-ActionBudget 24 25 $deadline) 'injected clock permits work inside both action limits'
 Assert-Test (-not(Test-ActionBudget 25 25 $deadline)) 'injected clock enforces the 25-item action ceiling'
 $script:FakeClockNow=$deadline.AddMilliseconds(1);Assert-Test (-not(Test-ActionBudget 0 25 $deadline)) 'injected clock enforces the five-minute action ceiling';$script:Clock=$null
 $resumeManifest=[pscustomobject]@{storeId='store-ok';sources=@([pscustomobject]@{folderId='inbox-ok';defaultFolderId=6;folder='Inbox'},[pscustomobject]@{folderId='junk-ok';defaultFolderId=23;folder='Junk'});items=@([pscustomobject]@{rowId=('a'*64);storeId='store-ok';folderId='inbox-ok';folder='Inbox';action='move';class='Offers';destination='Offers'},[pscustomobject]@{rowId=('b'*64);storeId='store-ok';folderId='junk-ok';folder='Junk E-mail';action='delete_to_deleted_items';class='Delete candidate';destination='Delete candidate'})}
 $resumeJournal=[ordered]@{items=[ordered]@{}};$resumeJournal.items[('a'*64)]=[ordered]@{status='move_started';backupHash='preserved'};$resumeJournal.items[('b'*64)]=[ordered]@{status='backup_verified'}
 Assert-ManifestActionScope $resumeManifest
 Assert-Test ((Get-ActionRowsNeedingBackup $resumeManifest $resumeJournal.items).Count -eq 0) 'crash after move_started does not restart backup phase'
 Set-JournalItem $resumeJournal.items ('a'*64) @{status='completed'}
 Assert-Test ($resumeJournal.items[('a'*64)].backupHash -eq 'preserved') 'completed action retains encrypted backup journal evidence'
 $badScope=$resumeManifest.items[0].PSObject.Copy();$badScope.storeId='other-store';$scopeRejected=$false;try{Assert-ManifestActionScope ([pscustomobject]@{storeId='store-ok';sources=$resumeManifest.sources;items=@($badScope)})}catch{$scopeRejected=$true};Assert-Test $scopeRejected 'owner-approved manifest hash cannot expand action to another store'
 Assert-Test ((Get-CandidateSetHash (Get-ActionRows $actionManifest)) -eq (Get-CandidateSetHash (Get-ActionRows $actionManifest))) 'candidate capture set hash is deterministic'
$captureFixture=[pscustomobject]@{items=@(
 [pscustomobject]@{rowId='floor-receipt';action='move';class='Application receipts';receivedAt='2026-09-30T07:00:00.0000000Z'},
 [pscustomobject]@{rowId='old-interview';action='move';class='Interviews';receivedAt='2026-09-30T06:59:59.9999999Z'},
 [pscustomobject]@{rowId='alerts';action='move';class='Job alerts';receivedAt='2026-10-01T00:00:00Z'},
 [pscustomobject]@{rowId='nonjob';action='delete_to_deleted_items';class='Delete candidate';receivedAt='2026-10-01T00:00:00Z'},
 [pscustomobject]@{rowId='uncertain';action='review';class='Review';receivedAt='2026-10-01T00:00:00Z'})}
$captureRows=Get-RequiredCaptureRows $captureFixture
Assert-Test ($captureRows.Count -eq 1 -and $captureRows[0].rowId -eq 'floor-receipt') 'rollout capture is exactly in-floor job evidence, excluding older mail, alerts, non-job deletions and Review'
$floorInventory=[pscustomobject]@{storeId='store-floor';inboxId='inbox-floor';junkId='junk-floor';complete=$true;items=@(
 [pscustomobject]@{rowId='floor';storeId='store-floor';folderId='inbox-floor';folder='Inbox';action='delete_to_deleted_items';receivedAt='2026-09-30T07:00:00.0000000Z';class='Delete candidate';sensitive=$false;unread=$false;flagged=$false;attachmentCount=0},
 [pscustomobject]@{rowId='before';storeId='store-floor';folderId='inbox-floor';folder='Inbox';action='delete_to_deleted_items';receivedAt='2026-09-30T06:59:59.9999999Z';class='Delete candidate';sensitive=$false;unread=$false;flagged=$false;attachmentCount=0})}
$floorManifest=New-InventoryManifest $floorInventory 'floor@example.invalid'
Assert-Test ($floorManifest.summary.preFloorDeleteCount -eq 1 -and $floorManifest.summary.byClass['Delete candidate'] -eq 2 -and $floorManifest.utilityVersion -and $floorManifest.ruleVersion) 'fractional UTC floor comparison, ordered-row class counts, and manifest rule/tool versions are explicit'
 $expectedFidelity=[pscustomobject]@{subject='Fixture';bodyHash=(Get-StringHash 'Fixture body for backup verification.');receivedAt=([datetime]'2026-10-01T12:00:00Z').ToUniversalTime().ToString('o');unread=$true;flagStatus=2;categories='Fixture';wasSent=$true;attachmentCount=0;attachmentHashes=@()}
 $fidelityItem=[pscustomobject]@{Subject='Fixture';Body='Fixture body for backup verification.';ReceivedTime=[datetime]'2026-10-01T12:00:00Z';UnRead=$true;FlagStatus=2;Categories='Fixture';Sent=$true;Attachments=[pscustomobject]@{Count=0}}
 $testScratch=Join-Path $testRoot 'scratch';Test-ItemBackupFidelity $fidelityItem $expectedFidelity $testScratch $testRoot $testContext
 $fidelityItem.Body='Changed fixture body.';$failedAsExpected=$false;try{Test-ItemBackupFidelity $fidelityItem $expectedFidelity $testScratch $testRoot $testContext}catch{$failedAsExpected=$true}
 $tempRejected=$false;try{Assert-ScratchRoot ([IO.Path]::GetTempPath()) $testRoot $testContext}catch{$tempRejected=$true};Assert-Test $tempRejected 'scratch guard rejects shared TEMP before ACL mutation'
 Assert-Test $failedAsExpected 'post-move fidelity verification rejects changed body state'
 $backupRunRoot=Join-Path $testRoot 'engine-run';$backupItem=[pscustomobject]@{Subject='Backup fixture';Body='Synthetic backup engine body.';ReceivedTime=[datetime]'2026-10-01T12:00:00Z';UnRead=$true;FlagStatus=2;Categories='Synthetic';Sent=$true;Attachments=[pscustomobject]@{Count=0}}
 $backupItem|Add-Member ScriptMethod SaveAs {param($Path,$Format);[IO.File]::WriteAllBytes($Path,[Text.Encoding]::Unicode.GetBytes('synthetic-msg-fixture'))}
 $sourceAttachment=[pscustomobject]@{Bytes=[Text.Encoding]::UTF8.GetBytes('attachment bytes one')};$sourceAttachment|Add-Member ScriptMethod SaveAsFile {param($Path);[IO.File]::WriteAllBytes($Path,$this.Bytes)};$backupItem.Attachments=New-FakeItems @($sourceAttachment)
 $script:MockOpenedMsg=$backupItem;$fakeNamespace=[pscustomobject]@{};$fakeNamespace|Add-Member ScriptMethod OpenSharedItem {param($Path)return $script:MockOpenedMsg};$fakeSession=[pscustomobject]@{Namespace=$fakeNamespace}
 $backupRow=[pscustomobject]@{rowId=('c'*64)};$backup=Save-VerifiedMsgBackup $fakeSession $backupItem $backupRow $backupRunRoot $testContext
 $decryptedBackup=Read-ProtectedBytes -Path $backup.path -Context $testContext
 Assert-Test ((Get-BytesHash $decryptedBackup) -eq $backup.sha256 -and $backup.fidelity.bodyHash -eq (Get-StringHash $backupItem.Body) -and $backup.fidelity.attachmentCount -eq 1 -and $backup.fidelity.attachmentHashes.Count -eq 1) 'backup engine encrypts MSG and verifies reopened body and attachment fidelity'
 $changedAttachment=[pscustomobject]@{Bytes=[Text.Encoding]::UTF8.GetBytes('different attachment bytes')};$changedAttachment|Add-Member ScriptMethod SaveAsFile {param($Path);[IO.File]::WriteAllBytes($Path,$this.Bytes)};$openedChanged=[pscustomobject]@{Subject=$backupItem.Subject;Body=$backupItem.Body;ReceivedTime=$backupItem.ReceivedTime;UnRead=$backupItem.UnRead;FlagStatus=$backupItem.FlagStatus;Categories=$backupItem.Categories;Sent=$backupItem.Sent;Attachments=(New-FakeItems @($changedAttachment))};$script:MockOpenedMsg=$openedChanged;$attachmentMismatchRejected=$false;try{Test-MsgRoundTrip $fakeSession $backupItem $backup.path (Join-Path $backupRunRoot 'scratch') $backupRunRoot $testContext}catch{$attachmentMismatchRejected=$true};Assert-Test $attachmentMismatchRejected 'MSG restore proof rejects altered attachment bytes even when count and body match'
 $backupState=[ordered]@{backupPath=$backup.path;backupHash=$backup.sha256};Assert-EncryptedBackup $backupState $testContext
 $backupState.backupHash='tampered-hash';$backupRejected=$false;try{Assert-EncryptedBackup $backupState $testContext}catch{$backupRejected=$true};Assert-Test $backupRejected 'action/recovery gate rejects a changed encrypted backup hash'
 $script:MockOpenedMsg=$null
 }finally{if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse -Force}}
Assert-Test ($script:InboxId -eq 6 -and $script:JunkId -eq 23 -and $script:DeletedId -eq 3) 'default folder identifiers are explicit'
& (Join-Path $PSScriptRoot 'test-outlook-cleanup-engine.ps1')

# Injected Outlook shape exercises store selection and direct Inbox/Junk enumeration with no Outlook process.
$mail=[pscustomobject]@{Class=43;Subject='Application received';Body='We received your application for the engineer position.';SenderEmailAddress='hr@example.invalid';EntryID='physical-1';InternetMessageID='<same@example.invalid>';ConversationID='thread-1';ReceivedTime=[datetime]'2026-10-01T12:00:00Z';LastModificationTime=[datetime]'2026-10-01T12:01:00Z';Attachments=[pscustomobject]@{Count=0};UnRead=$true;FlagStatus=2;Categories=''}
$other=[pscustomobject]@{Class=43;Subject='Personal newsletter';Body='A complete unrelated newsletter with enough text for a conservative decision.';SenderEmailAddress='news@example.invalid';EntryID='physical-2';InternetMessageID='<same@example.invalid>';ConversationID='thread-2';ReceivedTime=[datetime]'2026-10-02T12:00:00Z';LastModificationTime=[datetime]'2026-10-02T12:01:00Z';Attachments=[pscustomobject]@{Count=0};UnRead=$false;FlagStatus=0;Categories=''}
$inbox=New-FakeFolder 'inbox-id' @($mail);$junk=New-FakeFolder 'junk-id' @($other);$store=New-FakeStore 'store-id' $inbox $junk
$accounts=New-FakeAccounts @((New-FakeAccount 'other@example.invalid' (New-FakeStore 'other-store' (New-FakeFolder 'other-inbox' @()) (New-FakeFolder 'other-junk' @()))),(New-FakeAccount 'owner@example.invalid' $store))
$script:FakeNamespaceForFactory=New-FakeNamespace $accounts;$script:OutlookFactory={ New-FakeOutlook $script:FakeNamespaceForFactory }
$liveShape=Get-OutlookInventory 'owner@example.invalid';$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null
Assert-Test ($liveShape.storeId -eq 'store-id' -and $liveShape.items.Count -eq 2) 'injected exact-account inventory includes Inbox and Junk physical items'
Assert-Test ($liveShape.items[0].folder -eq 'Inbox' -and $liveShape.items[1].folder -eq 'Junk E-mail') 'inventory scopes to direct default Inbox and Junk only'
Assert-Test ($liveShape.items[0].action -eq 'move' -and $liveShape.items[1].action -eq 'delete_to_deleted_items') 'injected item state maps to proposed actions'
$script:FakeNamespaceForFactory=New-FakeNamespace $accounts;$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory};$cleanupSession=Get-CleanupSession 'owner@example.invalid';Assert-Test ($cleanupSession.StoreId -eq 'store-id' -and $cleanupSession.Inbox.EntryID -eq 'inbox-id' -and $cleanupSession.Junk.EntryID -eq 'junk-id' -and $cleanupSession.Deleted.EntryID -eq 'store-id-deleted') 'cleanup session resolves the exact SMTP account DeliveryStore and only its default folders';Close-CleanupSession $cleanupSession;$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null
$bodyFault=[pscustomobject]@{Class=43;Subject='Personal newsletter';SenderEmailAddress='news@example.invalid';EntryID='body-fault';ReceivedTime=[datetime]'2026-10-01T00:00:00Z';Attachments=[pscustomobject]@{Count=0};UnRead=$false;FlagStatus=0;Categories=''};$bodyFault|Add-Member ScriptProperty Body {throw 'synthetic body unavailable'}
$bodyFaultRecord=Get-ItemRecord $bodyFault 'fault-store' 'fault-inbox' 'Inbox';Assert-Test ($bodyFaultRecord.bodyLength -eq 0 -and $bodyFaultRecord.class -eq 'Review' -and $bodyFaultRecord.action -eq 'review') 'empty or unavailable message content cannot become a delete candidate'
$permissionItem=[pscustomobject]@{Class=43;Subject='Personal newsletter';Body='A complete newsletter with enough content to decide this message is unrelated.';SenderEmailAddress='news@example.invalid';EntryID='permission-protected';InternetMessageID='';ConversationID='';ReceivedTime=[datetime]'2026-10-01T00:00:00Z';LastModificationTime=[datetime]'2026-10-01T00:01:00Z';Attachments=[pscustomobject]@{Count=0};UnRead=$false;FlagStatus=0;Categories='';Permission=1;MessageClass='IPM.Note'}
$permissionRecord=Get-ItemRecord $permissionItem 'protected-store' 'protected-inbox' 'Inbox';Assert-Test ($permissionRecord.protected -and $permissionRecord.class -eq 'Review' -and $permissionRecord.action -eq 'review') 'nonzero Outlook Permission protects restricted mail from automatic classification'
$smimeItem=[pscustomobject]@{};foreach($property in $permissionItem.PSObject.Properties){$smimeItem|Add-Member NoteProperty $property.Name $property.Value};$smimeItem.Permission=0;$smimeItem.MessageClass='IPM.Note.SMIME';$smimeRecord=Get-ItemRecord $smimeItem 'protected-store' 'protected-inbox' 'Inbox';Assert-Test ($smimeRecord.protected -and $smimeRecord.class -eq 'Review' -and $smimeRecord.action -eq 'review') 'S/MIME mail is retained for owner review regardless of readable body text'
Add-Type -TypeDefinition @'
public sealed class SyntheticCleanupDeniedPermissionItem {
  public int Class { get { return 43; } }
  public string Subject { get { return "Personal newsletter"; } }
  public string Body { get { return "A complete newsletter with enough content to decide this message is unrelated."; } }
  public string SenderEmailAddress { get { return "news@example.invalid"; } }
  public string EntryID { get { return "permission-denied"; } }
  public string InternetMessageID { get { return ""; } }
  public string ConversationID { get { return ""; } }
  public System.DateTime ReceivedTime { get { return new System.DateTime(2026,10,1,0,0,0,System.DateTimeKind.Utc); } }
  public System.DateTime LastModificationTime { get { return new System.DateTime(2026,10,1,0,1,0,System.DateTimeKind.Utc); } }
  public object Attachments { get { return new System.Management.Automation.PSObject(); } }
  public bool UnRead { get { return false; } }
  public int FlagStatus { get { return 0; } }
  public string Categories { get { return ""; } }
  public int Permission { get { throw new System.InvalidOperationException("synthetic permission access denied"); } }
  public string MessageClass { get { return "IPM.Note"; } }
}
'@
$deniedPermissionItem=[SyntheticCleanupDeniedPermissionItem]::new();$deniedPermissionRecord=Get-ItemRecord $deniedPermissionItem 'protected-store' 'protected-inbox' 'Inbox';Assert-Test ($deniedPermissionRecord.protected -and $deniedPermissionRecord.class -eq 'Review' -and $deniedPermissionRecord.action -eq 'review') ("unreadable protection metadata fails closed to owner review ($($deniedPermissionRecord.protected),$($deniedPermissionRecord.class),$($deniedPermissionRecord.action))")
$attachmentFault=[pscustomobject]@{Class=43;Subject='Personal newsletter';Body='A complete newsletter with enough text to decide this is unrelated.';SenderEmailAddress='news@example.invalid';EntryID='attachment-fault';ReceivedTime=[datetime]'2026-10-01T00:00:00Z';UnRead=$false;FlagStatus=0;Categories=''};$failingAttachments=[pscustomobject]@{Count=1};$failingAttachments|Add-Member ScriptMethod Item {param($Index)throw 'synthetic attachment metadata unavailable'};$attachmentFault|Add-Member NoteProperty Attachments $failingAttachments;$attachmentFaultRecord=Get-ItemRecord $attachmentFault 'fault-store' 'fault-inbox' 'Inbox';Assert-Test ($attachmentFaultRecord.bodyStatus -eq 'incomplete' -and $attachmentFaultRecord.class -eq 'Review') 'attachment metadata enumeration failure forces a Review row'
$metadataAttachment=[pscustomobject]@{FileName='synthetic-attachment.txt';Size=37;Type=1};$metadataItem=[pscustomobject]@{Class=43;Subject='Application received';Body='We received your application for an engineer position.';SenderEmailAddress='jobs@example.invalid';EntryID='metadata-item';InternetMessageID='<metadata@example.invalid>';ConversationID='metadata-thread';ReceivedTime=[datetime]'2026-10-01T00:00:00Z';Attachments=(New-FakeItems @($metadataAttachment));UnRead=$false;FlagStatus=0;Categories=''};$accessorFixture=[pscustomobject]@{};$accessorFixture|Add-Member ScriptMethod GetProperty {param($Name)return ,[byte[]](1,2,3)};$metadataItem|Add-Member NoteProperty PropertyAccessor $accessorFixture;$metadataRecord=Get-ItemRecord $metadataItem 'metadata-store' 'metadata-inbox' 'Inbox';Assert-Test ($metadataRecord.attachmentCount -eq 1 -and $metadataRecord.attachmentMetadata[0].Name -eq 'synthetic-attachment.txt' -and $metadataRecord.searchKey -eq [Convert]::ToBase64String([byte[]](1,2,3))) 'physical inventory retains private attachment metadata and MAPI search key'
$inventoryRoot=Join-Path ([IO.Path]::GetTempPath()) ('outlook-inventory-test-'+[guid]::NewGuid().ToString('N'))
$inventoryContext=New-PrivateRuntimeContext -StateRoot $inventoryRoot -Environment 'outlook-cleanup' -MailboxBinding (Get-StringHash 'owner@example.invalid') -ConfigVersion 'cleanup-v1' -ProtectBytes {param($Bytes,$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))} -UnprotectBytes {param($Bytes,$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
try{$script:StateRoot=$inventoryRoot;$script:Mailbox='owner@example.invalid';$script:ManifestPath=$null;$script:RuntimeContextFactory={param($Root,$Environment,$Binding,$Version)return $inventoryContext};$script:FakeNamespaceForFactory=New-FakeNamespace $accounts;$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory};$inventoryResult=Invoke-Inventory;$storedInventory=Read-ProtectedJson -Path $inventoryResult.ManifestPath -Context $inventoryContext;Assert-Test ($inventoryResult.PhysicalItemCount -eq 2 -and $storedInventory.itemCount -eq 2 -and $storedInventory.manifestHash -eq $inventoryResult.ManifestHash -and $inventoryResult.EnumerationComplete) 'Inventory mode writes a protected manifest and content-free count/hash receipt'}finally{if(Test-Path -LiteralPath $inventoryRoot){Remove-Item -LiteralPath $inventoryRoot -Recurse -Force};$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null;$script:RuntimeContextFactory=$null;$script:StateRoot=$null;$script:ManifestPath=$null}
$duplicateAccounts=New-FakeAccounts @((New-FakeAccount 'owner@example.invalid' $store),(New-FakeAccount 'owner@example.invalid' $store));$script:FakeNamespaceForFactory=New-FakeNamespace $duplicateAccounts;$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory};$ambiguousInventoryRejected=$false;try{Get-OutlookInventory 'owner@example.invalid'|Out-Null}catch{$ambiguousInventoryRejected=$true};$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null
Assert-Test $ambiguousInventoryRejected 'inventory refuses ambiguous exact SMTP account matches'
$inaccessibleItems=[pscustomobject]@{Count=1};$inaccessibleItems|Add-Member ScriptMethod Item {param($Index)throw 'synthetic inaccessible row'};$inaccessibleInbox=New-FakeFolder 'inaccessible-inbox' @();$inaccessibleInbox.Items=$inaccessibleItems;$inaccessibleJunk=New-FakeFolder 'inaccessible-junk' @();$inaccessibleStore=New-FakeStore 'inaccessible-store' $inaccessibleInbox $inaccessibleJunk;$script:FakeNamespaceForFactory=New-FakeNamespace (New-FakeAccounts @((New-FakeAccount 'owner@example.invalid' $inaccessibleStore)));$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory};$inaccessibleInventory=Get-OutlookInventory 'owner@example.invalid';$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null;Assert-Test ($inaccessibleInventory.items.Count -eq 1 -and $inaccessibleInventory.items[0].inaccessible -and -not $inaccessibleInventory.complete -and -not $inaccessibleInventory.evidenceComplete) 'inaccessible physical row is retained once and makes both completeness checks false'
$unsupported=@(1..6|ForEach-Object{[pscustomobject]@{Class=42;EntryID=('unsupported-'+$_)}})
$unsupportedInbox=New-FakeFolder 'unsupported-inbox' $unsupported;$unsupportedJunk=New-FakeFolder 'unsupported-junk' @();$unsupportedStore=New-FakeStore 'unsupported-store' $unsupportedInbox $unsupportedJunk
$script:FakeNamespaceForFactory=New-FakeNamespace (New-FakeAccounts @((New-FakeAccount 'owner@example.invalid' $unsupportedStore)));$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory}
$unsupportedInventory=Get-OutlookInventory 'owner@example.invalid';$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null;$unsupportedManifest=New-InventoryManifest $unsupportedInventory 'owner@example.invalid'
Assert-Test ($unsupportedInventory.items.Count -eq 6 -and $unsupportedManifest.summary.byClass['Review'] -eq 6 -and $unsupportedInventory.complete -and -not $unsupportedInventory.evidenceComplete) 'unsupported physical items count once as Review and separate enumeration completeness from evidence completeness'
$progressRows=@(1..500|ForEach-Object{[pscustomobject]@{Class=42;EntryID=('progress-'+$_)}});$progressInbox=New-FakeFolder 'progress-inbox' $progressRows;$progressJunk=New-FakeFolder 'progress-junk' @();$progressStore=New-FakeStore 'progress-store' $progressInbox $progressJunk;$script:FakeNamespaceForFactory=New-FakeNamespace (New-FakeAccounts @((New-FakeAccount 'owner@example.invalid' $progressStore)));$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory};$progressInventory=Get-OutlookInventory 'owner@example.invalid';$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null;Assert-Test ($progressInventory.items.Count -eq 500 -and $progressInventory.complete -and -not $progressInventory.evidenceComplete) 'large physical inventory executes bounded content-free progress reporting'
$mutatingItems=[pscustomobject]@{Rows=[Collections.Generic.List[object]]::new()};$mutatingItems.Rows.Add($metadataItem);$mutatingItems|Add-Member ScriptProperty Count {$this.Rows.Count};$mutatingItems|Add-Member ScriptMethod Item {param($Index)if($this.Rows.Count -eq 1){$this.Rows.Add($metadataItem)};return $this.Rows[$Index-1]};$mutatingInbox=New-FakeFolder 'mutating-inbox' @();$mutatingInbox.Items=$mutatingItems;$mutatingJunk=New-FakeFolder 'mutating-junk' @();$mutatingStore=New-FakeStore 'mutating-store' $mutatingInbox $mutatingJunk;$script:FakeNamespaceForFactory=New-FakeNamespace (New-FakeAccounts @((New-FakeAccount 'owner@example.invalid' $mutatingStore)));$script:OutlookFactory={New-FakeOutlook $script:FakeNamespaceForFactory};$mutatingInventory=Get-OutlookInventory 'owner@example.invalid';$script:OutlookFactory=$null;$script:FakeNamespaceForFactory=$null;Assert-Test ($mutatingInventory.items.Count -eq 1 -and -not $mutatingInventory.complete -and -not $mutatingInventory.evidenceComplete) 'count drift during folder enumeration invalidates the physical snapshot'
$reviewRoot=Join-Path ([IO.Path]::GetTempPath()) ('outlook-review-test-'+[guid]::NewGuid().ToString('N'));$reviewRun=Join-Path (Join-Path $reviewRoot 'mailbox-cleanup') 'fixture-run';[IO.Directory]::CreateDirectory($reviewRun)|Out-Null
$script:StateRoot=$reviewRoot;$script:Mailbox='fixture@example.invalid';$reviewContext=New-PrivateRuntimeContext -StateRoot $reviewRoot -Environment 'outlook-cleanup' -MailboxBinding (Get-StringHash $script:Mailbox) -ConfigVersion 'cleanup-v1' -ProtectBytes {param($Bytes,$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))} -UnprotectBytes {param($Bytes,$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
$reviewManifest=[ordered]@{schema='outlook-cleanup-manifest.v1';schemaVersion=1;storeId='synthetic-store';complete=$true;itemCount=2;summary=@{preFloorDeleteCount=1;sensitiveDeleteCount=0};items=@(
  [ordered]@{rowId=('d'*64);folder='Inbox';entryId='private-id';internetMessageId='';receivedAt='2026-10-01T00:00:00Z';class='Delete candidate';confidence='high';reason='no_job_evidence';action='delete_to_deleted_items';destination='Delete candidate';subject='<script>alert("x")</script>';sender='fixture@example.invalid';unread=$false;flagged=$false;sensitive=$false;attachmentCount=0;attachmentMetadata=@();body='must not appear in review'},
  [ordered]@{rowId=('e'*64);folder='Inbox';class='Review';reason='item_inaccessible';action='review'}
)};$reviewManifest.manifestHash=Get-ManifestHash $reviewManifest
$script:ManifestPath=Join-Path $reviewRun 'inventory.manifest.dpapi';$script:ReviewOutputPath=Join-Path $reviewRun 'review.html';$script:RuntimeContextFactory={param($Root,$Environment,$Binding,$Version)return $reviewContext}
try{
  Save-ProtectedJsonAtomic -Path $script:ManifestPath -Value $reviewManifest -Context $reviewContext
  $reviewResult=Invoke-Review;$reviewHtml=[IO.File]::ReadAllText($script:ReviewOutputPath)
  Assert-Test ($reviewHtml.Contains('&lt;script&gt;') -and -not $reviewHtml.Contains('<script>') -and -not $reviewHtml.Contains('must not appear in review')) 'private static review escapes HTML and omits message bodies'
  Assert-Test ($reviewHtml.Contains('item_inaccessible') -and $reviewHtml.Contains('<td>Review</td>') -and $reviewResult.PhysicalItemCount -eq 2) 'review renders incomplete physical rows with safe defaults for missing optional metadata'
  Assert-Test ($reviewResult.ManifestHash -eq $reviewManifest.manifestHash -and (Test-Path -LiteralPath $reviewResult.ReviewPath)) 'review mode reports only private path, count, and exact manifest hash'
  $savedManifestPath=$script:ManifestPath;$savedReviewPath=$script:ReviewOutputPath
  $script:ManifestPath=$null;$missingReviewInputsRejected=$false;try{Invoke-Review|Out-Null}catch{$missingReviewInputsRejected=$true}
  Assert-Test $missingReviewInputsRejected 'review requires both an encrypted manifest and an explicit private output path'
  $script:ManifestPath=$savedManifestPath;$script:ReviewOutputPath=Join-Path ([IO.Path]::GetTempPath()) 'outside-cleanup-review.html'
  $outsideReviewRejected=$false;try{Invoke-Review|Out-Null}catch{$outsideReviewRejected=$true}
  Assert-Test ($outsideReviewRejected -and -not(Test-Path -LiteralPath $script:ReviewOutputPath)) 'review output outside the owner private root is rejected before file creation'
  $script:ReviewOutputPath=$savedReviewPath
  $tamperedManifest=ConvertTo-MutableMap $reviewManifest;$tamperedManifest.items[0].subject='changed after inventory'
  Save-ProtectedJsonAtomic -Path $savedManifestPath -Value $tamperedManifest -Context $reviewContext
  $tamperedReviewRejected=$false;try{Invoke-Review|Out-Null}catch{$tamperedReviewRejected=$true}
  Assert-Test $tamperedReviewRejected 'review rejects content changed after the protected manifest hash was approved'
}finally{if(Test-Path -LiteralPath $reviewRoot){Remove-Item -LiteralPath $reviewRoot -Recurse -Force};$script:StateRoot=$null;$script:ManifestPath=$null;$script:ReviewOutputPath=$null;$script:RuntimeContextFactory=$null}

$repoPath=[IO.Directory]::GetParent($PSScriptRoot).FullName
$repoPrivateStateRejected=$false;try{Assert-PrivateRoot $repoPath|Out-Null}catch{$repoPrivateStateRejected=$true}
$repoChildPrivateStateRejected=$false;try{Assert-PrivateRoot (Join-Path $repoPath 'scripts/private-state-test')|Out-Null}catch{$repoChildPrivateStateRejected=$true}
Assert-Test ($repoPrivateStateRejected -and $repoChildPrivateStateRejected) 'private state root blocks both the repository and descendants before creating files'
$externalPrivateRoot=Join-Path ([IO.Path]::GetTempPath()) ('cleanup-path-test-'+[guid]::NewGuid().ToString('N'))
$externalContext=New-PrivateRuntimeContext -StateRoot $externalPrivateRoot -Environment 'outlook-cleanup' -MailboxBinding (Get-StringHash 'path@example.invalid') -ConfigVersion 'cleanup-v1'
$privatePathRejected=$false;try{Assert-CleanupPrivatePath (Join-Path ([IO.Path]::GetTempPath()) 'outside-cleanup-state') $externalContext}catch{$privatePathRejected=$true}
$manifestRunRejected=$false;try{Get-ManifestRunRoot (Join-Path $externalPrivateRoot 'outside.manifest.dpapi') $externalPrivateRoot|Out-Null}catch{$manifestRunRejected=$true}
Assert-Test ($privatePathRejected -and $manifestRunRejected) 'private artifact and action manifest paths must remain inside their exact state and cleanup run roots'
$savedContextFactory=$script:RuntimeContextFactory
try{
  $script:RuntimeContextFactory=$null
  $defaultContext=New-CleanupRuntimeContext $externalPrivateRoot 'outlook-cleanup' (Get-StringHash 'owner-a@example.invalid') 'cleanup-v1'
  $otherMailboxContext=New-CleanupRuntimeContext $externalPrivateRoot 'outlook-cleanup' (Get-StringHash 'owner-b@example.invalid') 'cleanup-v1'
  Assert-Test ($defaultContext.StateRoot -eq [IO.Path]::GetFullPath($externalPrivateRoot) -and $defaultContext.Environment -eq 'outlook-cleanup' -and $defaultContext.MailboxBinding -eq (Get-StringHash 'owner-a@example.invalid') -and $defaultContext.ConfigVersion -eq 'cleanup-v1' -and [Convert]::ToBase64String($defaultContext.Entropy) -ne [Convert]::ToBase64String($otherMailboxContext.Entropy)) 'default runtime context binds private root, environment, mailbox and config into distinct protection entropy'
}finally{$script:RuntimeContextFactory=$savedContextFactory}

# Taxonomy creation uses the same COM-shaped seam as inventory, but runs only against disposable objects.
function New-TaxonomyCollection([object[]]$Initial=@()) {
  $list=[Collections.Generic.List[object]]::new();foreach($entry in $Initial){$list.Add($entry)}
  $collection=[pscustomobject]@{Rows=$list;AddCount=0;FailAfter=-1};$collection|Add-Member ScriptProperty Count {$this.Rows.Count}
  $collection|Add-Member ScriptMethod Item {param($Index)return $this.Rows[$Index-1]}
  $collection|Add-Member ScriptMethod Add {param($Name)if($Name -cne 'Job Search' -and $script:TaxonomyFailAfter -ge 0 -and $script:TaxonomyChildAdds -ge $script:TaxonomyFailAfter){throw 'injected taxonomy Add failure'};$this.AddCount++;if($Name -cne 'Job Search'){$script:TaxonomyChildAdds++};$folder=New-TaxonomyFolder $Name ('entry-'+[guid]::NewGuid().ToString('N'));$this.Rows.Add($folder);return $folder}
  return $collection
}
function New-TaxonomyFolder([string]$Name,[string]$EntryId) {
  $folder=[pscustomobject]@{Name=$Name;EntryID=$EntryId;Items=[pscustomobject]@{Count=0};Folders=(New-TaxonomyCollection)}
  return $folder
}
function New-TaxonomyWorld([object[]]$RootFolders=@()) {
  $inbox=New-TaxonomyFolder 'Inbox' 'inbox-taxonomy';$inbox.Folders=New-TaxonomyCollection $RootFolders
  $junk=New-TaxonomyFolder 'Junk' 'junk-taxonomy';$store=[pscustomobject]@{StoreID='store-taxonomy';Inbox=$inbox;Junk=$junk};$store|Add-Member ScriptMethod GetDefaultFolder {param($Id)if($Id -eq 6){return $this.Inbox};if($Id -eq 23){return $this.Junk};throw 'out-of-scope folder'}
  $account=[pscustomobject]@{SmtpAddress='fixture@example.invalid';DeliveryStore=$store};$accounts=New-FakeAccounts @($account);$namespace=New-FakeNamespace $accounts
  return [pscustomobject]@{Application=(New-FakeOutlook $namespace);Namespace=$namespace;Accounts=$accounts;Inbox=$inbox;RootFolders=$inbox.Folders}
}
function New-TaxonomyMutex {
  $mutex=[pscustomobject]@{Released=$false;Disposed=$false};$mutex|Add-Member ScriptMethod WaitOne {param($Timeout)return $true};$mutex|Add-Member ScriptMethod ReleaseMutex {$this.Released=$true};$mutex|Add-Member ScriptMethod Dispose {$this.Disposed=$true};return $mutex
}
$taxonomyRoot=Join-Path ([IO.Path]::GetTempPath()) ('outlook-taxonomy-test-'+[guid]::NewGuid().ToString('N'));$taxonomyRun=Join-Path (Join-Path $taxonomyRoot 'mailbox-cleanup') 'fixture-run';[IO.Directory]::CreateDirectory($taxonomyRun)|Out-Null
$taxonomyContext=New-PrivateRuntimeContext -StateRoot $taxonomyRoot -Environment 'outlook-cleanup' -MailboxBinding (Get-StringHash 'fixture@example.invalid') -ConfigVersion 'cleanup-v1' -ProtectBytes {param($Bytes,$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))} -UnprotectBytes {param($Bytes,$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
$taxonomyManifest=New-InventoryManifest ([pscustomobject]@{storeId='store-taxonomy';inboxId='inbox-taxonomy';junkId='junk-taxonomy';complete=$true;evidenceComplete=$true;items=@()}) 'fixture@example.invalid'
$taxonomyPath=Join-Path $taxonomyRun 'inventory.manifest.dpapi'
try {
  Save-ProtectedJsonAtomic -Path $taxonomyPath -Value $taxonomyManifest -Context $taxonomyContext
  $script:StateRoot=$taxonomyRoot;$script:Mailbox='fixture@example.invalid';$script:ManifestPath=$taxonomyPath;$script:ApprovedFoldersPath=Join-Path $taxonomyRoot 'approved-folders.dpapi';$script:RuntimeContextFactory={param($Root,$Environment,$Binding,$Version)return $taxonomyContext};$script:TaxonomyMutexFactory={New-TaxonomyMutex};$script:TaxonomyFailAfter=-1;$script:TaxonomyChildAdds=0
  $world=New-TaxonomyWorld;$script:TaxonomySessionFactory={return $world};$createdTaxonomy=Invoke-CreateTaxonomy
  $approved=Read-ProtectedJson -Path $script:ApprovedFoldersPath -Context $taxonomyContext
  Assert-Test ($createdTaxonomy.FolderCount -eq 8 -and $world.RootFolders.Count -eq 1 -and $approved.folders.Count -eq 8 -and $world.RootFolders.Item(1).Folders.AddCount -eq 8) 'taxonomy creates only exact empty root and eight direct children with per-add journal writes'
  Remove-Item -LiteralPath $script:ApprovedFoldersPath -Force
  $collisionWorld=New-TaxonomyWorld @(New-TaxonomyFolder 'JobSearch' 'collision-root');$script:TaxonomySessionFactory={return $collisionWorld};$collisionRejected=$false;try{Invoke-CreateTaxonomy}catch{$collisionRejected=$true}
  Assert-Test ($collisionRejected -and $collisionWorld.RootFolders.Count -eq 1 -and -not (Test-Path -LiteralPath (Join-Path $taxonomyRoot 'approved-folders.dpapi'))) 'near-match root collision fails before creating folders or approved config'
  $nonemptyRoot=New-TaxonomyFolder 'Job Search' 'root-nonempty';$nonemptyRoot.Items=[pscustomobject]@{Count=1};$nonemptyWorld=New-TaxonomyWorld @($nonemptyRoot);$script:TaxonomySessionFactory={return $nonemptyWorld};$nonemptyRejected=$false;try{Invoke-CreateTaxonomy}catch{$nonemptyRejected=$true}
  Assert-Test ($nonemptyRejected -and $nonemptyRoot.Folders.Count -eq 0) 'pre-existing nonempty exact root is left unchanged'
  $wrongCaseRoot=New-TaxonomyFolder 'job Search' 'root-wrong-case';$wrongCaseWorld=New-TaxonomyWorld @($wrongCaseRoot);$script:TaxonomySessionFactory={return $wrongCaseWorld};$wrongCaseRejected=$false;try{Invoke-CreateTaxonomy}catch{$wrongCaseRejected=$true};Assert-Test ($wrongCaseRejected -and $wrongCaseWorld.RootFolders.Count -eq 1) 'existing root with non-exact approved casing is not duplicated or changed'
  $unapprovedRoot=New-TaxonomyFolder 'Job Search' 'root-unapproved';$unapprovedRoot.Folders=New-TaxonomyCollection @(New-TaxonomyFolder 'Personal' 'unapproved-child');$unapprovedWorld=New-TaxonomyWorld @($unapprovedRoot);$script:TaxonomySessionFactory={return $unapprovedWorld};$unapprovedRejected=$false;try{Invoke-CreateTaxonomy}catch{$unapprovedRejected=$true};Assert-Test ($unapprovedRejected -and $unapprovedRoot.Folders.Count -eq 1) 'unapproved pre-existing child blocks taxonomy completion without adding children'
  $occupiedChild=New-TaxonomyFolder 'Application receipts' 'occupied-child';$occupiedChild.Items=[pscustomobject]@{Count=1};$occupiedRoot=New-TaxonomyFolder 'Job Search' 'root-occupied-child';$occupiedRoot.Folders=New-TaxonomyCollection @($occupiedChild);$occupiedWorld=New-TaxonomyWorld @($occupiedRoot);$script:TaxonomySessionFactory={return $occupiedWorld};$occupiedRejected=$false;try{Invoke-CreateTaxonomy}catch{$occupiedRejected=$true};Assert-Test ($occupiedRejected -and $occupiedRoot.Folders.Count -eq 1 -and $occupiedChild.Folders.Count -eq 0) 'nonempty approved child is never reused as a taxonomy destination'
  $ambiguousWorld=New-TaxonomyWorld @((New-TaxonomyFolder 'Job Search' 'root-duplicate-a'),(New-TaxonomyFolder 'Job Search' 'root-duplicate-b'));$script:TaxonomySessionFactory={return $ambiguousWorld};$ambiguousRootRejected=$false;try{Invoke-CreateTaxonomy}catch{$ambiguousRootRejected=$true};Assert-Test ($ambiguousRootRejected -and $ambiguousWorld.RootFolders.Count -eq 2) 'duplicate exact root names block taxonomy creation'
  $partialWorld=New-TaxonomyWorld;$script:TaxonomyChildAdds=0;$script:TaxonomyFailAfter=2;$script:TaxonomySessionFactory={return $partialWorld};$partialRejected=$false;try{Invoke-CreateTaxonomy}catch{$partialRejected=$true};$script:TaxonomyFailAfter=-1
  $partialJournal=Read-ProtectedJson -Path (Join-Path $taxonomyRun 'taxonomy-journal.dpapi') -Context $taxonomyContext
  Assert-Test ($partialRejected -and $partialWorld.RootFolders.Count -eq 1 -and $partialWorld.RootFolders.Item(1).Folders.Count -eq 2 -and $partialJournal.stage -eq 'partial_requires_review' -and $partialJournal.created.Count -eq 3) 'partial folder-add failure journals every created exact folder and requires review'
} finally {
  $script:StateRoot=$null;$script:ManifestPath=$null;$script:ApprovedFoldersPath=$null;$script:RuntimeContextFactory=$null;$script:TaxonomySessionFactory=$null;$script:TaxonomyMutexFactory=$null;$script:TaxonomyFailAfter=-1;$script:TaxonomyChildAdds=0
  if(Test-Path -LiteralPath $taxonomyRoot){Remove-Item -LiteralPath $taxonomyRoot -Recurse -Force}
}
& (Join-Path $PSScriptRoot 'test-outlook-cleanup-identity.ps1')
& (Join-Path $PSScriptRoot 'test-outlook-cleanup-synthetic.ps1')
Write-Output 'Synthetic Outlook cleanup behavior tests passed.'

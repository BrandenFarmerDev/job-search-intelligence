[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-com-export.ps1') -Library
function Assert-Collector([bool]$Condition,[string]$Name){if(-not $Condition){throw "Synthetic collector test failed: $Name"}}
$initialClassifierCommand=Get-Command Get-Classification -ErrorAction SilentlyContinue
Assert-Collector ($null -eq $initialClassifierCommand) 'collector starts without exposing the cleanup classifier in caller scope'
function New-FixtureMessage([string]$Id,[string]$Folder='inbox',[string]$When='2026-10-01T12:00:00.0000000Z') {
  return @{entryId=$Id;folderId=$Folder;locator='search:'+$Id;internetMessageId='<'+$Id+'@example.invalid>';sender='recruiter@example.invalid';recipients=@('owner@example.invalid');subject='Application received';body='Thank you for applying to Example for the engineer position.';receivedUtc=$When;sentUtc=$When;modifiedUtc=$When;conversationId='conversation-'+$Id}
}
function New-FixtureProvider($Rows,$Folders=@(@{id='inbox';kind='inbox'},@{id='sent';kind='sentitems'})) {
  $lookup=@{};foreach($row in $Rows){$lookup[$row.folderId+'|'+$row.entryId]=$row}
  $p=[pscustomobject]@{StoreId='synthetic-store';Folders=$Folders;Rows=$Rows;Lookup=$lookup;Reads=0;Snapshots=0;FailRead=$false;DateCache=@{}}
  $p|Add-Member ScriptMethod Candidates {
    param($folderId,$lower,$upper,$deadline)
    $this.Snapshots++
    $found=[Collections.Generic.List[object]]::new()
    foreach($row in $this.Rows){
      if($row.folderId -ne $folderId){continue}
      foreach($stamp in @($row.receivedUtc,$row.modifiedUtc)){if(-not $this.DateCache.ContainsKey($stamp)){$this.DateCache[$stamp]=Convert-CollectionUtc $stamp}}
      $r=$this.DateCache[$row.receivedUtc];$m=$this.DateCache[$row.modifiedUtc]
      if(($r -ge $lower -and $r -le $upper) -or ($m -ge $lower -and $m -le $upper)){$found.Add(@{folderId=$row.folderId;entryId=$row.entryId;modified=$row.modifiedUtc})}
    }
    return ,$found.ToArray()
  }
  $p|Add-Member ScriptMethod Read {
    param($candidate)
    $this.Reads++;if($this.FailRead){throw 'fixture_access_denied'}
    $key=$candidate.folderId+'|'+$candidate.entryId
    if(-not $this.Lookup.ContainsKey($key)){throw 'fixture_scope_changed'};return $this.Lookup[$key]
  }
  return $p
}
$floor=Convert-CollectionUtc '2026-09-30T07:00:00Z';$until=Convert-CollectionUtc '2026-10-11T12:00:00Z'
$rows=@((New-FixtureMessage 'receipt'),(New-FixtureMessage 'sent' 'sent'),(New-FixtureMessage 'too-old' 'inbox' '2026-09-30T06:59:59.9999999Z'),(New-FixtureMessage 'unknown' 'unknown'),(New-FixtureMessage 'deleted' 'deleted'),(New-FixtureMessage 'junk' 'junk'))
$rows[1].sender='owner@example.invalid'
$rows[2].modifiedUtc='2026-10-11T10:00:00Z'
$p=New-FixtureProvider $rows
$bundle=Invoke-Collection $p 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($bundle.collection.complete -and $bundle.messages.Count -eq 2) 'direct-folder scope and exact historical floor'
Assert-Collector (@($bundle.messages|Where-Object{$_.folder -eq 'sentitems'}).Count -eq 1) 'semantic sent direction'
$roundTrip=ConvertFrom-Json (ConvertTo-Json -InputObject $bundle.collection.nextState -Depth 30)
$same=Invoke-Collection $p 'owner@example.invalid' $floor $until $roundTrip 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($same.messages.Count -eq 0 -and $p.Reads -eq 3) 'unchanged revisions skip full body reads after persisted state'
$rows[0].modifiedUtc='2026-10-11T11:00:00Z'
$changed=Invoke-Collection $p 'owner@example.invalid' $floor $until $same.collection.nextState 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($changed.messages.Count -eq 1 -and $changed.messages[0].immutableId -eq $bundle.messages[0].immutableId) 'revision changes preserve identity'
$long=('unrelated introduction '+('x'*6500)+' Thank you for applying to Example for the engineer role.')
$late=Get-CollectionEvidence 'A message' $long
Assert-Collector ($late.Relevant -and $late.Excerpt.Length -le 1500 -and $late.Excerpt -match 'Thank you for applying') 'full-body relevance and useful minimal excerpt'
Assert-Collector (-not (Get-CollectionEvidence 'Weekly jobs for you' 'A recruiting newsletter with recommended jobs').Relevant) 'generic alerts remain local'
Assert-Collector ((Get-CollectionEvidence 'Job alert: application received' 'We received your application to Example').Relevant) 'specific evidence in an alert-labelled message'
Assert-Collector ((Get-CollectionEvidence 'Availability for a call' 'Would Tuesday at 10 work for you? Please reply with a convenient time.').Relevant) 'interview scheduling language is captured by purpose'
Assert-Collector ((Get-CollectionEvidence 'Technical test' 'Please review the attached information and reply when ready.').Relevant -and (Get-CollectionEvidence 'Compensation package' 'Please review the attached information and reply when ready.').Relevant) 'assessment and offer purpose language aligns with cleanup classification'
Assert-Collector (-not (Get-CollectionEvidence 'Lunch tomorrow' "Lunch?`nFrom: recruiter`nThank you for applying").Relevant) 'quoted old evidence does not classify current mail'
$purposeCases=[Collections.Generic.List[object]]::new();$neutral='Please review the attached information and reply when ready.'
foreach($subject in @('Pre-employment','Offer letter','Offer of employment','Compensation package','Background check')){$purposeCases.Add(@{Class='Offers';Subject=$subject;Body=$neutral})}
foreach($body in @('We are pleased to offer you the position.','We are pleased to offer you employment.','Offer of employment details are attached.','The compensation package is attached.','Please review the background check steps.','Complete the pre-employment check.')){$purposeCases.Add(@{Class='Offers';Subject='Status update';Body=$body})}
foreach($subject in @('Rejected','Regret to inform','Not moving forward','Position has been filled','Application unsuccessful','Withdrawn','Candidacy closed')){$purposeCases.Add(@{Class='Rejections';Subject=$subject;Body=$neutral})}
foreach($body in @('We regret to inform you of our decision.','We will not be moving forward.','We are not moving forward with your application.','Your candidacy is closed.','We have decided to move forward with other applicants.')){$purposeCases.Add(@{Class='Rejections';Subject='Update from Acme';Body=$body})}
foreach($subject in @('Assessment','Coding exercise','Technical test','Take-home','Complete the test')){$purposeCases.Add(@{Class='Assessments';Subject=$subject;Body=$neutral})}
foreach($body in @('Please complete our assessment.','Please complete our technical test.','Please complete our coding exercise.','Assessment deadline is Friday.','Please submit your exercise by Friday.')){$purposeCases.Add(@{Class='Assessments';Subject='Status update';Body=$body})}
foreach($subject in @('Interview','Schedule a call','Screening call','Availability for a call')){$purposeCases.Add(@{Class='Interviews';Subject=$subject;Body=$neutral})}
foreach($body in @('We invite you to an interview.','Please schedule an interview.','Please share availability for an interview.','We would like to interview you.')){$purposeCases.Add(@{Class='Interviews';Subject='Status update';Body=$body})}
foreach($subject in @('Application received','Application confirmation','Thank you for applying','We received your application','Submission confirmation')){$purposeCases.Add(@{Class='Application receipts';Subject=$subject;Body=$neutral})}
foreach($body in @('We have received your application.','Thank you for submitting your application.','Your application was successfully submitted.')){$purposeCases.Add(@{Class='Application receipts';Subject='Status update';Body=$body})}
foreach($subject in @('Recruiter update','Talent acquisition about the role','Screening follow-up','Your application','Following up about the role','Opportunity at Acme for the role')){$purposeCases.Add(@{Class='Recruiter follow-ups';Subject=$subject;Body='I would like to discuss the role with you.'})}
foreach($case in $purposeCases){$decision=Get-CollectionPurposeClassification $case.Subject $case.Body;$captured=Get-CollectionEvidence $case.Subject $case.Body;Assert-Collector ($decision.Class -eq $case.Class -and $captured.Relevant) ("cleanup/collector definite purpose contract ({0}): {1} | {2}" -f $case.Class,$case.Subject,$case.Body)}
$cachedClassifierModule=$script:CleanupClassifierModule;[void](Get-CollectionPurposeClassification 'Submission confirmation' $neutral);$classifierCommand=Get-Command Get-Classification -ErrorAction SilentlyContinue;Assert-Collector ($null -ne $cachedClassifierModule -and [object]::ReferenceEquals($cachedClassifierModule,$script:CleanupClassifierModule) -and $null -eq $classifierCommand) 'shared classifier stays cached without leaking a caller-visible command'
Assert-Collector ((Get-CollectionEvidence 'Job alert from Acme' 'We would like to interview you.').Relevant) 'definite interview purpose overrides a generic-alert subject'
Assert-Collector (-not (Get-CollectionEvidence 'Weekly jobs for you' 'A recruiting newsletter with recommended jobs').Relevant -and (Get-CollectionEvidence 'Weekly jobs for you' 'A recruiting newsletter with recommended jobs' -AllMail).Relevant) 'generic alerts stay local by default while explicit all-mail override remains available'
$mixed=@((New-FixtureMessage 'received' 'custom'),(New-FixtureMessage 'outgoing' 'custom'),(New-FixtureMessage 'ambiguous' 'custom'))
$mixed[1].sender='owner@example.invalid';$mixed[2].recipients=@('other@example.invalid')
$mp=New-FixtureProvider $mixed @(@{id='custom';kind='mixed'})
$mb=Invoke-Collection $mp 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($mb.messages.Count -eq 2 -and $mb.collection.reviewCount -eq 1 -and -not $mb.collection.evidenceComplete) 'mixed folder direction requires actual sender/recipient evidence'
Assert-Collector ($mb.collection.nextState.reviews.Count -eq 1) 'private review locator survives incomplete evidence'
$dense=1..2105|ForEach-Object{New-FixtureMessage ('equal-'+$_) 'inbox' '2026-10-01T12:00:00.1234567Z'}
$dp=New-FixtureProvider $dense @(@{id='inbox';kind='inbox'})
$cursor=$null;$total=0;$runs=0
do{
  $part=Invoke-Collection $dp 'owner@example.invalid' $floor $until $cursor 500 ([datetime]::UtcNow.AddMinutes(2))
  $total+=$part.messages.Count;$cursor=ConvertFrom-Json (ConvertTo-Json -InputObject $part.collection.nextState -Depth 30 -Compress);$runs++
  Assert-Collector ($runs -lt 20) 'bounded dense-window progress'
}while(-not $part.collection.complete)
Assert-Collector ($total -eq 2105 -and $runs -ge 5) 'more than 2000 equal-timestamp messages resume without omission'
$np=New-FixtureProvider @((New-FixtureMessage 'noid-a'),(New-FixtureMessage 'noid-b')) @(@{id='inbox';kind='inbox'})
foreach($row in $np.Rows){$row.internetMessageId='';$row.subject='Same subject';$row.conversationId='same-conversation'}
$nb=Invoke-Collection $np 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($nb.messages.Count -eq 2 -and $nb.messages[0].immutableId -ne $nb.messages[1].immutableId) 'physical provider locators are distinct from backend canonical fallback'
$failed=$false;try{$dp.StoreId='different-store';[void](Invoke-Collection $dp 'owner@example.invalid' $floor $until $cursor 500 ([datetime]::UtcNow.AddMinutes(1)))}catch{$failed=$true}
Assert-Collector $failed 'store binding mismatch fails closed'
$denied=New-FixtureProvider @((New-FixtureMessage 'denied'));$denied.FailRead=$true
$db=Invoke-Collection $denied 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($db.collection.reviewCount -eq 1 -and $db.messages.Count -eq 0) 'unreadable content is recorded for review'
$expired=Invoke-Collection (New-FixtureProvider @((New-FixtureMessage 'later'))) 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddSeconds(-1))
Assert-Collector (-not $expired.collection.complete -and $expired.collection.nextState.windows.Count -gt 0) 'time budget never advances unscanned windows'
foreach($cultureName in @('en-US','en-GB','de-DE')){
  $priorCulture=[Threading.Thread]::CurrentThread.CurrentCulture
  try{
    [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo($cultureName)
    Assert-Collector ((Convert-CollectionUtc '2026-11-01T01:30:00-07:00').Ticks -ne (Convert-CollectionUtc '2026-11-01T01:30:00-08:00').Ticks) 'DST offsets remain distinct'
    $filter=New-CollectionFilter (Convert-CollectionUtc '2026-10-01T12:00:00.1234567Z') (Convert-CollectionUtc '2026-10-01T12:00:00.1234567Z')
    Assert-Collector ($filter -match '2026-10-01 11:59:00' -and $filter -match '2026-10-01 12:02:00') 'culture-independent widened UTC filter'
  }finally{[Threading.Thread]::CurrentThread.CurrentCulture=$priorCulture}
}
# Exercise the real COM adapter through small synthetic objects, including approved folder IDs.
$folderMap=@{}
$inbox=[pscustomobject]@{EntryID='inbox';Name='Inbox'};$sent=[pscustomobject]@{EntryID='sent';Name='Sent Items'};$junk=[pscustomobject]@{EntryID='junk';Name='Junk E-mail'}
$root=[pscustomobject]@{EntryID='root';Name='Job Search';Parent=$inbox;Folders=[pscustomobject]@{Count=8}}
$folderMap.inbox=$inbox;$folderMap.sent=$sent;$folderMap.junk=$junk;$folderMap.root=$root
$bindings=@();foreach($name in $script:ApprovedNames){$id=Get-CollectionHash $name;$folderMap[$id]=[pscustomobject]@{EntryID=$id;Name=$name;Parent=$root;Folders=[pscustomobject]@{Count=0}};$bindings+=@{entryId=$id;name=$name}}
$store=[pscustomobject]@{StoreID='adapter-store';Map=$folderMap}
$store|Add-Member ScriptMethod GetDefaultFolder {param($id);switch($id){6{return $this.Map.inbox};5{return $this.Map.sent};23{return $this.Map.junk};default{throw 'out_of_scope_default_folder'}}}
$session=[pscustomobject]@{Map=$folderMap;Mail=@{}}
$session|Add-Member ScriptMethod GetFolderFromID {param($id,$storeId);if($storeId -ne 'adapter-store' -or -not $this.Map.ContainsKey($id)){throw 'fixture_folder_missing'};return $this.Map[$id]}
$session|Add-Member ScriptMethod GetItemFromID {param($id,$storeId);if($storeId -ne 'adapter-store' -or -not $this.Mail.ContainsKey($id)){throw 'fixture_mail_missing'};return $this.Mail[$id]}
$approved=[pscustomobject]@{storeId='adapter-store';rootId='root';folders=$bindings}
$adapter=New-OutlookCollectionProvider $session $store $approved
Assert-Collector ($adapter.Folders.Count -eq 11 -and @($adapter.Folders|Where-Object{$_.id -eq 'junk'}).Count -eq 0) 'approved exact subtree including its root plus direct Inbox/Sent, excluding routine Junk'
$root.Folders.Count=9;$refused=$false;try{[void](New-OutlookCollectionProvider $session $store $approved)}catch{$refused=$true}
Assert-Collector $refused 'unknown custom descendants are coverage errors';$root.Folders.Count=8
$root.Name='Renamed';$refused=$false;try{[void](New-OutlookCollectionProvider $session $store $approved)}catch{$refused=$true}
Assert-Collector $refused 'renamed approved roots fail closed';$root.Name='Job Search'
$approvedWrongStore=[pscustomobject]@{storeId='different-store';rootId='root';folders=$bindings};$refused=$false;try{[void](New-OutlookCollectionProvider $session $store $approvedWrongStore)}catch{$refused=$_.Exception.Message -match 'approved_folder_store_mismatch'}
Assert-Collector $refused 'approved subtree cannot be replayed against another delivery store'
$originalParent=$root.Parent;$root.Parent=$sent;$refused=$false;try{[void](New-OutlookCollectionProvider $session $store $approved)}catch{$refused=$_.Exception.Message -match 'approved_root_moved_or_renamed'};$root.Parent=$originalParent
Assert-Collector $refused 'approved root moved outside Inbox fails closed'
$firstBinding=$bindings[0];$originalName=$folderMap[$firstBinding.entryId].Name;$folderMap[$firstBinding.entryId].Name='Unexpected';$refused=$false;try{[void](New-OutlookCollectionProvider $session $store $approved)}catch{$refused=$_.Exception.Message -match 'approved_folder_moved_renamed_or_unknown_children'};$folderMap[$firstBinding.entryId].Name=$originalName
Assert-Collector $refused 'renamed approved child cannot silently reduce collection coverage'
$folderMap[$firstBinding.entryId].Folders.Count=1;$refused=$false;try{[void](New-OutlookCollectionProvider $session $store $approved)}catch{$refused=$_.Exception.Message -match 'approved_folder_moved_renamed_or_unknown_children'};$folderMap[$firstBinding.entryId].Folders.Count=0
Assert-Collector $refused 'unexpected nesting under an approved child fails closed'
$propertyAccessor=[pscustomobject]@{}
$propertyAccessor|Add-Member ScriptMethod GetProperty {param($uri);if($uri -like '*0x1035001F'){return '<junk-receipt@example.invalid>'};return $null}
$junkRecipients=[pscustomobject]@{Count=1}
$junkRecipients|Add-Member ScriptMethod Item {param($index);return [pscustomobject]@{Address='owner@example.invalid'}}
$mail=[pscustomobject]@{EntryID='job-junk';Parent=$junk;Class=43;Subject='Application received';Body='Thank you for applying to Example for the engineer position.';SenderEmailAddress='Recruiter@example.invalid';Recipients=$junkRecipients;PropertyAccessor=$propertyAccessor;ReceivedTime=(Convert-CollectionUtc '2026-10-01T12:00:00Z');SentOn=(Convert-CollectionUtc '2026-10-01T12:00:00Z');LastModificationTime=(Convert-CollectionUtc '2026-10-01T12:00:00Z');ConversationID='junk-conversation'}
$session.Mail['job-junk']=$mail
$manifest=[ordered]@{schema='outlook-cleanup-manifest.v2';schemaVersion=2;utilityVersion='1.0.0';ruleVersion='cleanup-rules-2026-10-11.2';storeId='adapter-store';mailboxBinding=(Get-CollectionHash 'owner@example.invalid');complete=$true;sources=@(@{folderId='inbox';folder='Inbox';defaultFolderId=6},@{folderId='junk';folder='Junk';defaultFolderId=23});items=@(@{entryId='job-junk';folderId='junk';action='move';actionEligible=$true;evidenceComplete=$true;bodyStatus='complete';destination='Application receipts';receivedAt='2026-10-01T12:00:00Z';modifiedAt='2026-10-01T12:00:00Z';fingerprint=(Get-CollectionHash ($mail.Subject+'|'+$mail.SenderEmailAddress+'|'+$mail.Body))},@{entryId='generic-alert';folderId='junk';action='move';destination='Job alerts'},@{entryId='nonjob';folderId='junk';action='delete_to_deleted_items';destination='Delete candidate'})}
$manifest.manifestHash=&{param($m) . (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library;Get-ManifestHash $m} $manifest
$jp=New-SelectedJunkProvider $session $store $manifest $manifest.manifestHash 'owner@example.invalid'
$jb=Invoke-Collection $jp 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($jb.messages.Count -eq 1 -and $jb.messages[0].folder -eq 'inbox') 'one-time exact-manifest Junk capture retains received semantics and excludes alerts/deletion candidates'
$mail.Subject='Availability for a call';$mail.Body='Would Tuesday at 10 work for you? Please reply with a convenient time.';$manifest.items[0].class='Interviews';$manifest.items[0].destination='Interviews';$manifest.items[0].fingerprint=Get-CollectionHash ($mail.Subject+'|'+$mail.SenderEmailAddress+'|'+$mail.Body);$manifest.manifestHash=&{param($m) . (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library;Get-ManifestHash $m} $manifest;$jp=New-SelectedJunkProvider $session $store $manifest $manifest.manifestHash 'owner@example.invalid';$jb=Invoke-Collection $jp 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1));Assert-Collector ($jb.messages.Count -eq 1 -and $jb.messages[0].subject -eq 'Availability for a call') 'selected Junk interview invitation passes purpose matching and exact-manifest capture'
$mail.Subject='Application received';$mail.Body='Thank you for applying to Example for the engineer position.';$manifest.items[0].class='Application receipts';$manifest.items[0].destination='Application receipts';$manifest.items[0].fingerprint=Get-CollectionHash ($mail.Subject+'|'+$mail.SenderEmailAddress+'|'+$mail.Body);$manifest.manifestHash=&{param($m) . (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library;Get-ManifestHash $m} $manifest
$junkRecipients.Count=0
$jb=Invoke-Collection $jp 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($jb.messages.Count -eq 0 -and $jb.collection.reviewCount -eq 1) 'Junk without a verified owner recipient stays in local review'
$junkRecipients.Count=1;$mail.SenderEmailAddress='owner@example.invalid'
$manifest.items[0].fingerprint=Get-CollectionHash ($mail.Subject+'|'+$mail.SenderEmailAddress+'|'+$mail.Body)
$manifest.manifestHash=&{param($m) . (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library;Get-ManifestHash $m} $manifest
$jp=New-SelectedJunkProvider $session $store $manifest $manifest.manifestHash 'owner@example.invalid'
$jb=Invoke-Collection $jp 'owner@example.invalid' $floor $until $null 500 ([datetime]::UtcNow.AddMinutes(1))
Assert-Collector ($jb.messages.Count -eq 0 -and $jb.collection.reviewCount -eq 1) 'owner-sent mail copied to Junk cannot become incoming application evidence'
$manifest.items[0].destination='Offers';$refused=$false;try{[void](New-SelectedJunkProvider $session $store $manifest $manifest.manifestHash 'owner@example.invalid')}catch{$refused=$true}
Assert-Collector $refused 'changed exact Junk candidate manifest invalidates approval'

# Exercise the normal Inbox/Sent adapter against synthetic Outlook-shaped objects.
# These fixtures deliberately expose only the COM members the adapter should read.
function New-AdapterCollection($Items) {
  $collection=[pscustomobject]@{Rows=@($Items);Count=@($Items).Count;Filter=''}
  $collection|Add-Member ScriptMethod Restrict {param($filter);$this.Filter=$filter;if($this.FailRestrict){throw 'fixture_table_failure'};if([int]$this.OverrideCount -ge 0){return [pscustomobject]@{Count=[int]$this.OverrideCount}};return $this}
  $collection|Add-Member ScriptMethod Item {param($index);return $this.Rows[$index-1]}
  $collection|Add-Member NoteProperty FailRestrict $false
  $collection|Add-Member NoteProperty OverrideCount -1
  return $collection
}
function New-AdapterMail($Id,[int]$Class=43) {
  $pa=[pscustomobject]@{Properties=@{}}
  $pa|Add-Member ScriptMethod GetProperty {param($uri);if($this.Properties.ContainsKey($uri)){return ,$this.Properties[$uri]};return $null}
  $recipientEntry=[pscustomobject]@{}
  $recipientEntry|Add-Member ScriptMethod GetExchangeUser {return [pscustomobject]@{PrimarySmtpAddress='Owner@Example.Invalid'}}
  $recipient=[pscustomobject]@{Address='EX:/o=company/ou=people/cn=owner';AddressEntry=$recipientEntry}
  $recipients=[pscustomobject]@{Count=1;Rows=@($recipient)}
  $recipients|Add-Member ScriptMethod Item {param($index);if($index -ne 1){throw 'fixture_recipient_index'};return $this.Rows[$index-1]}
  $mail=[pscustomobject]@{EntryID=$Id;Parent=$inbox;Class=$Class;Subject='Application received';Body='Thank you for applying to Example for the engineer position.';SenderEmailAddress='EX:/o=company/ou=people/cn=recruiter';Recipients=$recipients;PropertyAccessor=$pa;ReceivedTime=(Convert-CollectionUtc '2026-10-01T12:00:00Z');SentOn=(Convert-CollectionUtc '2026-10-01T12:00:00Z');LastModificationTime=(Convert-CollectionUtc '2026-10-01T12:00:00Z');ConversationID='adapter-conversation';Sender=[pscustomobject]@{}}
  $senderEntry=[pscustomobject]@{}
  $senderEntry|Add-Member ScriptMethod GetExchangeUser {return [pscustomobject]@{PrimarySmtpAddress='Recruiter@Example.Invalid'}}
  $mail.Sender=[pscustomobject]@{Entry=$senderEntry}
  $mail.Sender|Add-Member ScriptMethod GetExchangeUser {return [pscustomobject]@{PrimarySmtpAddress='Recruiter@Example.Invalid'}}
  $pa.Properties['http://schemas.microsoft.com/mapi/proptag/0x1035001F']='<adapter@example.invalid>'
  $pa.Properties['http://schemas.microsoft.com/mapi/proptag/0x300B0102']=[byte[]](1,2,3)
  return $mail
}
$adapterRows=@((New-AdapterMail 'adapter-good'),(New-AdapterMail 'adapter-nonmail' 26))
$session.Mail['adapter-good']=$adapterRows[0];$session.Mail['adapter-nonmail']=$adapterRows[1]
$adapterItems=New-AdapterCollection -Items $adapterRows
$inbox|Add-Member NoteProperty Items $adapterItems -Force
$adapter=New-OutlookCollectionProvider $session $store $null
$adapterLower=Convert-CollectionUtc '2026-10-01T12:00:00Z';$adapterUpper=$adapterLower
$adapterCandidates=@($adapter.Candidates('inbox',$adapterLower,$adapterUpper,([datetime]::UtcNow.AddMinutes(1))))
Assert-Collector ($adapterCandidates.Count -eq 1 -and $adapterCandidates[0].entryId -eq 'adapter-good') 'real adapter candidates post-filter UTC timestamps and skip non-mail classes'
Assert-Collector ($adapterItems.Filter -match 'urn:schemas:httpmail:datereceived' -and $adapterItems.Filter -match 'DAV:getlastmodified' -and $adapterItems.Filter -match '2026-10-01 11:59:00' -and $adapterItems.Filter -match '2026-10-01 12:02:00') 'adapter uses widened UTC DASL bounds for all supported date fields'
$adapterRead=$adapter.Read($adapterCandidates[0])
Assert-Collector ($adapterRead.sender -eq 'recruiter@example.invalid' -and $adapterRead.recipients[0] -eq 'owner@example.invalid' -and $adapterRead.internetMessageId -eq '<adapter@example.invalid>' -and $adapterRead.locator -eq 'search:AQID') 'adapter resolves Exchange addresses and preserves precise message identity'
$adapterCandidates[0].folderId='sent';$refused=$false;try{[void]$adapter.Read($adapterCandidates[0])}catch{$refused=$_.Exception.Message -match 'candidate_scope_changed_review'}
Assert-Collector $refused 'adapter Read rejects a candidate whose actual parent folder changed'
$adapterCandidates[0].folderId='inbox'
$adapterItems.FailRestrict=$true;$refused=$false;try{[void]@($adapter.Candidates('inbox',$adapterLower,$adapterUpper,([datetime]::UtcNow.AddMinutes(1))))}catch{$refused=$_.Exception.Message -match 'fixture_table_failure'}
Assert-Collector $refused 'adapter table failure is propagated so collection cannot claim complete coverage';$adapterItems.FailRestrict=$false
$adapterItems.OverrideCount=50001;$refused=$false;try{[void]@($adapter.Candidates('inbox',$adapterLower,$adapterUpper,([datetime]::UtcNow.AddMinutes(1))))}catch{$refused=$_.Exception.Message -match 'dense_window_exceeds_locator_limit'}
Assert-Collector $refused 'adapter refuses a locator snapshot above the hard 50000 item cap';$adapterItems.OverrideCount=-1
$adapterItems.OverrideCount=501;$longLower=Convert-CollectionUtc '2026-10-01T00:00:00Z';$longUpper=Convert-CollectionUtc '2026-10-02T00:00:00Z';$refused=$false;try{[void]@($adapter.Candidates('inbox',$longLower,$longUpper,([datetime]::UtcNow.AddMinutes(1))))}catch{$refused=$_.Exception.Message -match 'split_dense_window'}
Assert-Collector $refused 'adapter asks the collector to split broad windows before taking a dense locator snapshot';$adapterItems.OverrideCount=-1
$refused=$false;try{[void]@($adapter.Candidates('inbox',$adapterLower,$adapterUpper,([datetime]::UtcNow.AddSeconds(-1))))}catch{$refused=$_.Exception.Message -match 'candidate_snapshot_incomplete_retry'}
Assert-Collector $refused 'adapter deadline failure propagates without returning a partial locator snapshot'

# Drive the command entrypoint through its injectable Outlook boundary. These calls
# verify account/store startup and file output without creating an Outlook process.
function New-CollectorTestApplication($Rows) {
  $accountRows=@($Rows);$accounts=[pscustomobject]@{Rows=$accountRows;Count=$accountRows.Count}
  $accounts|Add-Member ScriptMethod Item {param($index);return $this.Rows[$index-1]}
  $namespace=[pscustomobject]@{Accounts=$accounts;Map=$folderMap;Mail=$session.Mail}
  $namespace|Add-Member ScriptMethod GetFolderFromID {param($id,$storeId);if($storeId -ne 'adapter-store' -or -not $this.Map.ContainsKey($id)){throw 'fixture_folder_missing'};return $this.Map[$id]}
  $namespace|Add-Member ScriptMethod GetItemFromID {param($id,$storeId);if($storeId -ne 'adapter-store' -or -not $this.Mail.ContainsKey($id)){throw 'fixture_mail_missing'};return $this.Mail[$id]}
  $app=[pscustomobject]@{Namespace=$namespace}
  $app|Add-Member ScriptMethod GetNamespace {param($name);if($name -ne 'MAPI'){throw 'fixture_namespace_name'};return $this.Namespace}
  return $app
}
$cliAccount=[pscustomobject]@{SmtpAddress='owner@example.invalid';DeliveryStore=$store}
$script:CollectorFakeApplication=New-CollectorTestApplication -Rows @($cliAccount)
$script:CollectorOutlookFactory={return $script:CollectorFakeApplication}
$Mailbox='owner@example.invalid';$ValidateOnly=$true;$OutputPath=$null;$ApprovedFoldersPath=$null
$validation=Invoke-CollectorRun|ConvertFrom-Json
Assert-Collector ($validation.classicOutlook -and $validation.mailboxConfigured -and $validation.selectedFolders -eq 2) 'CLI validation selects exactly the requested account and reports default folder binding'
$badApprovedPath=Join-Path ([IO.Path]::GetTempPath()) ('missing-approved-'+[guid]::NewGuid().ToString('N')+'.json')
$ApprovedFoldersPath=$badApprovedPath;$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'Approved folder configuration is missing'}
Assert-Collector $refused 'CLI refuses a missing protected approved-folder file';$ApprovedFoldersPath=$null
$script:CollectorFakeApplication=New-CollectorTestApplication -Rows @()
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'must resolve to exactly one Outlook account'}
Assert-Collector $refused 'CLI refuses a mailbox with no matching Outlook account'
$script:CollectorFakeApplication=New-CollectorTestApplication -Rows @($cliAccount,$cliAccount)
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'must resolve to exactly one Outlook account'}
Assert-Collector $refused 'CLI refuses an ambiguous duplicate account match'
$script:CollectorFakeApplication=New-CollectorTestApplication -Rows @([pscustomobject]@{SmtpAddress='owner@example.invalid';DeliveryStore=$null})
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'no delivery store'}
Assert-Collector $refused 'CLI refuses an account without a delivery store'
$script:CollectorFakeApplication=New-CollectorTestApplication -Rows @($cliAccount);$ValidateOnly=$false
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'OutputPath is required'}
Assert-Collector $refused 'CLI requires a destination before collection begins'
$OutputPath=Join-Path ([IO.Path]::GetTempPath()) ('collector-'+[guid]::NewGuid().ToString('N')+'.txt')
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'OutputPath must end in .json'}
Assert-Collector $refused 'CLI rejects unsupported output extensions'
$OutputPath=Join-Path ([IO.Path]::GetTempPath()) ('collector-'+[guid]::NewGuid().ToString('N')+'.json')
$StatePath=Join-Path ([IO.Path]::GetTempPath()) ('collector-state-'+[guid]::NewGuid().ToString('N')+'.json')
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'Protected collector state requires RuntimeContext'}
Assert-Collector $refused 'CLI refuses persisted state without its protected runtime context';$StatePath=$null
$Since='2026-09-29T23:59:59-07:00';$Until='2026-10-01T00:00:00Z'
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'Invalid collection UTC bounds'}
Assert-Collector $refused 'CLI enforces the exact UTC historical floor';$Since='2026-09-30T07:00:00Z';$Until=$null
$emptyCollection=New-AdapterCollection -Items @();$sent|Add-Member NoteProperty Items $emptyCollection -Force
$ProtectedOutput=$true;$RuntimeContext=$null
$refused=$false;try{[void](Invoke-CollectorRun)}catch{$refused=$_.Exception.Message -match 'ProtectedOutput requires RuntimeContext'}
Assert-Collector $refused 'CLI refuses unprotected output when protected mode is requested';$ProtectedOutput=$false
$success=Invoke-CollectorRun|ConvertFrom-Json
Assert-Collector ((Test-Path -LiteralPath $OutputPath) -and $success.complete -and $success.messages -eq 1) 'CLI writes a synthetic JSON collection and reports its completion'
[IO.File]::Delete($OutputPath);$script:CollectorOutlookFactory=$null
Write-Output 'Synthetic Outlook collector behavior tests passed.'

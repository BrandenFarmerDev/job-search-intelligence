[CmdletBinding()]
param(
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')][string]$Mailbox,
  [string]$Since='2026-09-30T07:00:00Z',[string]$Until,[string]$OutputPath,
  [string]$StatePath,[object]$RuntimeContext,[string]$ApprovedFoldersPath,
  [string]$JunkManifestPath,[string]$JunkApprovalHash,
  [ValidateRange(1,5000)][int]$MaxMessagesPerFolder=500,
  [ValidateRange(1,1500)][int]$BudgetSeconds=1200,
  [switch]$IncludeAllMail,[switch]$ValidateOnly,[switch]$Force,[switch]$Library,[switch]$ProtectedOutput
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:CollectorOutlookFactory=$null
$script:CollectionFloor=[datetime]::Parse('2026-09-30T07:00:00Z').ToUniversalTime()
$script:ApprovedNames=@('Application receipts','Recruiter follow-ups','Interviews','Assessments','Offers','Rejections','Job alerts','Review')
$script:CleanupClassifierModule=$null
function Release-OutlookObject($Value) {
  if($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value)}
}
function Get-CollectionHash([string]$Value) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Get-CollectionField($Value,[string]$Name,$Default=$null) {
  if($null -eq $Value){return $Default}
  if($Value -is [Collections.IDictionary]){if($Value.Contains($Name)){return $Value[$Name]};return $Default}
  $p=$Value.PSObject.Properties[$Name];if($null -eq $p){return $Default};return $p.Value
}
function Convert-CollectionUtc($Value) {
  if($Value -is [datetime]){return $Value.ToUniversalTime()}
  return [datetime]::Parse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}
function Limit-CollectionText([string]$Value,[int]$Limit) {
  $value=$Value.Trim();if($value.Length -gt $Limit){return $value.Substring(0,$Limit)};return $value
}
function Get-CollectionMapi($Item,[string]$Property) {
  $accessor=$null
  try{$accessor=$Item.PropertyAccessor;return ,($accessor.GetProperty($Property))}catch{return $null}finally{Release-OutlookObject $accessor}
}
function Get-CollectionInternetId($Item) {
  foreach($tag in @('0x1035001F','0x1035001E')){$v=Get-CollectionMapi $Item ('http://schemas.microsoft.com/mapi/proptag/'+$tag);if($v){return ([string]$v).Trim()}}
  return ''
}
function Get-CollectionSender($Item) {
  $sender=[string]$Item.SenderEmailAddress
  if($sender -match '^[^@\s]+@[^@\s]+$'){return $sender.Trim().ToLowerInvariant()}
  $entry=$null;$exchange=$null
  try{$entry=$Item.Sender;$exchange=$entry.GetExchangeUser();if($exchange){return ([string]$exchange.PrimarySmtpAddress).Trim().ToLowerInvariant()}}catch{}finally{Release-OutlookObject $exchange;Release-OutlookObject $entry}
  return ''
}
function Get-CollectionRecipients($Item) {
  $recipients=$null;$result=[Collections.Generic.List[string]]::new()
  try{
    $recipients=$Item.Recipients
    if($recipients.Count -gt 100){throw 'recipient_limit_review'}
    for($i=1;$i -le $recipients.Count;$i++){
      $r=$null;$entry=$null;$ex=$null;$accessor=$null
      try{
        $r=$recipients.Item($i);$address=[string]$r.Address
        if($address -notmatch '^[^@\s]+@[^@\s]+$'){
          $entry=$r.AddressEntry
          try{$ex=$entry.GetExchangeUser();if($ex){$address=[string]$ex.PrimarySmtpAddress}}catch{}
          if($address -notmatch '^[^@\s]+@[^@\s]+$'){$accessor=$entry.PropertyAccessor;$address=[string]$accessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E')}
        }
        if($address -match '^[^@\s]+@[^@\s]+$'){$result.Add($address.Trim().ToLowerInvariant())}
      }finally{Release-OutlookObject $accessor;Release-OutlookObject $ex;Release-OutlookObject $entry;Release-OutlookObject $r}
    }
  }finally{Release-OutlookObject $recipients}
  return ,$result.ToArray()
}
function Get-CollectionDirection($Message,[string]$Context,[string]$Owner) {
  $sender=[string](Get-CollectionField $Message 'sender' '')
  if($sender -ieq $Owner){return 'sentitems'}
  if($sender -match '^[^@\s]+@[^@\s]+$' -and $Context -eq 'inbox'){return 'inbox'}
  if($sender -match '^[^@\s]+@[^@\s]+$' -and @((Get-CollectionField $Message 'recipients' @())|Where-Object{$_ -ieq $Owner}).Count -gt 0){return 'inbox'}
  return ''
}
function Get-CollectionPurposeClassification([string]$Subject,[string]$Body){
  if(-not $script:CleanupClassifierModule){$cleanupLibrary=Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1';if(-not (Test-Path -LiteralPath $cleanupLibrary)){throw 'installed_cleanup_classifier_missing'};$script:CleanupClassifierModule=New-Module -Name 'JSIOutlookCleanupClassifier' -ArgumentList $cleanupLibrary -ScriptBlock {param($path);. $path -Library;Export-ModuleMember -Function @()}}
  return (& $script:CleanupClassifierModule {param($s,$b) Get-Classification $s $b ''} $Subject $Body)
}
function Get-CollectionEvidence([string]$Subject,[string]$Body,[switch]$AllMail) {
  $primary=($Subject+"`n"+$Body) -replace '(?is)(\r?\n)\s*(from:|on .{1,100}wrote:|-----original message-----).*$', ''
  $classification=Get-CollectionPurposeClassification $Subject $Body
  $definiteEvidence=$classification.Class -in @('Application receipts','Recruiter follow-ups','Interviews','Assessments','Offers','Rejections')
  $specific='(?i)(thank you for (applying|your application)|(?:we (?:have )?)received your application|application (?:status|was|has been|to|for)|your (?:candidacy|application)|recruit(?:er|ing)|interview|availability for a call|schedule a call|would (monday|tuesday|wednesday|thursday|friday) at [0-9]|convenient time for (a call|an interview)|assessment|technical test|coding exercise|take-home|offer (?:letter|of employment)|compensation package|background check|right to represent|not selected|moving forward with (?:your|the) application|decided to move forward with other applicants)'
  $alert='(?i)\b(job alerts?|jobs? for you|weekly jobs|new jobs|recommended jobs|vacancies matching|career newsletter)\b'
  $match=[regex]::Match($primary,$specific)
  $genericAlert=($Subject -match $alert -and -not $definiteEvidence)
  if($genericAlert -and -not $AllMail){return @{Relevant=$false;Alert=$true;Excerpt=''}}
  $relevant=$AllMail -or $definiteEvidence -or $match.Success -or $Subject -match '(?i)\b(application|applicant|candidate|recruiter|interview|assessment|requisition|resume|résumé|hiring|position|screening)\b'
  if(-not $relevant){return @{Relevant=$false;Alert=$false;Excerpt=''}}
  $bodyMatch=[regex]::Match($Body,$specific)
  if($Body.Length -le 1500){$excerpt=$Body}
  elseif($bodyMatch.Success -and $bodyMatch.Index -gt 1000){
    $start=[Math]::Max(0,$bodyMatch.Index-250);$length=[Math]::Min(1190,$Body.Length-$start)
    $excerpt=$Body.Substring(0,300)+"`n...`n"+$Body.Substring($start,$length)
  }else{$excerpt=$Body.Substring(0,1500)}
  return @{Relevant=$true;Alert=$false;Excerpt=(Limit-CollectionText $excerpt 1500)}
}
function New-CollectionFilter([datetime]$Lower,[datetime]$Upper) {
  # DASL namespace dates are UTC. Widen minute boundaries and post-filter exactly.
  $lo=$Lower.AddSeconds(-$Lower.Second).AddTicks(-($Lower.Ticks % [TimeSpan]::TicksPerSecond)).AddMinutes(-1).ToString('yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
  $hi=$Upper.AddSeconds(-$Upper.Second).AddTicks(-($Upper.Ticks % [TimeSpan]::TicksPerSecond)).AddMinutes(2).ToString('yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
  $parts=@();foreach($prop in @('urn:schemas:httpmail:datereceived','urn:schemas:httpmail:datesent','DAV:getlastmodified')){$parts+='("'+$prop+'" >= '''+$lo+''' AND "'+$prop+'" <= '''+$hi+''')'}
  return '@SQL='+($parts -join ' OR ')
}
function New-OutlookCollectionProvider($Session,$Store,$Approved) {
  $folders=[Collections.Generic.List[object]]::new();$inbox=$null;$sent=$null;$root=$null
  try{
    $inbox=$Store.GetDefaultFolder(6);$sent=$Store.GetDefaultFolder(5)
    $folders.Add(@{id=[string]$inbox.EntryID;kind='inbox'});$folders.Add(@{id=[string]$sent.EntryID;kind='sentitems'})
    if($Approved){
      if([string]$Approved.storeId -ne [string]$Store.StoreID){throw 'approved_folder_store_mismatch'}
      $root=$Session.GetFolderFromID([string]$Approved.rootId,[string]$Store.StoreID)
      $parent=$null;try{$parent=$root.Parent;if([string]$parent.EntryID -ne [string]$inbox.EntryID -or $root.Name -cne 'Job Search'){throw 'approved_root_moved_or_renamed'}}finally{Release-OutlookObject $parent}
      $folders.Add(@{id=[string]$root.EntryID;kind='mixed'})
      $children=$root.Folders
      try{
        if($children.Count -ne 8 -or @($Approved.folders).Count -ne 8){throw 'approved_subtree_coverage_changed'}
        foreach($name in $script:ApprovedNames){
          $binding=@($Approved.folders|Where-Object{$_.name -ceq $name});if($binding.Count -ne 1){throw 'approved_folder_binding_invalid'}
          $folder=$null;$parent=$null;$sub=$null
          try{
            $folder=$Session.GetFolderFromID([string]$binding[0].entryId,[string]$Store.StoreID);$parent=$folder.Parent;$sub=$folder.Folders
            if($folder.Name -cne $name -or [string]$parent.EntryID -ne [string]$root.EntryID -or $sub.Count -ne 0){throw 'approved_folder_moved_renamed_or_unknown_children'}
            $folders.Add(@{id=[string]$folder.EntryID;kind='mixed'})
          }finally{Release-OutlookObject $sub;Release-OutlookObject $parent;Release-OutlookObject $folder}
        }
      }finally{Release-OutlookObject $children}
    }
    $provider=[pscustomobject]@{Session=$Session;Store=$Store;StoreId=[string]$Store.StoreID;Folders=$folders.ToArray()}
    $provider|Add-Member ScriptMethod Candidates {
      param($folderId,$lower,$upper,$deadline)
      $folder=$null;$items=$null;$filtered=$null;$result=[Collections.Generic.List[object]]::new()
      try{
        $folder=$this.Session.GetFolderFromID($folderId,$this.StoreId);$items=$folder.Items;$filtered=$items.Restrict((New-CollectionFilter $lower $upper))
        if($filtered.Count -gt 500 -and ($upper-$lower).TotalMinutes -gt 2){throw 'split_dense_window'}
        if($filtered.Count -gt 50000){throw 'dense_window_exceeds_locator_limit'}
        for($i=1;$i -le $filtered.Count;$i++){
          if([datetime]::UtcNow -ge $deadline){throw 'candidate_snapshot_incomplete_retry'}
          $item=$null
          try{
            $item=$filtered.Item($i);if($item.Class -ne 43){continue}
            $r=([datetime]$item.ReceivedTime).ToUniversalTime();$s=([datetime]$item.SentOn).ToUniversalTime();$m=([datetime]$item.LastModificationTime).ToUniversalTime()
            if(($r -ge $lower -and $r -le $upper) -or ($s -ge $lower -and $s -le $upper) -or ($m -ge $lower -and $m -le $upper)){$result.Add(@{folderId=$folderId;entryId=[string]$item.EntryID;modified=$m.ToString('o')})}
          }finally{Release-OutlookObject $item}
        }
      }finally{Release-OutlookObject $filtered;Release-OutlookObject $items;Release-OutlookObject $folder}
      return ,$result.ToArray()
    }
    $provider|Add-Member ScriptMethod Read {
      param($candidate)
      $item=$null;$parent=$null
      try{
        $item=$this.Session.GetItemFromID([string]$candidate.entryId,$this.StoreId);$parent=$item.Parent
        if([string]$parent.EntryID -ne [string]$candidate.folderId -or $item.Class -ne 43){throw 'candidate_scope_changed_review'}
        $internet=Get-CollectionInternetId $item;$search=Get-CollectionMapi $item 'http://schemas.microsoft.com/mapi/proptag/0x300B0102'
        $locator=if($search -is [byte[]]){'search:'+([Convert]::ToBase64String($search))}else{'entry:'+([string]$item.EntryID)}
        $body=[string]$item.Body;$subject=[string]$item.Subject;$rawSender=[string]$item.SenderEmailAddress
        return @{entryId=[string]$item.EntryID;locator=$locator;internetMessageId=$internet;sourceFingerprint=(Get-CollectionHash ($subject+'|'+$rawSender+'|'+$body));sender=(Get-CollectionSender $item);recipients=(Get-CollectionRecipients $item);subject=$subject;body=$body;receivedUtc=([datetime]$item.ReceivedTime).ToUniversalTime().ToString('o');sentUtc=([datetime]$item.SentOn).ToUniversalTime().ToString('o');modifiedUtc=([datetime]$item.LastModificationTime).ToUniversalTime().ToString('o');conversationId=[string]$item.ConversationID}
      }finally{Release-OutlookObject $parent;Release-OutlookObject $item}
    }
    return $provider
  }finally{Release-OutlookObject $root;Release-OutlookObject $sent;Release-OutlookObject $inbox}
}
function New-SelectedJunkProvider($Session,$Store,$Manifest,[string]$ApprovedHash,[string]$Owner) {
  # Hash the same canonical private manifest as the cleanup coordinator, in an isolated scope.
  $actual=& {param($value) . (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library;Get-ManifestHash $value} $Manifest
  if(-not $ApprovedHash -or $actual -cne $ApprovedHash -or $actual -cne [string]$Manifest.manifestHash -or -not $Manifest.complete -or [int]$Manifest.schemaVersion -ne 2 -or [string]$Manifest.schema -cne 'outlook-cleanup-manifest.v2' -or [string]$Manifest.ruleVersion -cne 'cleanup-rules-2026-10-11.2'){throw 'junk_capture_manifest_integrity_or_approval_invalid'}
  if([string]$Manifest.storeId -ne [string]$Store.StoreID -or [string]$Manifest.mailboxBinding -ne (Get-CollectionHash $Owner.ToLowerInvariant())){throw 'junk_capture_mailbox_store_mismatch'}
  $junk=$null
  try{
    $junk=$Store.GetDefaultFolder(23);$junkId=[string]$junk.EntryID
    $source=@($Manifest.sources|Where-Object{$_.defaultFolderId -eq 23 -and $_.folderId -eq $junkId});if($source.Count -ne 1){throw 'junk_capture_source_mismatch'}
    $selected=@($Manifest.items|Where-Object{$_.folderId -eq $junkId -and $_.action -eq 'move' -and (Get-CollectionField $_ 'actionEligible' $false) -and (Get-CollectionField $_ 'evidenceComplete' $false) -and (Get-CollectionField $_ 'bodyStatus' '') -eq 'complete' -and $_.destination -in @('Application receipts','Recruiter follow-ups','Interviews','Assessments','Offers','Rejections')})
    $rows=@{};foreach($row in $selected){if(-not $row.entryId -or $rows.ContainsKey([string]$row.entryId)){throw 'junk_capture_physical_locator_ambiguous'};$rows[[string]$row.entryId]=$row}
    $base=New-OutlookCollectionProvider $Session $Store $null
    $provider=[pscustomobject]@{StoreId=[string]$Store.StoreID;Folders=@(@{id=$junkId;kind='mixed'});Base=$base;Rows=$rows;ScopeSalt=$actual;Owner=$Owner}
    $provider|Add-Member ScriptMethod Candidates {
      param($folderId,$lower,$upper,$deadline)
      return ,@($this.Rows.Values|Where-Object{((Convert-CollectionUtc $_.receivedAt) -ge $lower -and (Convert-CollectionUtc $_.receivedAt) -le $upper) -or ((Convert-CollectionUtc $_.modifiedAt) -ge $lower -and (Convert-CollectionUtc $_.modifiedAt) -le $upper)}|ForEach-Object{@{folderId=$folderId;entryId=$_.entryId;modified=$_.modifiedAt}})
    }
    $provider|Add-Member ScriptMethod Read {
      param($candidate)
      $item=$this.Base.Read($candidate);$row=$this.Rows[[string]$candidate.entryId]
      if([string]$item.sourceFingerprint -ne [string]$row.fingerprint){throw 'junk_capture_content_changed_review'}
      if((Get-CollectionDirection $item 'mixed' $this.Owner) -ne 'inbox'){throw 'junk_capture_direction_uncertain_review'}
      return $item
    }
    return $provider
  }finally{Release-OutlookObject $junk}
}
function Invoke-Collection($Provider,[string]$Owner,[datetime]$Lower,[datetime]$Upper,$Prior,[int]$Limit,[datetime]$Deadline,[switch]$AllMail) {
  $account=Get-CollectionHash $Owner.Trim().ToLowerInvariant();$storeBinding=Get-CollectionHash ([string]$Provider.StoreId)
  $scopeHash=Get-CollectionHash (((@($Provider.Folders|ForEach-Object{[string]$_.id+'|'+[string]$_.kind}|Sort-Object)) -join ';')+'|'+[string](Get-CollectionField $Provider 'ScopeSalt' ''))
  if($Prior -and $Prior.storeBinding -ne $storeBinding){throw 'collection_store_binding_changed'}
  $resuming=$Prior -and -not [bool]$Prior.complete -and $Prior.scopeHash -eq $scopeHash
  $revisions=@{};if($Prior -and $Prior.scopeHash -eq $scopeHash){$old=Get-CollectionField $Prior 'revisions';if($old -is [Collections.IDictionary]){foreach($k in $old.Keys){$revisions[$k]=$old[$k]}}elseif($old){foreach($p in $old.PSObject.Properties){$revisions[$p.Name]=$p.Value}}}
  if($resuming){$state=$Prior;$Upper=Convert-CollectionUtc $state.until;$Lower=Convert-CollectionUtc $state.since}
  else{
    if(-not $Prior -or $Prior.scopeHash -ne $scopeHash){$Lower=$script:CollectionFloor;$revisions=@{}}
    $windows=@();foreach($folder in $Provider.Folders){$windows+=@{folderId=$folder.id;kind=$folder.kind;lower=$Lower.ToString('o');upper=$Upper.ToString('o')}}
    $state=[ordered]@{schemaVersion=1;storeBinding=$storeBinding;scopeHash=$scopeHash;since=$Lower.ToString('o');until=$Upper.ToString('o');windows=$windows;pending=@();revisions=$revisions;complete=$false;reviewCount=0;reviews=@();scanned=0}
  }
  $messages=[Collections.Generic.List[object]]::new();$processed=0;$review=0;$alerts=0
  while($processed -lt $Limit -and [datetime]::UtcNow -lt $Deadline){
    if(@($state.pending).Count -eq 0){
      if(@($state.windows).Count -eq 0){$state.complete=$true;break}
      $window=@($state.windows)[0];$lo=Convert-CollectionUtc $window.lower;$hi=Convert-CollectionUtc $window.upper
      $split=$false
      try{$candidates=@($Provider.Candidates([string]$window.folderId,$lo,$hi,$Deadline))}
      catch{if($_.Exception.Message -match 'split_dense_window' -and ($hi-$lo).TotalMinutes -gt 2){$split=$true;$candidates=@()}else{throw}}
      # Dense ranges split; final equal timestamps become durable locators, never persisted COM indices.
      if($split -or ($candidates.Count -gt $Limit -and ($hi-$lo).TotalMinutes -gt 2)){
        $middle=$lo.AddTicks([long](($hi.Ticks-$lo.Ticks)/2));$rest=@($state.windows|Select-Object -Skip 1)
        $state.windows=@(@{folderId=$window.folderId;kind=$window.kind;lower=$lo.ToString('o');upper=$middle.ToString('o')},@{folderId=$window.folderId;kind=$window.kind;lower=$middle.ToString('o');upper=$hi.ToString('o')})+$rest;continue
      }
      $state.pending=@($candidates|ForEach-Object{@{folderId=$_.folderId;entryId=$_.entryId;modified=$_.modified;kind=$window.kind}})
      $state.windows=@($state.windows|Select-Object -Skip 1);if(@($state.pending).Count -eq 0){continue}
    }
    $candidate=@($state.pending)[0];$locator=Get-CollectionHash ($storeBinding+'|'+$candidate.folderId+'|'+$candidate.entryId);$revision=(Convert-CollectionUtc $candidate.modified).ToString('o')
    if($revisions.ContainsKey($locator) -and (Convert-CollectionUtc $revisions[$locator]).Ticks -eq (Convert-CollectionUtc $revision).Ticks){$state.pending=@($state.pending|Select-Object -Skip 1);$processed++;continue}
    try{
      $item=$Provider.Read($candidate);if((Convert-CollectionUtc $item.modifiedUtc).Ticks -ne (Convert-CollectionUtc $revision).Ticks){throw 'candidate_revision_changed_review'}
      $direction=Get-CollectionDirection $item ([string]$candidate.kind) $Owner;if(-not $direction){throw 'direction_uncertain_review'}
      $occurred=Convert-CollectionUtc $(if($direction -eq 'sentitems'){$item.sentUtc}else{$item.receivedUtc})
      if($occurred -ge $script:CollectionFloor -and $occurred -le $Upper){
        if(([string]$item.body).Length -gt 2000000){throw 'body_size_review'}
        $evidence=Get-CollectionEvidence ([string]$item.subject) ([string]$item.body) -AllMail:$AllMail;if($evidence.Alert){$alerts++}
        if($evidence.Relevant){
          $identity=if($item.internetMessageId){'internet:'+([string]$item.internetMessageId).Trim().ToLowerInvariant()}else{[string]$item.locator}
          $messages.Add([ordered]@{immutableId=(Get-CollectionHash ($account+'|'+$identity));folder=$direction;subject=(Limit-CollectionText ([string]$item.subject) 500);sender=(Limit-CollectionText ([string]$item.sender) 320);excerpt=$evidence.Excerpt;occurredAt=$occurred.ToString('o');conversationId=(Limit-CollectionText ([string]$item.conversationId) 1000);internetMessageId=(Limit-CollectionText ([string]$item.internetMessageId) 1000);revision=[string]$item.modifiedUtc})
        }
      }
      $revisions[$locator]=$revision
    }catch{$review++;$state.reviews=@($state.reviews)+@(@{candidate=$candidate;reason=if($_.Exception.Message -match '^[a-z_]+$'){$_.Exception.Message}else{'item_read_failed_review'}})}
    $state.pending=@($state.pending|Select-Object -Skip 1);$processed++
  }
  if(@($state.pending).Count -eq 0 -and @($state.windows).Count -eq 0){$state.complete=$true}
  $state.revisions=$revisions;$state.reviewCount=[int]$state.reviewCount+$review;$state.scanned=[int]$state.scanned+$processed
  return [ordered]@{schemaVersion=1;format='job-search-intelligence.outlook-com.v1';accountId=$account;exportedAt=$Upper.ToString('o');since=$Lower.ToString('o');messages=$messages.ToArray();summary=@{truncated=$false;scanned=$processed;matched=$messages.Count};collection=@{schemaVersion=1;storeBinding=$storeBinding;complete=[bool]$state.complete;evidenceComplete=([bool]$state.complete -and $state.reviewCount -eq 0);reviewCount=$review;alertsKeptLocal=$alerts;cacheCompleteness='unverified';nextState=$state}}
}
function New-CollectorOutlookApplication {
  if($script:CollectorOutlookFactory){return (& $script:CollectorOutlookFactory)}
  if($null -eq [type]::GetTypeFromProgID('Outlook.Application')){throw 'Classic Outlook COM is not registered.'}
  return New-Object -ComObject Outlook.Application
}
function Invoke-CollectorRun {
if(-not $Mailbox){throw 'Mailbox is required.'}
$outlook=$null;$session=$null;$accounts=$null;$account=$null;$store=$null
try{
  $outlook=New-CollectorOutlookApplication;$session=$outlook.GetNamespace('MAPI');$accounts=$session.Accounts;$matches=0
  for($i=1;$i -le $accounts.Count;$i++){$candidate=$accounts.Item($i);if($candidate.SmtpAddress -ieq $Mailbox){$matches++;if($account){Release-OutlookObject $account};$account=$candidate}else{Release-OutlookObject $candidate}}
  if($matches -ne 1){throw 'Requested mailbox must resolve to exactly one Outlook account.'}
  $store=$account.DeliveryStore;if(-not $store){throw 'Selected account has no delivery store.'}
  Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force -DisableNameChecking
  $approved=$null
  if($ApprovedFoldersPath){
    if(-not(Test-Path -LiteralPath $ApprovedFoldersPath)){throw 'Approved folder configuration is missing.'}
    $ctx=New-PrivateRuntimeContext -StateRoot ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ApprovedFoldersPath))) -Environment 'outlook-cleanup' -MailboxBinding (Get-CollectionHash $Mailbox.ToLowerInvariant()) -ConfigVersion 'cleanup-v1'
    $approved=Read-ProtectedJson $ApprovedFoldersPath $ctx
  }
  $provider=New-OutlookCollectionProvider $session $store $approved
  if($ValidateOnly){[pscustomobject]@{classicOutlook=$true;mailboxConfigured=$true;selectedFolders=$provider.Folders.Count;approvedSubtree=[bool]$approved;storeBinding=(Get-CollectionHash $provider.StoreId);cacheCompleteness='unverified'}|ConvertTo-Json -Compress;return}
  if(-not $OutputPath){throw 'OutputPath is required.'}
  if($JunkManifestPath -or $JunkApprovalHash){
    if(-not $JunkManifestPath -or -not $JunkApprovalHash -or -not $RuntimeContext){throw 'One-time Junk capture requires private manifest, exact approved hash and runtime context.'}
    $cleanupContext=New-PrivateRuntimeContext -StateRoot $RuntimeContext.StateRoot -Environment 'outlook-cleanup' -MailboxBinding (Get-CollectionHash $Mailbox.ToLowerInvariant()) -ConfigVersion 'cleanup-v1'
    $manifest=Read-ProtectedJson $JunkManifestPath $cleanupContext
    $provider=New-SelectedJunkProvider $session $store $manifest $JunkApprovalHash $Mailbox
  }
  $destination=[IO.Path]::GetFullPath($OutputPath);if([IO.Path]::GetExtension($destination) -ne '.json'){throw 'OutputPath must end in .json.'}
  if([IO.File]::Exists($destination) -and -not $Force){throw 'OutputPath exists; use a new path or Force.'}
  $prior=$null;if($StatePath){if(-not $RuntimeContext){throw 'Protected collector state requires RuntimeContext.'};$prior=Read-ProtectedJson $StatePath $RuntimeContext}
  $lower=Convert-CollectionUtc $Since;$upper=if($Until){Convert-CollectionUtc $Until}else{[datetime]::UtcNow};if($lower -lt $script:CollectionFloor -or $lower -gt $upper){throw 'Invalid collection UTC bounds.'}
  $bundle=Invoke-Collection $provider $Mailbox $lower $upper $prior $MaxMessagesPerFolder ([datetime]::UtcNow.AddSeconds($BudgetSeconds)) -AllMail:$IncludeAllMail
  if(-not $StatePath -and -not $bundle.collection.complete){$bundle.summary.truncated=$true}
  $parent=[IO.Path]::GetDirectoryName($destination);[IO.Directory]::CreateDirectory($parent)|Out-Null
  if($ProtectedOutput){if(-not $RuntimeContext){throw 'ProtectedOutput requires RuntimeContext.'};Save-ProtectedJsonAtomic -Path $destination -Value $bundle -Context $RuntimeContext}
  else{[IO.File]::WriteAllText($destination,(ConvertTo-Json -InputObject $bundle -Depth 30 -Compress),[Text.UTF8Encoding]::new($false))}
  [pscustomobject]@{output=$destination;messages=@($bundle.messages).Count;complete=$bundle.collection.complete;reviewCount=$bundle.collection.reviewCount}|ConvertTo-Json -Compress
}finally{foreach($o in @($store,$account,$accounts,$session,$outlook)){Release-OutlookObject $o}}
}
if($Library){return}
Invoke-CollectorRun

[CmdletBinding(DefaultParameterSetName='Inventory')]
param(
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')][string]$Mailbox,
  [string]$StateRoot,
  [ValidateSet('Inventory','Review','CreateTaxonomy','Execute','Recover','VerifySyntheticRestore','FinalizeSyntheticRestore')][string]$Mode = 'Inventory',
  [string]$ManifestPath,
  [string]$ReviewOutputPath,
  [string]$ApprovedFoldersPath,
  [string]$BackendIdleProofPath,
  [string]$SyntheticAcceptanceProofPath,
  [string]$RolloutAcceptanceProofPath,
  [ValidateRange(1,1099511627776)][long]$BackupCeilingBytes,
  [string]$ApprovalHash,
  [switch]$SelfTest,
  [switch]$Library
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:InboxId = 6; $script:JunkId = 23; $script:DeletedId = 3
$script:OutlookFactory = $null
$script:TaxonomySessionFactory = $null
$script:TaxonomyMutexFactory = $null
$script:RuntimeContextFactory = $null
$script:SyntheticNamespaceFactory = $null
$script:SyntheticCleanupRemover = $null
$script:SyntheticMutexFactory = $null
$script:Clock = $null
$script:RootName = 'Job Search'
$script:Taxonomy = @('Application receipts','Recruiter follow-ups','Interviews','Assessments','Offers','Rejections','Job alerts','Review')

function Get-StringHash([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Get-CleanupUtcNow {if($script:Clock){return ([datetime](& $script:Clock)).ToUniversalTime()};return [datetime]::UtcNow}
function ConvertTo-CleanupUtcDate($Value){if($Value -is [datetime]){return $Value.ToUniversalTime()};return [datetime]::Parse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()}
function New-CleanupRuntimeContext([string]$Root,[string]$Environment,[string]$Binding,[string]$Version){if($script:RuntimeContextFactory){return & $script:RuntimeContextFactory $Root $Environment $Binding $Version};return New-PrivateRuntimeContext -StateRoot $Root -Environment $Environment -MailboxBinding $Binding -ConfigVersion $Version}
function Test-ActionBudget([int]$Processed,[int]$Limit,[datetime]$Deadline){if($Processed -ge $Limit){return $false};$now=Get-CleanupUtcNow;return ($now -lt $Deadline.ToUniversalTime())}
function Get-Field($Object,[string]$Name,$Default=$null) {
  if ($null -eq $Object) { return $Default }
  if($Object -is [Collections.IDictionary]){if($Object.Contains($Name)){return $Object[$Name]} ;return $Default}
  $p=$Object.PSObject.Properties[$Name]; if ($null -eq $p) { return $Default }; return $p.Value
}
function Get-JournalStatus($Journal,$RowId) {
  $state=Get-Field $Journal $RowId $null
  return [string](Get-Field $state 'status' '')
}
function Get-ActionRows($Manifest) { return ,@($Manifest.items|Where-Object{$_.action -in 'move','delete_to_deleted_items'}) }
function Get-RequiredCaptureRows($Manifest){
  $floor=[datetime]::Parse('2026-09-30T07:00:00Z',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $evidence=@('Application receipts','Recruiter follow-ups','Interviews','Assessments','Offers','Rejections')
  return ,@($Manifest.items|Where-Object{if($_.action -ne 'move' -or $_.class -notin $evidence -or -not $_.receivedAt){return $false};try{$date=ConvertTo-CleanupUtcDate $_.receivedAt;return $date -ge $floor}catch{return $false}})
}
function Get-ActionRowsNeedingBackup($Manifest,$Journal) {$result=[Collections.Generic.List[object]]::new();foreach($row in @($Manifest.items)){if($row.action -in 'move','delete_to_deleted_items' -and (Get-JournalStatus $Journal $row.rowId) -notin 'backup_verified','move_started','completed'){$result.Add($row)}};return ,$result.ToArray()}
function Get-CandidateSetHash($Rows) {
  $ids=@($Rows|ForEach-Object{[string]$_.rowId}|Sort-Object -CaseSensitive)
  return Get-StringHash (ConvertTo-Json -InputObject $ids -Compress)
}
function ConvertTo-HtmlEncoded([object]$Value){return [System.Net.WebUtility]::HtmlEncode([string]$Value)}
function Assert-ManifestActionScope($Manifest) {
  if(@($Manifest.sources).Count -ne 2 -or [string]::IsNullOrWhiteSpace([string]$Manifest.sources[0].folderId) -or [string]::IsNullOrWhiteSpace([string]$Manifest.sources[1].folderId) -or [string]$Manifest.sources[0].folderId -ceq [string]$Manifest.sources[1].folderId -or [int]$Manifest.sources[0].defaultFolderId -ne 6 -or [int]$Manifest.sources[1].defaultFolderId -ne 23 -or [string]$Manifest.sources[0].folder -cne 'Inbox' -or [string]$Manifest.sources[1].folder -cne 'Junk'){throw 'Manifest source folders must be exactly the selected account Inbox and Junk defaults.'}
  $allowedFolders=@($Manifest.sources|ForEach-Object{[string]$_.folderId})
  $seen=@{}
  foreach($row in @($Manifest.items)){
    $rowId=[string]$row.rowId
    if($rowId -notmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($rowId)){throw 'Manifest physical row keys must be unique opaque SHA-256 values.'};$seen[$rowId]=$true
    if([string]$row.storeId -cne [string]$Manifest.storeId -or [string]$row.folderId -notin $allowedFolders){throw 'Manifest item escaped the selected store or direct Inbox/Junk source scope.'}
    if(([string]$row.folderId -ceq [string]$Manifest.sources[0].folderId -and [string]$row.folder -cne 'Inbox') -or ([string]$row.folderId -ceq [string]$Manifest.sources[1].folderId -and [string]$row.folder -cne 'Junk E-mail')){throw 'Manifest item folder label does not match its approved direct source folder.'}
    if($row.action -eq 'delete_to_deleted_items'){
      if($row.class -cne 'Delete candidate' -or $row.destination -cne 'Delete candidate'){throw 'Only explicit non-job delete candidates may move to Deleted Items.'}
    }elseif($row.action -eq 'move'){
      if($script:Taxonomy -cnotcontains [string]$row.class -or [string]$row.destination -cne [string]$row.class){throw 'Move action destination must be exactly one approved job taxonomy child.'}
    }elseif($row.action -ne 'review'){throw 'Manifest contains a prohibited action; only same-store Move and Review are supported.'}
  }
}
function Set-JournalItem($Journal,[string]$RowId,$Updates) {
  $previous=Get-Field $Journal $RowId $null
  $merged=[ordered]@{}
  if($previous){foreach($key in $previous.Keys){$merged[$key]=$previous[$key]}}
  foreach($key in $Updates.Keys){$merged[$key]=$Updates[$key]}
  $Journal[$RowId]=$merged
}
function Get-Classification([string]$Subject,[string]$Body,[string]$Sender,[bool]$HasAttachments=$false,[bool]$IsProtected=$false) {
  $cleanBody=($Body -replace '(?is)(^|\n)\s*(from:|on .{1,100}wrote:|-----original message-----).*$', '')
  $text = ($Subject + "`n" + $cleanBody)
  $s = $Subject.ToLowerInvariant(); $b = $cleanBody.ToLowerInvariant(); $t = $text.ToLowerInvariant(); $senderText = $Sender.ToLowerInvariant()
  $jobSignal = ($t -match '\b(job|career|position|application|recruiter|interview|assessment|offer|candidate|vacancy|hiring)\b') -or ($s -match '\b(job|career|position|application|recruiter|interview|assessment|offer|candidate|vacancy|hiring)\b')
  if ($IsProtected -or (($Body.Trim().Length -eq 0) -and $HasAttachments)) { return @{ Class='Review'; Confidence='low'; Reason='protected_or_attachment_only'; Sensitive=$false } }
  if($t -match '\b(verify your account|account suspended|urgent wire transfer|prize winner|crypto wallet|confirm your password|verify your password|click here to restore access|unusual sign-in activity)\b' -or $t -match '\b(password|account|payment)\b.{0,50}\b(click|link)\b.{0,30}\b(verify|confirm|restore|unlock)\b'){return @{Class='Review';Confidence='low';Reason='suspicious_content';Sensitive=$false}}
  if ($s -match '\b(job offer tips|special offer|limited offer|offer inside)\b') { $jobSignal=$false }
  $offer=($s -match '\b(offer letter|offer of employment|compensation package|background check|pre-employment)\b') -or ($b -match '\b(we are pleased to offer you (employment|the position)|offer of employment|compensation package|background check steps|pre-employment check)\b')
  $reject=($s -match '\b(rejected|regret to inform|not moving forward|position has been filled|application unsuccessful|withdrawn|candidacy closed)\b') -or ($b -match '\b(regret to inform you|we will not be moving forward|not moving forward with your application|your candidacy is closed)\b')
  $assessment=($s -match '\b(assessment|coding exercise|technical test|take-home|complete the test)\b') -or ($b -match '\b(please complete (the|our) (assessment|technical test|coding exercise)|assessment deadline|submit your exercise by)\b')
  $interview=($s -match '\b(interview|schedule a call|screening call|availability for a call)\b') -or ($b -match '\b(invite you to (an? )?interview|schedule (an? )?interview|availability for (an? )?interview|would like to interview you)\b')
  $receipt=($s -match '\b(application received|application confirmation|thank you for applying|we received your application|submission confirmation)\b') -or ($b -match '\b(we have received your application|thank you for submitting your application|application was successfully submitted)\b')
  $otherSubstantive=0;foreach($signal in @($offer,$reject,$assessment)){if($signal){$otherSubstantive++}}
  if($otherSubstantive -gt 1 -or (($interview -or $receipt) -and ($offer -or $reject -or $assessment))){return @{Class='Review';Confidence='low';Reason='conflicting_current_purposes';Sensitive=$false}}
  if ($offer) { return @{ Class='Offers'; Confidence='high'; Reason='explicit_offer_stage'; Sensitive=$false } }
  if ($reject) { return @{ Class='Rejections'; Confidence='high'; Reason='explicit_negative_outcome'; Sensitive=$false } }
  if ($assessment) { return @{ Class='Assessments'; Confidence='high'; Reason='assessment_action'; Sensitive=$false } }
  if ($interview) { return @{ Class='Interviews'; Confidence='high'; Reason='interview_action'; Sensitive=$false } }
  if ($receipt) { return @{ Class='Application receipts'; Confidence='high'; Reason='submission_confirmation'; Sensitive=$false } }
  if ($s -match '\b(recruiter|talent acquisition|screening|your application|following up|opportunity at)\b' -and $t -match '\b(position|role|job|application|candidate|recruiter|interview)\b') { return @{ Class='Recruiter follow-ups'; Confidence='medium'; Reason='individual_recruiting_correspondence'; Sensitive=$false } }
  if ($s -match '\b(jobs? for you|job alert|new jobs|weekly jobs|career opportunities|vacancies matching)\b') { return @{ Class='Job alerts'; Confidence='high'; Reason='generic_job_alert'; Sensitive=$false } }
  if ($jobSignal) { return @{ Class='Review'; Confidence='low'; Reason='potential_job_purpose_uncertain'; Sensitive=$false } }
  $sensitive = $t -match '\b(account number|bank|credit card|medical|diagnosis|password|security code|tax return|social security|invoice|payment|salary|payroll)\b'
  if($Body.Trim().Length -lt 24 -or [string]::IsNullOrWhiteSpace($Subject)){return @{Class='Review';Confidence='low';Reason='insufficient_content_for_nonjob_decision';Sensitive=$false}}
  return @{ Class='Delete candidate'; Confidence='high'; Reason= if ($sensitive) { 'confident_nonjob_sensitive' } else { 'no_job_evidence_with_complete_content' }; Sensitive=[bool]$sensitive }
}
function Get-ItemRecord($Item,[string]$StoreId,[string]$FolderId,[string]$FolderLabel) {
  if([int](Get-Field $Item 'Class' 0) -ne 43){$entry=[string](Get-Field $Item 'EntryID' '');return [ordered]@{rowId=(Get-StringHash ($StoreId+'|'+$FolderId+'|unsupported|'+$entry));storeId=$StoreId;folderId=$FolderId;folder=$FolderLabel;entryId=$entry;searchKey='';internetMessageId='';conversationId='';receivedAt=$null;modifiedAt=$null;fingerprint='';bodyHash='';bodyLength=0;bodyStatus='unsupported';unread=$false;flagged=$false;categories='';attachmentCount=0;attachmentMetadata=@();class='Review';confidence='low';reason='unsupported_item_class';action='review';destination='Review';sensitive=$false;inaccessible=$false}}
  $subject=[string](Get-Field $Item 'Subject' ''); $body=''; $bodyStatus='complete'
  try { $body=[string](Get-Field $Item 'Body' '') } catch { $bodyStatus='unavailable' }
  $attachments=@();$attachmentCollection=Get-Field $Item 'Attachments'; try { for($i=1;$i -le [int](Get-Field $attachmentCollection 'Count' 0);$i++) { $a=$null;try{$a=$attachmentCollection.Item($i);$attachments+=@{ Name=[string](Get-Field $a 'FileName' ''); Size=[int](Get-Field $a 'Size' 0); Type=[int](Get-Field $a 'Type' 0) }}finally{if($a -and [Runtime.InteropServices.Marshal]::IsComObject($a)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($a)}} } } catch { $bodyStatus='incomplete' } finally{if($attachmentCollection -and [Runtime.InteropServices.Marshal]::IsComObject($attachmentCollection)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($attachmentCollection)}}
  $sender=[string](Get-Field $Item 'SenderEmailAddress' '')
  $protected=[bool](Get-Field $Item 'Protected' $false)
  try{$permissionProperty=$Item.PSObject.Properties['Permission'];if($null -ne $permissionProperty){$permission=Get-Field $Item 'Permission' $null;if($null -eq $permission -or [int]$permission -ne 0){$protected=$true}}}catch{$protected=$true}
  try{$messageClassProperty=$Item.PSObject.Properties['MessageClass'];if($null -ne $messageClassProperty){$messageClass=Get-Field $Item 'MessageClass' $null;if($null -eq $messageClass -or [string]$messageClass -match '^IPM\.Note\.SMIME'){$protected=$true}}}catch{$protected=$true}
  $classification=Get-Classification $subject $body $sender ($attachments.Count -gt 0) $protected
  if ($bodyStatus -ne 'complete') { $classification=@{ Class='Review'; Confidence='low'; Reason='body_incomplete'; Sensitive=$false } }
  $entry=[string](Get-Field $Item 'EntryID' '');$internet='';try{$internet=[string](Get-Field $Item 'InternetMessageID' '')}catch{};$conversation='';try{$conversation=[string](Get-Field $Item 'ConversationID' '')}catch{};$searchKey=''
  $accessor=$null;try{$accessor=$Item.PropertyAccessor;$searchKey=[Convert]::ToBase64String([byte[]]$accessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x300B0102'))}catch{}finally{if($accessor -and [Runtime.InteropServices.Marshal]::IsComObject($accessor)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($accessor)}}
  $received=Get-Field $Item 'ReceivedTime'; $modified=Get-Field $Item 'LastModificationTime'
  $rowKey=Get-StringHash ($StoreId+'|'+$FolderId+'|'+$entry+'|'+[string]$received+'|'+[guid]::NewGuid().ToString('N'))
  $fingerprint=Get-StringHash ($subject+'|'+$sender+'|'+$body)
  return [ordered]@{
    rowId=$rowKey; storeId=$StoreId; folderId=$FolderId; folder=$FolderLabel; entryId=$entry; searchKey=$searchKey; internetMessageId=$internet; conversationId=$conversation
    subject=$subject; sender=$sender; receivedAt= if($received){([datetime]$received).ToUniversalTime().ToString('o')}else{$null}
    modifiedAt= if($modified){([datetime]$modified).ToUniversalTime().ToString('o')}else{$null}; fingerprint=$fingerprint
    bodyHash=(Get-StringHash $body); bodyLength=[Text.Encoding]::UTF8.GetByteCount($body); bodyStatus=$bodyStatus; unread=[bool](Get-Field $Item 'UnRead' $false); flagged=([int](Get-Field $Item 'FlagStatus' 0) -ne 0)
    categories=[string](Get-Field $Item 'Categories' ''); attachmentCount=$attachments.Count; attachmentMetadata=$attachments; protected=$protected
    class=$classification.Class; confidence=$classification.Confidence; reason=$classification.Reason; sensitive=$classification.Sensitive
    action=if($classification.Class -eq 'Delete candidate'){'delete_to_deleted_items'}elseif($classification.Class -eq 'Review'){'review'}else{'move'}; destination=$classification.Class
  }
}
function Get-OutlookInventory([string]$MailboxAddress) {
  $ol=$null; $ns=$null; $store=$null; $inbox=$null; $junk=$null; $accounts=$null; $account=$null; $matches=$null
  try {
    if ($script:OutlookFactory) { $ol=& $script:OutlookFactory } else { $ol=New-Object -ComObject Outlook.Application }
    $ns=$ol.GetNamespace('MAPI')
    $accounts=$ns.Accounts
    $matches=[Collections.Generic.List[object]]::new()
    for ($i=1; $i -le [int]$accounts.Count; $i++) {
      $candidate=$null
      try {
        $candidate=$accounts.Item($i)
        if ([string]::Equals([string]$candidate.SmtpAddress,$MailboxAddress,[StringComparison]::OrdinalIgnoreCase)) { $matches.Add($candidate) }
        elseif ($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate) }
      } catch {
        if ($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate) }
        throw
      }
    }
    if ($matches.Count -ne 1) { throw 'Selected mailbox store must resolve to exactly one store by exact mailbox address.' }
    $account=$matches[0]; $store=$account.DeliveryStore
    $inbox=$store.GetDefaultFolder($script:InboxId); $junk=$store.GetDefaultFolder($script:JunkId)
    $records=[Collections.Generic.List[object]]::new(); $enumerationComplete=$true;$evidenceComplete=$true
    foreach ($pair in @(@($inbox,'Inbox'),@($junk,'Junk E-mail'))) {
      $folder=$pair[0]; $label=$pair[1]; $items=$folder.Items
      try {
        $initialCount=[int]$items.Count
        for ($i=1; $i -le $initialCount; $i++) {
          if(($i % 500) -eq 0){Write-Progress -Activity 'Private mailbox inventory' -Status ("Inspected {0} of {1} items in this folder" -f $i,$initialCount) -PercentComplete ([int](100*$i/[Math]::Max(1,$initialCount)))}
          $item=$null
          try {
            $item=$items.Item($i)
            $record=Get-ItemRecord $item ([string]$store.StoreID) ([string]$folder.EntryID) $label
            $records.Add($record)
            if([string]$record.bodyStatus -ne 'complete' -or [bool](Get-Field $record 'protected' $false)){$evidenceComplete=$false};if([string]::IsNullOrWhiteSpace([string]$record.entryId)){$enumerationComplete=$false;$evidenceComplete=$false}
          } catch {
            $enumerationComplete=$false;$evidenceComplete=$false
            $records.Add([ordered]@{rowId=(Get-StringHash ($store.StoreID+$folder.EntryID+$i));storeId=[string]$store.StoreID;folderId=[string]$folder.EntryID;folder=$label;entryId='';bodyStatus='unavailable';class='Review';confidence='low';reason='item_inaccessible';action='review';destination='Review';sensitive=$false;inaccessible=$true})
          } finally {
            if ($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) }
          }
        }
        if ([int]$items.Count -ne $initialCount) { $enumerationComplete=$false;$evidenceComplete=$false }
      } finally {
        Write-Progress -Activity 'Private mailbox inventory' -Completed
        if ($items -and [Runtime.InteropServices.Marshal]::IsComObject($items)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($items) }
      }
    }
    return @{storeId=[string]$store.StoreID;inboxId=[string]$inbox.EntryID;junkId=[string]$junk.EntryID;items=$records.ToArray();complete=$enumerationComplete;evidenceComplete=$evidenceComplete}
  } finally {
    if ($matches) { foreach ($candidate in $matches) { if ($candidate -and -not [object]::ReferenceEquals($candidate,$account) -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate) } } }
    foreach ($o in @($junk,$inbox,$store,$account,$accounts,$ns,$ol)) { if ($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } }
  }
}
if(-not ('JobSearchIntelligence.CanonicalManifestJson' -as [type])){
  $canonicalJsonSource=@'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace JobSearchIntelligence {
  public static class CanonicalManifestJson {
    public static string Serialize(object value) {
      StringBuilder output = new StringBuilder();
      Write(value, true, output);
      return output.ToString();
    }
    public static string Hash(object value) {
      using (SHA256 sha = SHA256.Create()) {
        byte[] digest = sha.ComputeHash(new UTF8Encoding(false).GetBytes(Serialize(value)));
        StringBuilder hex = new StringBuilder(digest.Length * 2);
        foreach (byte item in digest) hex.Append(item.ToString("x2", CultureInfo.InvariantCulture));
        return hex.ToString();
      }
    }
    private static void Write(object value, bool root, StringBuilder output) {
      if (value == null) { output.Append("null"); return; }
      if (value is bool) { output.Append((bool)value ? "true" : "false"); return; }
      if (value is DateTime) {
        AppendString(((DateTime)value).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture), output); return;
      }
      if (value is DateTimeOffset) {
        AppendString(((DateTimeOffset)value).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture), output); return;
      }
      if (value is string) { AppendString((string)value, output); return; }
      IDictionary dictionary = value as IDictionary;
      if (dictionary != null) {
        List<string> keys = new List<string>();
        foreach (object key in dictionary.Keys) keys.Add(Convert.ToString(key, CultureInfo.InvariantCulture));
        keys.Sort(StringComparer.Ordinal);
        output.Append('{'); bool first = true;
        foreach (string key in keys) {
          if (root && String.Equals(key, "manifestHash", StringComparison.Ordinal)) continue;
          if (!first) output.Append(','); first = false;
          AppendString(key, output); output.Append(':'); Write(dictionary[key], false, output);
        }
        output.Append('}'); return;
      }
      IEnumerable enumerable = value as IEnumerable;
      if (enumerable != null) {
        output.Append('['); bool first = true;
        foreach (object entry in enumerable) { if (!first) output.Append(','); first = false; Write(entry, false, output); }
        output.Append(']'); return;
      }
      Type type = value.GetType();
      if (type == typeof(byte)) { output.Append(((byte)value).ToString(CultureInfo.InvariantCulture)); return; }
      if (type == typeof(sbyte) || type == typeof(short) || type == typeof(ushort) || type == typeof(int) || type == typeof(uint) || type == typeof(long) || type == typeof(ulong) || type == typeof(decimal)) {
        output.Append(Convert.ToString(value, CultureInfo.InvariantCulture)); return;
      }
      if (type == typeof(float) || type == typeof(double)) {
        double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(number) || Double.IsInfinity(number)) throw new InvalidOperationException("Non-finite values are not valid in canonical manifests.");
        output.Append(number.ToString("R", CultureInfo.InvariantCulture)); return;
      }
      Type psObjectType = Type.GetType("System.Management.Automation.PSObject, System.Management.Automation", true);
      MethodInfo asPsObject = null;
      foreach (MethodInfo method in psObjectType.GetMethods(BindingFlags.Public | BindingFlags.Static)) {
        ParameterInfo[] parameters = method.GetParameters();
        if (method.Name == "AsPSObject" && parameters.Length == 1 && parameters[0].ParameterType == typeof(object)) { asPsObject = method; break; }
      }
      object wrapped = asPsObject.Invoke(null, new object[] { value });
      object propertyCollection = psObjectType.GetProperty("Properties").GetValue(wrapped, null);
      List<object> properties = new List<object>();
      foreach (object property in (IEnumerable)propertyCollection) {
        Type propertyType = property.GetType();
        string memberType = Convert.ToString(propertyType.GetProperty("MemberType").GetValue(property, null), CultureInfo.InvariantCulture);
        if (memberType == "NoteProperty" || memberType == "Property" || memberType == "AliasProperty") properties.Add(property);
      }
      properties.Sort(delegate(object left, object right) {
        string leftName = Convert.ToString(left.GetType().GetProperty("Name").GetValue(left, null), CultureInfo.InvariantCulture);
        string rightName = Convert.ToString(right.GetType().GetProperty("Name").GetValue(right, null), CultureInfo.InvariantCulture);
        return StringComparer.Ordinal.Compare(leftName, rightName);
      });
      output.Append('{'); bool firstProperty = true;
      foreach (object property in properties) {
        Type propertyType = property.GetType();
        string name = Convert.ToString(propertyType.GetProperty("Name").GetValue(property, null), CultureInfo.InvariantCulture);
        if (root && String.Equals(name, "manifestHash", StringComparison.Ordinal)) continue;
        if (!firstProperty) output.Append(','); firstProperty = false;
        AppendString(name, output); output.Append(':'); Write(propertyType.GetProperty("Value").GetValue(property, null), false, output);
      }
      output.Append('}');
    }
    private static void AppendString(string value, StringBuilder output) {
      output.Append('"');
      for (int index = 0; index < value.Length; index++) {
        char character = value[index];
        switch (character) {
          case '\\': output.Append("\\\\"); break;
          case '"': output.Append("\\\""); break;
          case '\b': output.Append("\\b"); break;
          case '\t': output.Append("\\t"); break;
          case '\n': output.Append("\\n"); break;
          case '\f': output.Append("\\f"); break;
          case '\r': output.Append("\\r"); break;
          default:
            if (character <= 0x1f) output.Append("\\u" + ((int)character).ToString("x4", CultureInfo.InvariantCulture));
            else output.Append(character);
            break;
        }
      }
      output.Append('"');
    }
  }
}
'@
  Add-Type -TypeDefinition $canonicalJsonSource -ErrorAction Stop
}
function Get-ManifestHash($Manifest) {return [JobSearchIntelligence.CanonicalManifestJson]::Hash($Manifest)}
function ConvertTo-MutableMap($Value){
  if($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]){return $Value}
  if($Value -is [Collections.IDictionary]){$map=[ordered]@{};foreach($key in $Value.Keys){$map[$key]=ConvertTo-MutableMap $Value[$key]};return ,$map}
  if($Value -is [Collections.IEnumerable]){$list=[Collections.Generic.List[object]]::new();foreach($entry in $Value){$list.Add((ConvertTo-MutableMap $entry))};return ,$list.ToArray()}
  $map=[ordered]@{};foreach($property in $Value.PSObject.Properties){$map[$property.Name]=ConvertTo-MutableMap $property.Value};return ,$map
}
function New-InventoryManifest($Inventory,[string]$MailboxAddress) {
  $items=@($Inventory.items); $sensitive=@($items|Where-Object{$_.action -eq 'delete_to_deleted_items' -and (Get-Field $_ 'sensitive' $false)})
  $floor=[datetime]::Parse('2026-09-30T07:00:00Z',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $preFloor=@($items|Where-Object{if($_.action -ne 'delete_to_deleted_items' -or -not $_.receivedAt){return $false};try{$date=ConvertTo-CleanupUtcDate $_.receivedAt;return $date -lt $floor}catch{return $false}}).Count
  $manifest=[ordered]@{ schema='outlook-cleanup-manifest.v1'; schemaVersion=1; utilityVersion='1.0.0'; ruleVersion='cleanup-rules-2026-10-11.1'; createdAt=[datetime]::UtcNow.ToString('o'); mailboxBinding=(Get-StringHash $MailboxAddress.ToLowerInvariant()); storeId=$Inventory.storeId; sources=@(@{folderId=$Inventory.inboxId;folder='Inbox';defaultFolderId=6},@{folderId=$Inventory.junkId;folder='Junk';defaultFolderId=23}); complete=[bool]$Inventory.complete;evidenceComplete=[bool](Get-Field $Inventory 'evidenceComplete' $Inventory.complete); itemCount=$items.Count; summary=@{ byClass=@{}; unreadDeleteCount=@(@($items|Where-Object{$_.action -eq 'delete_to_deleted_items' -and (Get-Field $_ 'unread' $false)})).Count; flaggedDeleteCount=@(@($items|Where-Object{$_.action -eq 'delete_to_deleted_items' -and (Get-Field $_ 'flagged' $false)})).Count; sensitiveDeleteCount=$sensitive.Count; attachmentDeleteCount=@(@($items|Where-Object{$_.action -eq 'delete_to_deleted_items' -and [int](Get-Field $_ 'attachmentCount' 0) -gt 0})).Count; preFloorDeleteCount=$preFloor }; items=$items }
  foreach($row in $items){$groupName=[string](Get-Field $row 'class' 'Unclassified');if([string]::IsNullOrWhiteSpace($groupName)){$groupName='Unclassified'};if(-not $manifest.summary.byClass.Contains($groupName)){$manifest.summary.byClass[$groupName]=0};$manifest.summary.byClass[$groupName]++}
  $manifest.manifestHash=Get-ManifestHash $manifest; return $manifest
}
function Assert-PrivateRoot([string]$Path) {
  if([string]::IsNullOrWhiteSpace($Path) -or [IO.Path]::IsPathRooted($Path) -eq $false){throw 'StateRoot must be an absolute private path.'}
  $full=[IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  $repo=[IO.Directory]::GetParent($PSScriptRoot).FullName.TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  if($full.Equals($repo,[StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($repo+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Private cleanup state cannot be inside the repository.'}
  [IO.Directory]::CreateDirectory($full)|Out-Null;return $full
}
function Assert-CleanupPrivatePath([string]$Path,$Context) {
  $full=[IO.Path]::GetFullPath($Path);$root=[IO.Path]::GetFullPath([string]$Context.StateRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  $prefix=$root+[IO.Path]::DirectorySeparatorChar
  if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Private cleanup paths must remain below the configured StateRoot.'}
  $relative=$full.Substring($prefix.Length);$cursor=$root
  foreach($part in $relative.Split([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)){
    if([string]::IsNullOrWhiteSpace($part)){continue};$cursor=Join-Path $cursor $part
    if(Test-Path -LiteralPath $cursor){$attrs=[IO.File]::GetAttributes($cursor);if(($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Private cleanup paths may not traverse reparse points.'}}
  }
}
function Get-ManifestRunRoot([string]$Path,[string]$PrivateStateRoot){
  $cleanupRoot=[IO.Path]::GetFullPath((Join-Path $PrivateStateRoot 'mailbox-cleanup')).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  $full=[IO.Path]::GetFullPath($Path);$run=[IO.Path]::GetDirectoryName($full)
  if(-not $run.StartsWith($cleanupRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Action manifest must be inside the private mailbox-cleanup run tree.'}
  return $run
}
function Invoke-Inventory {
  $script:StateRoot=Assert-PrivateRoot $StateRoot
  $runRoot=Join-Path (Join-Path $script:StateRoot 'mailbox-cleanup') ([guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($runRoot)|Out-Null
  $module=Join-Path $PSScriptRoot 'outlook-private-runtime.psm1'
  if(-not(Test-Path -LiteralPath $module)){throw 'Shared encrypted runtime is unavailable; refusing to write a plaintext manifest.'}
  Import-Module $module -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant(); $context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1'
  $inventory=Get-OutlookInventory $Mailbox; $manifest=New-InventoryManifest $inventory $Mailbox
  $path=if($ManifestPath){$ManifestPath}else{Join-Path $runRoot 'inventory.manifest.dpapi'}
  if(-not ([IO.Path]::GetFullPath($path).StartsWith([IO.Path]::GetFullPath($runRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))){throw 'Inventory manifest must be stored in its private cleanup run directory.'}
  Save-ProtectedJsonAtomic -Path $path -Value $manifest -Context $context
  Write-Output ([pscustomobject]@{ManifestPath=$path;ManifestHash=$manifest.manifestHash;PhysicalItemCount=$manifest.itemCount;EnumerationComplete=$manifest.complete;EvidenceComplete=$manifest.evidenceComplete;DeleteCandidates=@($manifest.items|Where-Object{$_.action -eq 'delete_to_deleted_items'}).Count;ReviewCount=@($manifest.items|Where-Object{$_.action -eq 'review'}).Count;SensitiveDeleteCount=$manifest.summary.sensitiveDeleteCount})
}
function Invoke-Review {
  if(-not $ManifestPath -or -not $ReviewOutputPath){throw 'Review requires an encrypted manifest and explicit private review output path.'}
  $script:StateRoot=Assert-PrivateRoot $StateRoot;Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant();$context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1'
  $manifest=Read-ProtectedJson -Path $ManifestPath -Context $context -QuarantineInvalid
  if(-not $manifest -or (Get-ManifestHash $manifest) -ne [string]$manifest.manifestHash){throw 'Private review manifest integrity check failed.'}
  $root=[IO.Path]::GetFullPath($StateRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar;$path=[IO.Path]::GetFullPath($ReviewOutputPath)
  if(-not $path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Private review output must remain under StateRoot.'}
  $directory=[IO.Path]::GetDirectoryName($path);Assert-CleanupPrivatePath $directory $context;Protect-PrivateDirectory $directory|Out-Null;Assert-CleanupPrivatePath $path $context
  $rows=[Collections.Generic.List[string]]::new()
  foreach($item in @($manifest.items)){
    $attrs=ConvertTo-Json -InputObject (Get-Field $item 'attachmentMetadata' @()) -Compress -Depth 5
    $cells=@([string](Get-Field $item 'rowId' ''),[string](Get-Field $item 'folder' ''),[string](Get-Field $item 'entryId' ''),[string](Get-Field $item 'internetMessageId' ''),[string](Get-Field $item 'receivedAt' ''),[string](Get-Field $item 'class' 'Review'),[string](Get-Field $item 'confidence' 'low'),[string](Get-Field $item 'reason' 'inaccessible'),[string](Get-Field $item 'action' 'review'),[string](Get-Field $item 'destination' ''),[string](Get-Field $item 'subject' ''),[string](Get-Field $item 'sender' ''),[string](Get-Field $item 'unread' $false),[string](Get-Field $item 'flagged' $false),[string](Get-Field $item 'sensitive' $false),[string](Get-Field $item 'attachmentCount' 0),[string]$attrs)
    $rows.Add('<tr>'+ (($cells|ForEach-Object{'<td>'+(ConvertTo-HtmlEncoded $_)+'</td>'}) -join '') + '</tr>')
  }
  $headers=@('Physical row key','Source','Entry ID','Internet Message ID','Received UTC','Classification','Confidence','Reason','Proposed action','Destination','Subject','Sender','Unread','Flagged','Sensitive','Attachment count','Attachment names and metadata')
  $headerHtml='<tr>'+ (($headers|ForEach-Object{'<th>'+(ConvertTo-HtmlEncoded $_)+'</th>'}) -join '') + '</tr>'
  $html='<!doctype html><html><head><meta charset="utf-8"><title>Private mailbox cleanup review</title><style>body{font:14px Segoe UI,Arial,sans-serif;margin:1.5rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.35rem;vertical-align:top;text-align:left;max-width:30rem;overflow-wrap:anywhere}th{position:sticky;top:0;background:#eee}</style></head><body><h1>Private mailbox cleanup review</h1><p>Manifest hash: '+(ConvertTo-HtmlEncoded ([string]$manifest.manifestHash))+' | Physical items: '+$manifest.itemCount+' | Delete candidates: '+$manifest.summary.preFloorDeleteCount+' before floor / '+$manifest.summary.sensitiveDeleteCount+' sensitive</p><p>This static local file contains private mailbox metadata. It does not load scripts, external fonts, images, or links.</p><table>'+ $headerHtml + ($rows -join '') + '</table></body></html>'
  [IO.File]::WriteAllText($path,$html,[Text.UTF8Encoding]::new($false))
  Write-Output ([pscustomobject]@{ReviewPath=$path;PhysicalItemCount=$manifest.itemCount;ManifestHash=$manifest.manifestHash})
}
function Invoke-CreateTaxonomy {
  $script:StateRoot=Assert-PrivateRoot $StateRoot
  if(-not $ManifestPath){throw 'CreateTaxonomy requires the private read-only inventory manifest.'}
  $runRoot=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ManifestPath));$cleanupRoot=[IO.Path]::GetFullPath((Join-Path $script:StateRoot 'mailbox-cleanup'))
  if(-not $runRoot.StartsWith($cleanupRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Manifest must be inside a private mailbox-cleanup run directory.'}
  Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant();$context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1'
  $manifest=Read-ProtectedJson -Path $ManifestPath -Context $context -QuarantineInvalid
  if((Get-ManifestHash $manifest) -ne [string]$manifest.manifestHash){throw 'Manifest integrity check failed; no folders were changed.'}
  $mutex=if($script:TaxonomyMutexFactory){& $script:TaxonomyMutexFactory}else{[Threading.Mutex]::new($false,'Local\JobSearchIntelligenceOutlookUpload')};$mutexHeld=$false
  try{$mutexHeld=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$mutexHeld=$true}
  if(-not $mutexHeld){$mutex.Dispose();throw 'Another Outlook uploader or maintenance process holds the shared mutex.'}
  $ol=$null;$ns=$null;$accounts=$null;$account=$null;$matches=$null;$store=$null;$inbox=$null;$root=$null;$rootFolders=$null;$rootMatches=$null;$journalPath=Join-Path $runRoot 'taxonomy-journal.dpapi'
  $created=[Collections.Generic.List[object]]::new();$children=[Collections.Generic.List[object]]::new()
  try {
    if($script:TaxonomySessionFactory){$session=& $script:TaxonomySessionFactory;$ol=$session.Application;$ns=$session.Namespace;$accounts=$session.Accounts}
    else{$ol=New-Object -ComObject Outlook.Application;$ns=$ol.GetNamespace('MAPI');$accounts=$ns.Accounts}
    $matches=[Collections.Generic.List[object]]::new()
    for($i=1;$i -le [int]$accounts.Count;$i++){$candidate=$null;try{$candidate=$accounts.Item($i);if([string]::Equals([string]$candidate.SmtpAddress,$Mailbox,[StringComparison]::OrdinalIgnoreCase)){$matches.Add($candidate)}elseif($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}catch{if($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)};throw}}
    if($matches.Count -ne 1){throw 'Selected account did not resolve uniquely by exact SMTP address.'};$account=$matches[0];$store=$account.DeliveryStore
    if([string]$store.StoreID -ne [string]$manifest.storeId){throw 'Inventory manifest store identity changed; no folders were changed.'}
    $inbox=$store.GetDefaultFolder($script:InboxId);if([string]$inbox.EntryID -ne [string]$manifest.sources[0].folderId){throw 'Inbox identity changed since inventory; no folders were changed.'}
    $rootFolders=$inbox.Folders;$rootMatches=[Collections.Generic.List[object]]::new()
    $rootCollision=$false;for($i=1;$i -le [int]$rootFolders.Count;$i++){$f=$null;$f=$rootFolders.Item($i);if([string]::Equals([string]$f.Name,$script:RootName,[StringComparison]::OrdinalIgnoreCase)){$rootMatches.Add($f)}elseif([string]$f.Name -match '(?i)^job\s*search$'){$rootCollision=$true;[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($f)}else{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($f)}}
    if($rootCollision){throw 'A near-match Job Search root name exists; resolve the naming collision before taxonomy creation.'}
    if($rootMatches.Count -gt 1){throw 'Inbox has ambiguous Job Search root folders.'}
    if($rootMatches.Count -eq 1){$root=$rootMatches[0];if([string]$root.Name -cne $script:RootName){throw 'Job Search root name casing differs from the approved exact name.'};if([int]$root.Items.Count -ne 0){throw 'Existing Job Search root contains direct items; no folders were changed.'}}
    else{$root=$rootFolders.Add($script:RootName);$created.Add(@{name=$script:RootName;entryId=[string]$root.EntryID});Save-ProtectedJsonAtomic -Path $journalPath -Value ([ordered]@{schemaVersion=1;stage='creating_taxonomy';storeId=[string]$store.StoreID;created=@($created.ToArray());changedAt=[datetime]::UtcNow.ToString('o')}) -Context $context}
    $folderCollection=$root.Folders
    try {
      $existing=@{}
      for($i=1;$i -le [int]$folderCollection.Count;$i++){$f=$folderCollection.Item($i);$name=[string]$f.Name;if($existing.ContainsKey($name.ToLowerInvariant())){if([Runtime.InteropServices.Marshal]::IsComObject($f)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($f)};throw 'Duplicate taxonomy child names are ambiguous.'};$existing[$name.ToLowerInvariant()]=$f;if($script:Taxonomy -notcontains $name){throw 'Job Search root contains an unapproved child folder.'}}
      foreach($name in $script:Taxonomy){$key=$name.ToLowerInvariant();if($existing.ContainsKey($key)){$folder=$existing[$key];if([string]$folder.Name -cne $name){throw "Taxonomy child name differs from approved exact name: $name"};if([int]$folder.Items.Count -ne 0 -or [int]$folder.Folders.Count -ne 0){throw "Approved taxonomy destination is not empty: $name"}}}
      foreach($name in $script:Taxonomy){$key=$name.ToLowerInvariant();if($existing.ContainsKey($key)){$folder=$existing[$key];$newFolder=$false}else{$folder=$folderCollection.Add($name);$newFolder=$true;$created.Add(@{name=$name;entryId=[string]$folder.EntryID});Save-ProtectedJsonAtomic -Path $journalPath -Value ([ordered]@{schemaVersion=1;stage='creating_taxonomy';storeId=[string]$store.StoreID;created=@($created.ToArray());changedAt=[datetime]::UtcNow.ToString('o')}) -Context $context};$children.Add(@{name=$name;entryId=[string]$folder.EntryID});if($newFolder -and [Runtime.InteropServices.Marshal]::IsComObject($folder)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($folder)}}
    } finally {foreach($f in $existing.Values){if($f -and [Runtime.InteropServices.Marshal]::IsComObject($f)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($f)}};if($folderCollection -and [Runtime.InteropServices.Marshal]::IsComObject($folderCollection)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($folderCollection)}}
    $record=[ordered]@{schemaVersion=1;storeId=[string]$store.StoreID;rootId=[string]$root.EntryID;rootName=$script:RootName;folders=@($children.ToArray());created=@($created.ToArray());manifestHash=[string]$manifest.manifestHash;createdAt=[datetime]::UtcNow.ToString('o')}
    $journal=[ordered]@{schemaVersion=1;stage='taxonomy_complete';record=$record};Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context
    $configPath=if($ApprovedFoldersPath){$ApprovedFoldersPath}else{Join-Path $StateRoot 'approved-folders.dpapi'}
    if(-not ([IO.Path]::GetFullPath($configPath).StartsWith([IO.Path]::GetFullPath($StateRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))){throw 'Approved folder config must remain under the shared private state root.'}
    Save-ProtectedJsonAtomic -Path $configPath -Value $record -Context $context
    Write-Output ([pscustomobject]@{RootIdHash=(Get-StringHash $record.rootId);FolderCount=$children.Count;ApprovedFoldersPath=$configPath;ManifestHash=$manifest.manifestHash;InventoryComplete=[bool]$manifest.complete})
  } catch {
    $journal=[ordered]@{schemaVersion=1;stage='partial_requires_review';storeId=if($store){[string]$store.StoreID}else{''};created=@($created.ToArray());errorCode=$_.Exception.GetType().Name;changedAt=[datetime]::UtcNow.ToString('o')}
    try{Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context}catch{}
    throw
  } finally {if($matches){foreach($candidate in $matches){if($candidate -and -not [object]::ReferenceEquals($candidate,$account) -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}};if($rootMatches){foreach($candidate in $rootMatches){if($candidate -and -not [object]::ReferenceEquals($candidate,$root) -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}};foreach($o in @($root,$rootFolders,$inbox,$store,$account,$accounts,$ns,$ol)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}};if($mutexHeld){$mutex.ReleaseMutex()};$mutex.Dispose()}
}
function Get-BytesHash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Get-FileHashHex([string]$Path){return Get-BytesHash ([IO.File]::ReadAllBytes($Path))}
function Test-StringSequenceEqual($Left,$Right){$a=[Collections.Generic.List[string]]::new();$b=[Collections.Generic.List[string]]::new();if($null -ne $Left){foreach($v in $Left){$a.Add([string]$v)}};if($null -ne $Right){foreach($v in $Right){$b.Add([string]$v)}};if($a.Count -ne $b.Count){return $false};for($i=0;$i -lt $a.Count;$i++){if($a[$i] -cne $b[$i]){return $false}};return $true}
function Get-CleanupSession([string]$MailboxAddress){
  if($script:OutlookFactory){$ol=& $script:OutlookFactory}else{$ol=New-Object -ComObject Outlook.Application};$ns=$ol.GetNamespace('MAPI');$accounts=$ns.Accounts;$matches=[Collections.Generic.List[object]]::new();$account=$null;$store=$null
  try{for($i=1;$i -le [int]$accounts.Count;$i++){$a=$null;try{$a=$accounts.Item($i);if([string]::Equals([string]$a.SmtpAddress,$MailboxAddress,[StringComparison]::OrdinalIgnoreCase)){$matches.Add($a)}elseif($a -and [Runtime.InteropServices.Marshal]::IsComObject($a)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($a)}}catch{if($a -and [Runtime.InteropServices.Marshal]::IsComObject($a)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($a)};throw}};if($matches.Count -ne 1){throw 'Selected Outlook account did not resolve uniquely.'};$account=$matches[0];$store=$account.DeliveryStore;return [pscustomobject]@{Application=$ol;Namespace=$ns;Accounts=$accounts;Account=$account;Store=$store;StoreId=[string]$store.StoreID;Inbox=$store.GetDefaultFolder(6);Junk=$store.GetDefaultFolder(23);Deleted=$store.GetDefaultFolder(3);Matches=$matches}}
  catch{foreach($o in @($store,$account,$accounts,$ns,$ol)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}};throw}
}
function Close-CleanupSession($Session){foreach($o in @($Session.Deleted,$Session.Junk,$Session.Inbox,$Session.Store)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}};if($Session.Matches){foreach($a in $Session.Matches){if($a -and -not [object]::ReferenceEquals($a,$Session.Account) -and [Runtime.InteropServices.Marshal]::IsComObject($a)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($a)}}};foreach($o in @($Session.Account,$Session.Accounts,$Session.Namespace,$Session.Application)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}}}
function Get-ItemAttachmentHashes($Item,[string]$ScratchRoot,[string]$AllowedRoot,$Context){
  Assert-ScratchRoot $ScratchRoot $AllowedRoot $Context
  $collection=$Item.Attachments;$hashes=[Collections.Generic.List[string]]::new()
  try{for($i=1;$i -le [int]$collection.Count;$i++){$attachment=$null;$path=Join-Path $ScratchRoot ([guid]::NewGuid().ToString('N')+'.att');try{$attachment=$collection.Item($i);$attachment.SaveAsFile($path);if(-not(Test-Path -LiteralPath $path)){throw 'attachment_export_missing'};$hashes.Add((Get-FileHashHex $path))}finally{if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force};if($attachment -and [Runtime.InteropServices.Marshal]::IsComObject($attachment)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($attachment)}}}}finally{if($collection -and [Runtime.InteropServices.Marshal]::IsComObject($collection)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($collection)}}
  return ,$hashes.ToArray()
}
function Assert-ScratchRoot([string]$ScratchRoot,[string]$AllowedRoot,$Context){
  $root=[IO.Path]::GetFullPath($AllowedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  $scratch=[IO.Path]::GetFullPath($ScratchRoot)
  if(-not $scratch.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Scratch path is outside its designated private run directory.'}
  Assert-CleanupPrivatePath $scratch $Context
  Protect-PrivateDirectory $scratch|Out-Null
}
function Get-ItemWasSent($Item) {
  # MAPI is authoritative after copy/import; MailItem.Sent can remain cached.
  # This is backup state only, never the collector's received/sent direction.
  if([Runtime.InteropServices.Marshal]::IsComObject($Item)){
    $accessor=$null
    try{$accessor=$Item.PropertyAccessor;return (([int]$accessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E070003') -band 8) -eq 0)}
    finally{if($accessor -and [Runtime.InteropServices.Marshal]::IsComObject($accessor)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($accessor)}}
  }
  $value=Get-Field $Item 'Sent' $null
  if($null -eq $value){throw 'Original item sent/draft state is unavailable for backup fidelity.'}
  return [bool]$value
}
function Test-MsgRoundTrip($Session,$Item,[string]$MsgPath,[string]$ScratchRoot,[string]$AllowedRoot,$Context){
  Assert-ScratchRoot $ScratchRoot $AllowedRoot $Context
  $expectedSent=Get-ItemWasSent $Item
  # OpenSharedItem can expose an unsent copy even for delivered MSGs. Preserve the
  # source state separately and prove it after restoration, not on that view.
  $expectedBody=[string]$Item.Body;$expectedSubject=[string]$Item.Subject;$expectedReceived=([datetime]$Item.ReceivedTime).ToUniversalTime().ToString('o');$expectedHashes=Get-ItemAttachmentHashes $Item $ScratchRoot $AllowedRoot $Context
  $opened=$null
  try{$opened=$Session.Namespace.OpenSharedItem($MsgPath);if([string]$opened.Body -cne $expectedBody -or [string]$opened.Subject -cne $expectedSubject){throw 'msg_body_or_subject_mismatch'};if(([datetime]$opened.ReceivedTime).ToUniversalTime().ToString('o') -ne $expectedReceived){throw 'msg_received_time_mismatch'};if([bool]$opened.UnRead -ne [bool]$Item.UnRead -or [int]$opened.FlagStatus -ne [int]$Item.FlagStatus -or [string]$opened.Categories -cne [string]$Item.Categories){throw 'msg_state_mismatch'};$openedAttachments=$opened.Attachments;try{if([int]$openedAttachments.Count -ne $expectedHashes.Count){throw 'msg_attachment_count_mismatch'}}finally{if($openedAttachments -and [Runtime.InteropServices.Marshal]::IsComObject($openedAttachments)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($openedAttachments)}};if($expectedHashes.Count -gt 0){$actualHashes=Get-ItemAttachmentHashes $opened $ScratchRoot $AllowedRoot $Context;if(-not(Test-StringSequenceEqual $actualHashes $expectedHashes)){throw 'msg_attachment_hash_mismatch'}};return @{bodyHash=Get-StringHash $expectedBody;subject=$expectedSubject;unread=[bool]$Item.UnRead;flagStatus=[int]$Item.FlagStatus;categories=[string]$Item.Categories;attachmentHashes=$expectedHashes;attachmentCount=$expectedHashes.Count;receivedAt=$expectedReceived;wasSent=[bool]$expectedSent}}
  finally{if($opened -and [Runtime.InteropServices.Marshal]::IsComObject($opened)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($opened)}}
}
function Save-VerifiedMsgBackup($Session,$Item,$Row,[string]$RunRoot,$Context){
  $backupDirectory=Join-Path $RunRoot 'backups';$scratch=Join-Path $RunRoot 'scratch';Assert-CleanupPrivatePath $backupDirectory $Context;Assert-CleanupPrivatePath $scratch $Context;Protect-PrivateDirectory $backupDirectory|Out-Null;Protect-PrivateDirectory $scratch|Out-Null
  $plain=Join-Path $scratch ($Row.rowId+'.msg');$protected=Join-Path $backupDirectory ($Row.rowId+'.msg.dpapi')
  try{$Item.SaveAs($plain,9);if(-not(Test-Path -LiteralPath $plain)){throw 'msg_save_missing'};$fidelity=Test-MsgRoundTrip $Session $Item $plain $scratch $RunRoot $Context;$bytes=[IO.File]::ReadAllBytes($plain);$hash=Get-BytesHash $bytes;Save-ProtectedBytesAtomic -Path $protected -Bytes $bytes -Context $Context;$reopened=Read-ProtectedBytes -Path $protected -Context $Context;if((Get-BytesHash $reopened) -ne $hash){throw 'encrypted_backup_hash_mismatch'};return @{path=$protected;sha256=$hash;bytes=$bytes.Length;fidelity=$fidelity}}
  finally{if(Test-Path -LiteralPath $plain){Remove-Item -LiteralPath $plain -Force}}
}
function Assert-EncryptedBackup($State,$Context){
  $path=[string](Get-Field $State 'backupPath' '')
  if([string]::IsNullOrWhiteSpace($path)){throw 'Journal state has no encrypted backup path.'}
  Assert-CleanupPrivatePath $path $Context
  $bytes=Read-ProtectedBytes -Path $path -Context $Context
  if((Get-BytesHash $bytes) -cne [string](Get-Field $State 'backupHash' '')){throw 'Encrypted backup hash check failed.'}
}
function Test-ApprovedSnapshot($Current,$Approved){
  foreach($name in 'storeId','folderId','entryId','internetMessageId','conversationId','subject','sender','receivedAt','modifiedAt','fingerprint','bodyHash','bodyLength','unread','flagged','categories','attachmentCount'){
    if([string](Get-Field $Current $name '') -cne [string](Get-Field $Approved $name '')){throw "Approved item state changed: $name"}
  }
}
function Test-RecoverySnapshot($Current,$Approved){
  foreach($name in 'storeId','internetMessageId','conversationId','subject','sender','receivedAt','fingerprint','bodyHash','unread','flagged','categories','attachmentCount'){
    if([string](Get-Field $Current $name '') -cne [string](Get-Field $Approved $name '')){throw "Recovery destination item differs from approval: $name"}
  }
}
function Test-ItemBackupFidelity($Item,$Expected,$ScratchRoot,[string]$AllowedRoot,$Context) {
  if(-not $Expected){throw 'Verified backup fidelity record is missing.'}
  Assert-ScratchRoot $ScratchRoot $AllowedRoot $Context
  if([string]$Item.Subject -cne [string]$Expected.subject -or (Get-StringHash ([string]$Item.Body)) -cne [string]$Expected.bodyHash){throw 'Moved or restored item body/subject differs from the approved backup.'}
  if(([datetime]$Item.ReceivedTime).ToUniversalTime().ToString('o') -cne [string]$Expected.receivedAt){throw 'Moved or restored item received time differs from the approved backup.'}
  if([bool]$Item.UnRead -ne [bool]$Expected.unread -or [int]$Item.FlagStatus -ne [int]$Expected.flagStatus -or [string]$Item.Categories -cne [string]$Expected.categories){throw 'Moved or restored item unread, flag, or category state differs from the approved backup.'}
  $expectedSent=Get-Field $Expected 'wasSent' $null
  if($null -ne $expectedSent -and (Get-ItemWasSent $Item) -ne [bool]$expectedSent){throw 'Moved or restored sent/draft state differs from the approved backup.'}
  $attachmentCollection=$Item.Attachments;try{if([int]$attachmentCollection.Count -ne [int]$Expected.attachmentCount){throw 'Moved or restored attachment count differs from the approved backup.'}}finally{if($attachmentCollection -and [Runtime.InteropServices.Marshal]::IsComObject($attachmentCollection)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($attachmentCollection)}}
  if([int]$Expected.attachmentCount -gt 0){$actual=Get-ItemAttachmentHashes $Item $ScratchRoot $AllowedRoot $Context;if(-not(Test-StringSequenceEqual $actual $Expected.attachmentHashes)){throw 'Moved or restored item attachment fidelity differs from the approved backup.'}}
}
function Restore-BackupReceivedTime($RestoredCopy,$Fidelity,$Namespace) {
  # OpenSharedItem().Move() can stamp the imported copy with the current time.
  # Apply only to a newly restored backup copy, never to an existing original.
  $expected=[datetime]::Parse([string]$Fidelity.receivedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $sentProof=Get-Field $Fidelity 'wasSent' $null
  if($null -eq $sentProof){throw 'Verified backup sent/draft state is missing; refusing to invent restored state.'}
  $wasSent=[bool]$sentProof
  if(([datetime]$RestoredCopy.ReceivedTime).ToUniversalTime().Ticks -eq $expected.Ticks -and (Get-ItemWasSent $RestoredCopy) -eq $wasSent){return $RestoredCopy}
  $accessor=$null
  try{
    $accessor=$RestoredCopy.PropertyAccessor
    $flags=[int]$accessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E070003')
    $flags=if($wasSent){$flags -band (-bnot 8)}else{$flags -bor 8}
    $accessor.SetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E070003',$flags)
    $accessor.SetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E060040',$expected)
    $RestoredCopy.Save()
  }
  finally{if($accessor -and [Runtime.InteropServices.Marshal]::IsComObject($accessor)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($accessor)}}
  # Refresh the Object Model's cached read-only ReceivedTime after its MAPI update.
  $entryId=[string]$RestoredCopy.EntryID;$parent=$RestoredCopy.Parent
  try{$storeId=[string]$parent.StoreID}finally{if($parent -and [Runtime.InteropServices.Marshal]::IsComObject($parent)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($parent)}}
  if([Runtime.InteropServices.Marshal]::IsComObject($RestoredCopy)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($RestoredCopy)}
  $RestoredCopy=$Namespace.GetItemFromID($entryId,$storeId)
  if(([datetime]$RestoredCopy.ReceivedTime).ToUniversalTime().Ticks -ne $expected.Ticks -or (Get-ItemWasSent $RestoredCopy) -ne $wasSent){throw 'Backup copy received time or sent/draft state could not be restored; maintenance remains paused.'}
  return $RestoredCopy
}
function Get-SourceItem($Session,$Row){
  $folder=$Session.Namespace.GetFolderFromID([string]$Row.folderId,[string]$Session.StoreId);if([string]$folder.EntryID -ne [string]$Row.folderId){throw 'Source folder identity mismatch'}
  $found=$null;$item=$null
  try{$item=$Session.Namespace.GetItemFromID([string]$Row.entryId,[string]$Session.StoreId);$parent=$item.Parent;try{if([string]$parent.EntryID -eq [string]$Row.folderId){$found=$item;$item=$null}}finally{if($parent -and [Runtime.InteropServices.Marshal]::IsComObject($parent)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($parent)}}}catch{}
  if($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)}
  if(-not $found){$items=$folder.Items;try{$matches=[Collections.Generic.List[object]]::new();for($i=1;$i -le [int]$items.Count;$i++){$candidate=$null;try{$candidate=$items.Item($i);$snap=Get-ItemRecord $candidate $Session.StoreId ([string]$Row.folderId) ([string]$Row.folder);if($snap.fingerprint -eq [string]$Row.fingerprint){$matches.Add($candidate);$candidate=$null}}finally{if($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}};if($matches.Count -eq 1){$found=$matches[0]}elseif($matches.Count -gt 1){foreach($candidate in $matches){if([Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}};throw 'Source fallback identity is ambiguous'}}finally{if($items -and [Runtime.InteropServices.Marshal]::IsComObject($items)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($items)}}}
  if($found){$folderId=[string]$Row.folderId;if([Runtime.InteropServices.Marshal]::IsComObject($folder)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($folder)};return $found}
  if($folder -and [Runtime.InteropServices.Marshal]::IsComObject($folder)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($folder)}
  return $null
}
function Get-ApprovedDestination($Session,$Folders,$Row){
  if($Row.action -eq 'delete_to_deleted_items'){$deleted=$Session.Namespace.GetFolderFromID([string]$Session.Deleted.EntryID,[string]$Session.StoreId);if([string]$deleted.StoreID -cne [string]$Session.StoreId){throw 'Deleted Items destination is outside the selected mailbox store.'};return $deleted}
  $entry=@($Folders.folders|Where-Object{$_.name -ceq [string]$Row.destination});if($entry.Count -ne 1){throw 'Approved taxonomy destination missing or ambiguous'}
  $folder=$Session.Namespace.GetFolderFromID([string]$entry[0].entryId,[string]$Session.StoreId);$parent=$folder.Parent;$rootParent=$null
  try{if([string]$folder.StoreID -cne [string]$Session.StoreId -or [string]$parent.EntryID -ne [string]$Folders.rootId -or [string]$parent.Name -cne $script:RootName -or [string]$folder.Name -cne [string]$Row.destination){throw 'Destination escaped or changed from the approved Job Search folder'};$rootParent=$parent.Parent;if([string]$rootParent.EntryID -cne [string]$Session.Inbox.EntryID){throw 'Approved taxonomy root is not a direct child of the selected Inbox.'};return $folder}finally{foreach($o in @($rootParent,$parent)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}}}
}
function Find-PhysicalMatches($Session,$Folder,$Row){
  $matches=[Collections.Generic.List[object]]::new();$items=$Folder.Items
  try{for($i=1;$i -le [int]$items.Count;$i++){$candidate=$null;try{$candidate=$items.Item($i);$snap=Get-ItemRecord $candidate $Session.StoreId ([string]$Folder.EntryID) ([string]$Folder.Name);if($snap.fingerprint -eq [string]$Row.fingerprint -and $snap.bodyHash -eq [string]$Row.bodyHash -and $snap.receivedAt -eq [string]$Row.receivedAt -and $snap.internetMessageId -eq [string]$Row.internetMessageId -and $snap.conversationId -eq [string]$Row.conversationId){$matches.Add($candidate);$candidate=$null}}finally{if($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}};return ,$matches.ToArray()}finally{if($items -and [Runtime.InteropServices.Marshal]::IsComObject($items)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($items)}}
}
function Invoke-Execute {
  if(-not $ManifestPath -or -not $ApprovalHash -or -not $BackendIdleProofPath -or -not $SyntheticAcceptanceProofPath -or -not $RolloutAcceptanceProofPath -or $BackupCeilingBytes -le 0){throw 'Execute requires the private manifest, exact owner-approved hash, fresh backend idle proof, synthetic backup/restore proof, accepted collector/replay proof, and explicit backup disk ceiling.'}
  $script:StateRoot=Assert-PrivateRoot $StateRoot;Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant();$context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1'
  $manifest=Read-ProtectedJson -Path $ManifestPath -Context $context -QuarantineInvalid
  if((Get-ManifestHash $manifest) -ne [string]$manifest.manifestHash -or [string]$manifest.manifestHash -cne $ApprovalHash -or -not [bool]$manifest.complete -or -not [bool](Get-Field $manifest 'evidenceComplete' $false)){throw 'Manifest integrity, completeness, complete item evidence, or exact owner approval check failed.'};Assert-ManifestActionScope $manifest
  $idle=Read-ProtectedJson -Path $BackendIdleProofPath -Context $context -QuarantineInvalid;$synthetic=Read-ProtectedJson -Path $SyntheticAcceptanceProofPath -Context $context -QuarantineInvalid;$rollout=Read-ProtectedJson -Path $RolloutAcceptanceProofPath -Context $context -QuarantineInvalid
  if(-not $idle -or [string]$idle.manifestHash -cne $ApprovalHash -or [string]::IsNullOrWhiteSpace([string](Get-Field $idle 'dataGeneration' '')) -or [int]$idle.pendingMessages -ne 0 -or [int]$idle.pendingTrackerRows -ne 0 -or [int]$idle.runningSyncs -ne 0 -or [int]$idle.activeLeases -ne 0 -or -not [bool]$idle.workflowsTerminal -or -not [bool]$idle.taskDisabled){throw 'Backend/task idle proof is absent, stale in content, or reports active work.'}
  $proofAt=ConvertTo-CleanupUtcDate $idle.verifiedAt;if(([datetime]::UtcNow-$proofAt).TotalMinutes -gt 5 -or $proofAt -gt [datetime]::UtcNow.AddMinutes(1)){throw 'Backend idle proof is older than five minutes or from the future.'}
  if(-not [bool]$synthetic.syntheticPstRestoreVerified -or -not [bool]$synthetic.backupReopenVerified -or -not [bool]$synthetic.attachmentHashesVerified -or -not [bool](Get-Field $synthetic 'stateFidelityVerified' $false) -or -not [bool](Get-Field $synthetic 'cleanupFinalized' $false)){throw 'Synthetic isolated PST backup/restore, item-state, or fixture-cleanup proof is incomplete.'}
  $candidateRows=Get-RequiredCaptureRows $manifest;$candidateIds=@($candidateRows|ForEach-Object{[string]$_.rowId}|Sort-Object -CaseSensitive);$rolloutIds=@($rollout.candidateRowIds|ForEach-Object{[string]$_}|Sort-Object -CaseSensitive)
  if([string]$rollout.manifestHash -cne $ApprovalHash -or [string]$rollout.capturedManifestHash -cne $ApprovalHash -or [string]$rollout.processedManifestHash -cne $ApprovalHash -or [string]::IsNullOrWhiteSpace([string]$rollout.captureGeneration) -or [string]$idle.dataGeneration -cne [string]$rollout.captureGeneration -or [string]::IsNullOrWhiteSpace([string]$rollout.uploadReceiptId) -or [string]::IsNullOrWhiteSpace([string]$rollout.processingRunId) -or [int]$rollout.captureItemCount -ne $candidateRows.Count -or [int]$rollout.candidateCount -ne $candidateRows.Count -or -not [bool]$rollout.uploadAccepted -or -not [bool]$rollout.processingComplete -or -not [bool]$rollout.approvedFoldersDiscovered -or -not [bool]$rollout.preMoveCaptureComplete -or -not [bool]$rollout.stableReplayVerified -or -not [bool]$rollout.runtimeGateInteropVerified -or (ConvertTo-Json -InputObject $candidateIds -Compress) -ne (ConvertTo-Json -InputObject $rolloutIds -Compress) -or [string]$rollout.candidateSetHash -cne (Get-CandidateSetHash $candidateRows)){throw 'Exact in-floor job-evidence capture, accepted upload/processing, replay, or shared gate rollout proof is missing or mismatched.'}
  $runRoot=Get-ManifestRunRoot $ManifestPath $StateRoot;$journalPath=Join-Path $runRoot 'action-journal.dpapi';$journal=Read-ProtectedJson -Path $journalPath -Context $context
  if(-not $journal){$journal=[ordered]@{schemaVersion=1;manifestHash=$ApprovalHash;phase='backups';items=[ordered]@{}}}else{$journal=ConvertTo-MutableMap $journal}
  if([string]$journal.manifestHash -cne $ApprovalHash){throw 'Journal belongs to a different approved manifest.'}
  $foldersPath=if($ApprovedFoldersPath){$ApprovedFoldersPath}else{Join-Path $StateRoot 'approved-folders.dpapi'};$folders=Read-ProtectedJson -Path $foldersPath -Context $context -QuarantineInvalid
  $expectedNames=@($script:Taxonomy|Sort-Object);$actualNames=@($folders.folders|ForEach-Object{[string]$_.name}|Sort-Object);if([string]$folders.storeId -cne [string]$manifest.storeId -or (ConvertTo-Json $expectedNames -Compress) -ne (ConvertTo-Json $actualNames -Compress)){throw 'Approved taxonomy binding is incomplete or belongs to a different store.'}
  $scheduled=Get-ScheduledTask -TaskName 'JobSearchIntelligence-OutlookUpload' -ErrorAction Stop;if([string]$scheduled.State -ne 'Disabled'){throw 'Scheduled Outlook uploader must be disabled before actions.'}
  $lease=Enter-MaintenanceCoordinator -Context $context;if(-not $lease.Acquired -or -not $lease.GateEnabled){$lease.Dispose();throw 'Shared maintenance mutex and durable gate must both be active.'}
  $session=$null;$started=Get-CleanupUtcNow;$processed=0;$limit=25;$timeout=$started.AddMinutes(5)
  try{$session=Get-CleanupSession $Mailbox;if($session.StoreId -cne [string]$manifest.storeId -or [string]$session.Inbox.EntryID -cne [string]$manifest.sources[0].folderId -or [string]$session.Junk.EntryID -cne [string]$manifest.sources[1].folderId){throw 'Mailbox store/source folder identity changed since inventory.'}
    $actions=Get-ActionRows $manifest;$pending=Get-ActionRowsNeedingBackup $manifest $journal.items
    $estimate=[long]0;foreach($row in $pending){$estimate += [long](Get-Field $row 'bodyLength' 0)*2 + [long]65536;foreach($attachment in @($row.attachmentMetadata)){$estimate += [long](Get-Field $attachment 'Size' 0)}}
    $backupDir=Join-Path $runRoot 'backups';$used=[long]0;if(Test-Path -LiteralPath $backupDir){$used=[long](@(Get-ChildItem -LiteralPath $backupDir -File -Force|Measure-Object -Property Length -Sum).Sum)}
    if($estimate+$used -gt $BackupCeilingBytes){throw 'Estimated encrypted backup set exceeds the explicitly configured disk ceiling.'}
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($runRoot));if($drive.AvailableFreeSpace -lt ($estimate*2)){throw 'Insufficient free disk space for verified MSG backups and temporary verification copies.'}
    if([string]$journal.phase -eq 'backups'){
      foreach($row in $pending){if(-not(Test-ActionBudget $processed $limit $timeout)){break};$item=Get-SourceItem $session $row;if(-not $item){throw 'Approved source item is missing; stop for review.'};try{$fresh=Get-ItemRecord $item $session.StoreId ([string]$row.folderId) ([string]$row.folder);Test-ApprovedSnapshot $fresh $row;$backup=Save-VerifiedMsgBackup $session $item $row $runRoot $context;Set-JournalItem $journal.items ([string]$row.rowId) @{status='backup_verified';backupPath=$backup.path;backupHash=$backup.sha256;backupBytes=$backup.bytes;fidelity=$backup.fidelity;verifiedAt=[datetime]::UtcNow.ToString('o')};$processed++;Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;$used += [long](Get-Item -LiteralPath $backup.path).Length;if($used -gt $BackupCeilingBytes){throw 'Verified backup bytes exceeded the explicitly configured disk ceiling; no mailbox items were moved.'}}finally{if($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)}}}
      $remaining=@($actions|Where-Object{(Get-JournalStatus $journal.items $_.rowId) -notin 'backup_verified','completed'});if($remaining.Count -gt 0){Write-Output ([pscustomobject]@{Phase='backups';Processed=$processed;Remaining=$remaining.Count;ManifestHash=$ApprovalHash});return}
      $journal.phase='actions';Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;Write-Output ([pscustomobject]@{Phase='backups_complete';Processed=$processed;ManifestHash=$ApprovalHash});return
    }
    foreach($row in $actions){if(-not(Test-ActionBudget $processed $limit $timeout)){break};$state=Get-Field $journal.items $row.rowId $null;if($state -and $state.status -eq 'completed'){continue};if(-not $state -or $state.status -notin 'backup_verified','move_started'){throw 'Action candidate lacks verified encrypted backup.'};$item=Get-SourceItem $session $row
      if(-not $item){Assert-EncryptedBackup $state $context;$dest=Get-ApprovedDestination $session $folders $row;try{$found=[Collections.Generic.List[object]]::new();$destItems=$dest.Items;try{for($i=1;$i -le [int]$destItems.Count;$i++){$candidate=$null;try{$candidate=$destItems.Item($i);$snap=Get-ItemRecord $candidate $session.StoreId ([string]$dest.EntryID) ([string]$dest.Name);if($snap.fingerprint -eq [string]$row.fingerprint -and $snap.bodyHash -eq [string]$row.bodyHash){$found.Add($candidate);$candidate=$null}}finally{if($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}};if($found.Count -eq 1){$item=$found[0];$snap=Get-ItemRecord $item $session.StoreId ([string]$dest.EntryID) ([string]$dest.Name);Test-RecoverySnapshot $snap $row;Test-ItemBackupFidelity $item $state.fidelity (Join-Path $runRoot 'scratch') $runRoot $context;Set-JournalItem $journal.items ([string]$row.rowId) @{status='completed';afterEntryId=[string]$item.EntryID;afterFolderId=[string]$dest.EntryID;reconciled=$true;verifiedAt=[datetime]::UtcNow.ToString('o')};Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;$processed++;if($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)};$item=$null;continue};foreach($candidate in $found){if([Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}}finally{if($destItems -and [Runtime.InteropServices.Marshal]::IsComObject($destItems)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($destItems)}}}finally{if($dest -and [Runtime.InteropServices.Marshal]::IsComObject($dest)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($dest)}};throw 'Approved item is missing or ambiguous in source and recovery destination.'}
      try{$fresh=Get-ItemRecord $item $session.StoreId ([string]$row.folderId) ([string]$row.folder);Test-ApprovedSnapshot $fresh $row;Assert-EncryptedBackup $state $context;$dest=Get-ApprovedDestination $session $folders $row;try{Set-JournalItem $journal.items ([string]$row.rowId) @{status='move_started';backupPath=$state.backupPath;backupHash=$state.backupHash;beforeEntryId=[string]$row.entryId;beforeFolderId=[string]$row.folderId};Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;$moved=$item.Move($dest);try{$parent=$moved.Parent;try{if([string]$parent.EntryID -ne [string]$dest.EntryID -or [string]$parent.StoreID -ne [string]$session.StoreId){throw 'Move returned an item outside the approved same-store destination.'}}finally{if($parent -and [Runtime.InteropServices.Marshal]::IsComObject($parent)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($parent)}};Test-ItemBackupFidelity $moved $state.fidelity (Join-Path $runRoot 'scratch') $runRoot $context;Set-JournalItem $journal.items ([string]$row.rowId) @{status='completed';afterEntryId=[string]$moved.EntryID;afterFolderId=[string]$dest.EntryID;verifiedAt=[datetime]::UtcNow.ToString('o')};Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context}finally{if($moved -and [Runtime.InteropServices.Marshal]::IsComObject($moved)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($moved)}}}finally{if($dest -and [Runtime.InteropServices.Marshal]::IsComObject($dest)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($dest)}};$processed++}finally{if($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)}}}
    $remaining=@($actions|Where-Object{(Get-JournalStatus $journal.items $_.rowId) -ne 'completed'});Write-Output ([pscustomobject]@{Phase=if($remaining.Count){'actions'}else{'completed'};Processed=$processed;Remaining=$remaining.Count;ManifestHash=$ApprovalHash;MaintenanceGateRemainsEnabled=$true})
  }finally{if($session){Close-CleanupSession $session};$lease.Dispose()}
}
function Invoke-Recover {
  if(-not $ManifestPath -or -not $ApprovalHash -or -not $BackendIdleProofPath){throw 'Recover requires the exact cleanup manifest hash and fresh backend/task idle proof.'}
  $script:StateRoot=Assert-PrivateRoot $StateRoot;Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant();$context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1';$manifest=Read-ProtectedJson -Path $ManifestPath -Context $context -QuarantineInvalid
  if((Get-ManifestHash $manifest) -ne [string]$manifest.manifestHash -or [string]$manifest.manifestHash -cne $ApprovalHash -or -not [bool]$manifest.complete -or -not [bool](Get-Field $manifest 'evidenceComplete' $false)){throw 'Recovery manifest integrity, complete item evidence, or exact approval check failed.'};Assert-ManifestActionScope $manifest
  $idle=Read-ProtectedJson -Path $BackendIdleProofPath -Context $context -QuarantineInvalid;if([string]$idle.manifestHash -cne $ApprovalHash -or [int]$idle.pendingMessages -ne 0 -or [int]$idle.pendingTrackerRows -ne 0 -or [int]$idle.runningSyncs -ne 0 -or [int]$idle.activeLeases -ne 0 -or -not [bool]$idle.workflowsTerminal -or -not [bool]$idle.taskDisabled){throw 'Recovery requires a fresh zero-backlog proof with the uploader task disabled.'}
  $proofAt=ConvertTo-CleanupUtcDate $idle.verifiedAt;if(([datetime]::UtcNow-$proofAt).TotalMinutes -gt 5 -or $proofAt -gt [datetime]::UtcNow.AddMinutes(1)){throw 'Recovery backend idle proof is older than five minutes or from the future.'}
  $task=Get-ScheduledTask -TaskName 'JobSearchIntelligence-OutlookUpload' -ErrorAction Stop;if([string]$task.State -ne 'Disabled'){throw 'Scheduled Outlook uploader must remain disabled during recovery.'}
  $runRoot=Get-ManifestRunRoot $ManifestPath $StateRoot;$journalPath=Join-Path $runRoot 'action-journal.dpapi';$journal=Read-ProtectedJson -Path $journalPath -Context $context -QuarantineInvalid;if(-not $journal -or [string]$journal.manifestHash -cne $ApprovalHash){throw 'No matching protected action journal exists for recovery.'};$journal=ConvertTo-MutableMap $journal
  $foldersPath=if($ApprovedFoldersPath){$ApprovedFoldersPath}else{Join-Path $StateRoot 'approved-folders.dpapi'};$folders=Read-ProtectedJson -Path $foldersPath -Context $context -QuarantineInvalid
  $lease=Enter-MaintenanceCoordinator -Context $context;if(-not $lease.Acquired -or -not $lease.GateEnabled){$lease.Dispose();throw 'Recovery requires the shared mutex and durable maintenance gate.'}
  $session=$null;$processed=0;$limit=25;$deadline=(Get-CleanupUtcNow).AddMinutes(5)
  try {
    $session=Get-CleanupSession $Mailbox
    if($session.StoreId -cne [string]$manifest.storeId -or [string]$session.Inbox.EntryID -cne [string]$manifest.sources[0].folderId -or [string]$session.Junk.EntryID -cne [string]$manifest.sources[1].folderId){throw 'Mailbox store or source folder identity changed since the approved inventory.'}
    $rows=@($manifest.items|Where-Object{$_.action -in 'move','delete_to_deleted_items'})
    foreach($row in $rows){
      if(-not(Test-ActionBudget $processed $limit $deadline)){break}
      $state=Get-Field $journal.items $row.rowId $null
      if(-not $state -or $state.status -in 'backup_verified','restored_original','restored_from_backup'){continue}
      if($state.status -notin 'completed','move_started','restore_started'){throw 'Journal state is ambiguous; recovery stopped.'}
      Assert-EncryptedBackup $state $context
      $source=$null;$dest=$null;$sourceMatches=@();$destMatches=@();$opened=$null;$copy=$null;$restored=$null;$plain=$null
      try {
        $source=$session.Namespace.GetFolderFromID([string]$row.folderId,[string]$session.StoreId)
        $dest=Get-ApprovedDestination $session $folders $row
        $sourceMatches=Find-PhysicalMatches $session $source $row
        $destMatches=Find-PhysicalMatches $session $dest $row
        if($sourceMatches.Count -gt 1 -or $destMatches.Count -gt 1 -or ($sourceMatches.Count -gt 0 -and $destMatches.Count -gt 0)){throw 'Recovery found duplicate or ambiguous physical matches; no item changed.'}
        if($sourceMatches.Count -eq 1){
          $item=$sourceMatches[0];$snap=Get-ItemRecord $item $session.StoreId ([string]$source.EntryID) ([string]$source.Name);Test-RecoverySnapshot $snap $row;Test-ItemBackupFidelity $item $state.fidelity (Join-Path $runRoot 'scratch') $runRoot $context
          Set-JournalItem $journal.items ([string]$row.rowId) @{status='restored_original';reconciled=$true;verifiedAt=[datetime]::UtcNow.ToString('o')}
          Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;$processed++;continue
        }
        if($destMatches.Count -eq 1){
          $item=$destMatches[0];$snap=Get-ItemRecord $item $session.StoreId ([string]$dest.EntryID) ([string]$dest.Name);Test-RecoverySnapshot $snap $row
          Set-JournalItem $journal.items ([string]$row.rowId) @{status='restore_started';sourceEntryId=[string]$item.EntryID;sourceFolderId=[string]$dest.EntryID;targetFolderId=[string]$source.EntryID}
          Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context
          $restored=$item.Move($source);$parent=$restored.Parent
          try{if([string]$parent.EntryID -ne [string]$source.EntryID -or [string]$parent.StoreID -ne [string]$session.StoreId){throw 'Recovered original did not return to the approved source folder.'}}
          finally{if($parent -and [Runtime.InteropServices.Marshal]::IsComObject($parent)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($parent)}}
          $after=Get-ItemRecord $restored $session.StoreId ([string]$source.EntryID) ([string]$source.Name);Test-RecoverySnapshot $after $row;Test-ItemBackupFidelity $restored $state.fidelity (Join-Path $runRoot 'scratch') $runRoot $context
          Set-JournalItem $journal.items ([string]$row.rowId) @{status='restored_original';afterEntryId=[string]$restored.EntryID;afterFolderId=[string]$source.EntryID;verifiedAt=[datetime]::UtcNow.ToString('o')}
          Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;$processed++;continue
        }
        $backupPath=[string]$state.backupPath
        if(-not $backupPath -or -not (Test-Path -LiteralPath $backupPath)){throw 'Original is missing and its encrypted backup is unavailable.'}
        $bytes=Read-ProtectedBytes -Path $backupPath -Context $context
        if((Get-BytesHash $bytes) -cne [string]$state.backupHash){throw 'Encrypted backup integrity check failed.'}
        $scratch=Join-Path $runRoot 'scratch';Assert-CleanupPrivatePath $scratch $context;Protect-PrivateDirectory $scratch|Out-Null;$plain=Join-Path $scratch ($row.rowId+'.restore.msg')
        [IO.File]::WriteAllBytes($plain,$bytes);$opened=$session.Namespace.OpenSharedItem($plain)
        if((Get-StringHash ([string]$opened.Body)) -cne [string]$row.bodyHash -or [string]$opened.Subject -cne [string]$row.subject){throw 'Backup content does not match the approved physical item.'}
        $hashes=Get-ItemAttachmentHashes $opened $scratch $runRoot $context
        if((ConvertTo-Json $hashes -Compress) -ne (ConvertTo-Json $state.fidelity.attachmentHashes -Compress)){throw 'Backup attachment hashes failed recovery verification.'}
        Set-JournalItem $journal.items ([string]$row.rowId) @{status='restore_started';source='verified_backup';targetFolderId=[string]$source.EntryID}
        Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context
        $restored=$opened.Move($source);$parent=$restored.Parent
        try{if([string]$parent.EntryID -ne [string]$source.EntryID -or [string]$parent.StoreID -ne [string]$session.StoreId){throw 'Backup restore landed outside the approved source folder.'}}
        finally{if($parent -and [Runtime.InteropServices.Marshal]::IsComObject($parent)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($parent)}}
        $restored=Restore-BackupReceivedTime $restored $state.fidelity $session.Namespace
        $after=Get-ItemRecord $restored $session.StoreId ([string]$source.EntryID) ([string]$source.Name);Test-RecoverySnapshot $after $row;Test-ItemBackupFidelity $restored $state.fidelity $scratch $runRoot $context
        $journal.items[$row.rowId]=@{status='restored_from_backup';backupPath=$state.backupPath;backupHash=$state.backupHash;fidelity=$state.fidelity;beforeEntryId=[string]$row.entryId;beforeFolderId=[string]$row.folderId;afterEntryId=[string]$restored.EntryID;afterFolderId=[string]$source.EntryID;verifiedAt=[datetime]::UtcNow.ToString('o')}
        Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context;$processed++
      } finally {
        foreach($x in @($sourceMatches,$destMatches)){foreach($candidate in $x){if($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}}
        foreach($x in @($restored,$copy,$opened)){if($x -and [Runtime.InteropServices.Marshal]::IsComObject($x)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($x)}catch{}}}
        if($plain -and (Test-Path -LiteralPath $plain)){Remove-Item -LiteralPath $plain -Force}
        foreach($x in @($dest,$source)){if($x -and [Runtime.InteropServices.Marshal]::IsComObject($x)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($x)}}
      }
    }
    $remaining=@($rows|Where-Object{(Get-Field $journal.items $_.rowId $null) -and [string](Get-Field (Get-Field $journal.items $_.rowId $null) 'status' '') -notin 'restored_original','restored_from_backup','backup_verified'})
    Write-Output ([pscustomobject]@{Phase=if($remaining.Count){'recovery'}else{'recovery_complete'};Processed=$processed;Remaining=$remaining.Count;ManifestHash=$ApprovalHash;MaintenanceGateRemainsEnabled=$true})
  } finally {if($session){Close-CleanupSession $session};$lease.Dispose()}
}
function Test-SyntheticRunPath([string]$Root,$Context){
  $full=[IO.Path]::GetFullPath($Root);$base=[IO.Path]::GetFullPath((Join-Path $Context.StateRoot 'mailbox-cleanup')).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  if(-not $full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -notmatch '^synthetic-[0-9a-f]{32}$'){throw 'Synthetic cleanup path is outside its private generated-run boundary.'}
  Assert-CleanupPrivatePath $full $Context
  foreach($node in @(Get-Item -LiteralPath $full -Force)+@(Get-ChildItem -LiteralPath $full -Force -Recurse -ErrorAction Stop)){if(($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Synthetic cleanup refuses reparse points.'}}
  return $full
}
function Remove-SyntheticRunRoot([string]$Root,$Context){
  if($script:SyntheticCleanupRemover){return [bool](& $script:SyntheticCleanupRemover $Root $Context)}
  $full=Test-SyntheticRunPath $Root $Context
  for($attempt=0;$attempt -lt 8 -and (Test-Path -LiteralPath $full);$attempt++){try{Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop}catch{};if(Test-Path -LiteralPath $full){Start-Sleep -Milliseconds 500}}
  return (-not (Test-Path -LiteralPath $full))
}
function Remove-SyntheticPstAttachment($Namespace,[string]$PstPath){
  $full=[IO.Path]::GetFullPath($PstPath);$detached=$false
  for($attempt=0;$attempt -lt 6;$attempt++){
    $stores=$null;$matched=$null;$root=$null
    try{$stores=$Namespace.Stores;$hits=0;for($i=1;$i -le [int]$stores.Count;$i++){$candidate=$stores.Item($i);if([string]::Equals([IO.Path]::GetFullPath([string]$candidate.FilePath),$full,[StringComparison]::OrdinalIgnoreCase)){$hits++;$matched=$candidate}else{if($candidate -and [Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}};if($hits -gt 1){return $false};if($hits -eq 0){return $true};$accounts=$Namespace.Accounts;try{for($i=1;$i -le [int]$accounts.Count;$i++){$account=$accounts.Item($i);try{$delivery=$account.DeliveryStore;if([string]$delivery.StoreID -ceq [string]$matched.StoreID){throw 'Synthetic fixture PST is an account delivery store; refusing to detach.'}}finally{foreach($o in @($delivery,$account)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}}}}}finally{if($accounts -and [Runtime.InteropServices.Marshal]::IsComObject($accounts)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($accounts)}};$root=$matched.GetRootFolder();$Namespace.RemoveStore($root);$detached=$true
    }finally{foreach($o in @($root,$matched,$stores)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}catch{}}}}
    if($detached){Start-Sleep -Milliseconds 500}
  }
  return $false
}
function Get-SyntheticFinalizerNamespace {
  if($script:SyntheticNamespaceFactory){return & $script:SyntheticNamespaceFactory}
  $application=New-Object -ComObject Outlook.Application;$namespace=$application.GetNamespace('MAPI')
  return [pscustomobject]@{Application=$application;Namespace=$namespace}
}
function Invoke-FinalizeSyntheticRestore {
  $script:StateRoot=Assert-PrivateRoot $StateRoot;Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant();$context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1';$pendingPath=Join-Path $StateRoot 'pending-synthetic-restore.dpapi'
  $receipt=Read-ProtectedJson -Path $pendingPath -Context $context -QuarantineInvalid
  if(-not $receipt -or [int]$receipt.schemaVersion -ne 1 -or [bool]$receipt.accepted -or -not [bool]$receipt.syntheticPstRestoreVerified -or -not [bool]$receipt.backupReopenVerified -or -not [bool]$receipt.attachmentHashesVerified -or -not [bool]$receipt.stateFidelityVerified -or [string]$receipt.pstFileName -cne 'isolated-fixture.pst'){throw 'Pending synthetic restore receipt is missing, corrupt, or incomplete.'}
  $root=Test-SyntheticRunPath ([string]$receipt.fixtureRunRoot) $context;$pstPath=Join-Path $root 'isolated-fixture.pst';if(-not (Test-Path -LiteralPath $pstPath)){throw 'Pending synthetic restore PST is missing; no accepted proof was written.'}
  $lease=Enter-MaintenanceCoordinator -Context $context;if(-not $lease.Acquired){$lease.Dispose();throw 'Another Outlook uploader or maintenance process holds the shared mutex.'}
  $handle=$null;$cleanupComplete=$false
  try{$handle=Get-SyntheticFinalizerNamespace;if(-not $handle -or -not $handle.Namespace){throw 'Outlook namespace is unavailable for exact synthetic PST attachment verification.'};if(-not (Remove-SyntheticPstAttachment $handle.Namespace $pstPath)){Write-Output ([pscustomobject]@{Phase='cleanup_pending';Accepted=$false;PendingReceiptPath=$pendingPath});return};$cleanupComplete=Remove-SyntheticRunRoot $root $context
    if(-not $cleanupComplete){Write-Output ([pscustomobject]@{Phase='cleanup_pending';Accepted=$false;PendingReceiptPath=$pendingPath});return}
    $proof=[ordered]@{schemaVersion=1;syntheticPstRestoreVerified=$true;backupReopenVerified=$true;attachmentHashesVerified=$true;stateFidelityVerified=$true;cleanupFinalized=$true;verifiedAt=[string]$receipt.verifiedAt;finalizedAt=[datetime]::UtcNow.ToString('o')}
    Save-ProtectedJsonAtomic -Path (Join-Path $StateRoot 'synthetic-restore-proof.dpapi') -Value $proof -Context $context
    Remove-Item -LiteralPath $pendingPath -Force -ErrorAction Stop
    Write-Output ([pscustomobject]@{Phase='accepted';Accepted=$true;ProofPath=(Join-Path $StateRoot 'synthetic-restore-proof.dpapi')})
  }finally{if($handle){foreach($o in @($handle.Namespace,$handle.Application)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}catch{}}}};$lease.Dispose()}
}
function Invoke-SyntheticRestore {
  $script:StateRoot=Assert-PrivateRoot $StateRoot
  Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  $binding=Get-StringHash $Mailbox.ToLowerInvariant();$context=New-CleanupRuntimeContext $StateRoot 'outlook-cleanup' $binding 'cleanup-v1'
  $mutex=if($script:SyntheticMutexFactory){& $script:SyntheticMutexFactory}else{[Threading.Mutex]::new($false,'Local\JobSearchIntelligenceOutlookUpload')};$held=$false
  try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
  if(-not $held){$mutex.Dispose();throw 'Another Outlook uploader or maintenance process holds the shared mutex.'}
  $root=Join-Path (Join-Path $StateRoot 'mailbox-cleanup') ('synthetic-'+[guid]::NewGuid().ToString('N'));Assert-CleanupPrivatePath $root $context;Protect-PrivateDirectory $root|Out-Null
  $pstPath=Join-Path $root 'isolated-fixture.pst';$msgPath=Join-Path $root 'fixture.msg';$scratchRoot=Join-Path $root 'scratch';$attachmentPath=Join-Path $root 'synthetic-attachment.txt';[IO.File]::WriteAllText($attachmentPath,'synthetic attachment content only',[Text.UTF8Encoding]::new($false))
  $ol=$null;$ns=$null;$stores=$null;$store=$null;$pstRoot=$null;$fixtureFolder=$null;$items=$null;$item=$null;$attachment=$null;$opened=$null;$copy=$null;$restored=$null;$attached=$false;$proofReady=$false;$cleanupComplete=$true;$detachmentConfirmed=$false
  try{
    if($script:OutlookFactory){$ol=& $script:OutlookFactory}else{$ol=New-Object -ComObject Outlook.Application};$ns=$ol.GetNamespace('MAPI');$ns.AddStoreEx($pstPath,2);$attached=$true;$stores=$ns.Stores
    for($i=1;$i -le [int]$stores.Count;$i++){$candidate=$stores.Item($i);if([string]::Equals([string]$candidate.FilePath,$pstPath,[StringComparison]::OrdinalIgnoreCase)){$store=$candidate;break}else{if([Runtime.InteropServices.Marshal]::IsComObject($candidate)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate)}}}
    if(-not $store){throw 'Isolated synthetic PST could not be resolved after creation.'}
    $fixtureAccounts=$ns.Accounts
    try{for($i=1;$i -le [int]$fixtureAccounts.Count;$i++){$candidateAccount=$fixtureAccounts.Item($i);try{$delivery=$candidateAccount.DeliveryStore;if([string]$delivery.StoreID -eq [string]$store.StoreID){throw 'Synthetic PST unexpectedly became an account delivery store.'}}finally{if($delivery -and [Runtime.InteropServices.Marshal]::IsComObject($delivery)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($delivery)};if($candidateAccount -and [Runtime.InteropServices.Marshal]::IsComObject($candidateAccount)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidateAccount)}}}}finally{if($fixtureAccounts -and [Runtime.InteropServices.Marshal]::IsComObject($fixtureAccounts)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($fixtureAccounts)}}
    $pstRoot=$store.GetRootFolder();$fixtureFolders=$pstRoot.Folders
    try{$fixtureFolder=$fixtureFolders.Add('Synthetic cleanup fixture')}finally{if($fixtureFolders -and [Runtime.InteropServices.Marshal]::IsComObject($fixtureFolders)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($fixtureFolders)}}
    $items=$fixtureFolder.Items;$item=$items.Add('IPM.Note');$item.Subject='Synthetic cleanup restore fixture';$item.Body="Synthetic body for offline round-trip validation.`r`nNo owner or production content.";$item.UnRead=$true;$item.FlagStatus=2;$item.Categories='Synthetic cleanup test'
    $fixtureAttachments=$item.Attachments
    try{$attachment=$fixtureAttachments.Add($attachmentPath,1,1,'Synthetic attachment')}finally{if($fixtureAttachments -and [Runtime.InteropServices.Marshal]::IsComObject($fixtureAttachments)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($fixtureAttachments)}}
    $fixtureAccessor=$item.PropertyAccessor
    try{$fixtureAccessor.SetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E060040',([datetime]'2026-10-01T12:00:00Z').ToUniversalTime());$fixtureAccessor.SetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E070003',0)}finally{if($fixtureAccessor -and [Runtime.InteropServices.Marshal]::IsComObject($fixtureAccessor)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($fixtureAccessor)}}
    $item.Save()
    if($attachment -and [Runtime.InteropServices.Marshal]::IsComObject($attachment)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($attachment);$attachment=$null}
    $item.SaveAs($msgPath,9);$fidelity=Test-MsgRoundTrip ([pscustomobject]@{Namespace=$ns}) $item $msgPath $scratchRoot $root $context
    $opened=$ns.OpenSharedItem($msgPath);$restored=$opened.Move($fixtureFolder)
    $parent=$restored.Parent;try{if([string]$parent.EntryID -ne [string]$fixtureFolder.EntryID -or [string]$parent.StoreID -ne [string]$store.StoreID){throw 'Synthetic restored item did not land in its isolated PST fixture folder.'}}finally{if($parent -and [Runtime.InteropServices.Marshal]::IsComObject($parent)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($parent)}}
    if([string]$restored.Body -cne [string]$item.Body -or [string]$restored.Subject -cne [string]$item.Subject -or [bool]$restored.UnRead -ne [bool]$item.UnRead -or [int]$restored.FlagStatus -ne [int]$item.FlagStatus -or [string]$restored.Categories -cne [string]$item.Categories){throw 'Synthetic restored state/body fidelity check failed.'}
    $restored=Restore-BackupReceivedTime $restored $fidelity $ns
    Test-ItemBackupFidelity $restored $fidelity $scratchRoot $root $context
    $proofReady=$true
  }finally{
    foreach($o in @($restored,$copy,$opened,$item,$items,$fixtureFolder)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}catch{}}}
    if($attachment -and [Runtime.InteropServices.Marshal]::IsComObject($attachment)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($attachment)}catch{}}
    [GC]::Collect();[GC]::WaitForPendingFinalizers()
    if($attached -and $ns){try{$detachmentConfirmed=Remove-SyntheticPstAttachment $ns $pstPath;if(-not $detachmentConfirmed){$cleanupComplete=$false}}catch{$cleanupComplete=$false}}
    foreach($o in @($pstRoot,$store,$stores)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}catch{}}}
    foreach($o in @($ns,$ol)){if($o -and [Runtime.InteropServices.Marshal]::IsComObject($o)){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o)}catch{}}}
    if(Test-Path -LiteralPath $root){try{if(-not (Remove-SyntheticRunRoot $root $context)){$cleanupComplete=$false}}catch{$cleanupComplete=$false}}
    if($held){$mutex.ReleaseMutex()};$mutex.Dispose()
  }
  if(-not $proofReady){throw 'Synthetic backup/restore fidelity did not pass; no proof was saved.'}
  if(-not $detachmentConfirmed){throw 'Synthetic restore fidelity passed but exact PST detachment was not confirmed; no pending receipt or accepted proof was saved.'}
  if(-not $cleanupComplete){$pending=[ordered]@{schemaVersion=1;accepted=$false;syntheticPstRestoreVerified=$true;backupReopenVerified=$true;attachmentHashesVerified=$true;stateFidelityVerified=$true;fixtureRunRoot=$root;pstFileName='isolated-fixture.pst';verifiedAt=[datetime]::UtcNow.ToString('o')};$pendingPath=Join-Path $StateRoot 'pending-synthetic-restore.dpapi';Save-ProtectedJsonAtomic -Path $pendingPath -Value $pending -Context $context;Write-Output ([pscustomobject]@{Phase='cleanup_pending';Accepted=$false;FidelityVerified=$true;PendingReceiptPath=$pendingPath});return}
  $proof=[ordered]@{schemaVersion=1;syntheticPstRestoreVerified=$true;backupReopenVerified=$true;attachmentHashesVerified=$true;stateFidelityVerified=$true;cleanupFinalized=$true;verifiedAt=[datetime]::UtcNow.ToString('o');finalizedAt=[datetime]::UtcNow.ToString('o')};$proofPath=Join-Path $StateRoot 'synthetic-restore-proof.dpapi';Save-ProtectedJsonAtomic -Path $proofPath -Value $proof -Context $context
  Write-Output ([pscustomobject]@{SyntheticRestoreVerified=$true;AttachmentHashesVerified=$true;StateFidelityVerified=$true;ProofPath=$proofPath})
}
function Assert-Test($Condition,[string]$Name){if(-not $Condition){throw "Behavior test failed: $Name"}}
function Invoke-BehaviorSelfTest {
  Assert-Test ((Get-Classification 'Your application was received' 'Thanks for applying to a role' 'x').Class -eq 'Application receipts') 'receipt classification'
  Assert-Test ((Get-Classification 'Interview request: Engineer' 'We received your application' 'x').Class -eq 'Interviews') 'interview beats receipt footer'
  Assert-Test ((Get-Classification 'Weekly jobs for you' 'New positions matching your preferences' 'x').Class -eq 'Job alerts') 'alerts retained'
  Assert-Test ((Get-Classification 'Credit card statement' 'Your account number and payment are due' 'x').Sensitive) 'sensitive deletion intersection surfaced'
  Assert-Test ((Get-Classification 'Application status' '' 'x' $true).Class -eq 'Review') 'attachment-only review'
  Assert-Test ((Get-Classification 'Offer letter' 'Congratulations' 'x').Class -eq 'Offers') 'offer precedence'
  $x=Get-StringHash 'physical'; Assert-Test ($x -eq (Get-StringHash 'physical')) 'stable physical opaque id'
  Assert-Test ((Get-StringHash 'physical-a') -ne (Get-StringHash 'physical-b')) 'physical item rows remain distinct'
  Write-Output 'Behavior self-test passed.'
}
if($Library){return}
if($SelfTest){Invoke-BehaviorSelfTest; exit 0}
if(-not $Mailbox -or -not $StateRoot){throw 'Mailbox and StateRoot are required.'}
switch($Mode){'Inventory'{Invoke-Inventory};'Review'{Invoke-Review};'CreateTaxonomy'{Invoke-CreateTaxonomy};'Execute'{Invoke-Execute};'Recover'{Invoke-Recover};'VerifySyntheticRestore'{Invoke-SyntheticRestore};'FinalizeSyntheticRestore'{Invoke-FinalizeSyntheticRestore}}

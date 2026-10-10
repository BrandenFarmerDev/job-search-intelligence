[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
  [string]$Mailbox,

  [ValidatePattern('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')]
  [string]$Since = '2026-09-30T07:00:00Z',

  [string]$OutputPath,

  [ValidateRange(1, 5000)]
  [int]$MaxMessagesPerFolder = 2000,

  [switch]$IncludeAllMail,
  [switch]$ValidateOnly,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ComObjects = [System.Collections.Generic.List[object]]::new()

function Track-Com([object]$Value) {
  if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) { $script:ComObjects.Add($Value) }
  return ,$Value
}
function Get-Sha256Hex([string]$Value) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return -join ($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) | ForEach-Object { $_.ToString('x2') }) }
  finally { $algorithm.Dispose() }
}
function Get-MapiText([object]$Item, [string]$Property) {
  try {
    $accessor = Track-Com $Item.PropertyAccessor
    $value = $accessor.GetProperty($Property)
    if ($null -eq $value) { return '' }
    return [string]$value
  } catch { return '' }
}
function Get-StableIdentity([object]$Item) {
  $internetId = Get-MapiText $Item 'http://schemas.microsoft.com/mapi/proptag/0x1035001F'
  if (-not $internetId) { $internetId = Get-MapiText $Item 'http://schemas.microsoft.com/mapi/proptag/0x1035001E' }
  if ($internetId) { return @{ Identity = "internet:$($internetId.Trim().ToLowerInvariant())"; InternetId = $internetId.Trim() } }
  try {
    $accessor = Track-Com $Item.PropertyAccessor
    $searchKey = $accessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x300B0102')
    if ($searchKey -is [byte[]] -and $searchKey.Length) { return @{ Identity = "search:$([Convert]::ToBase64String($searchKey))"; InternetId = '' } }
  } catch { }
  return @{ Identity = "entry:$($Item.EntryID)"; InternetId = '' }
}
function Get-String([object]$Value, [int]$Limit) {
  if ($null -eq $Value) { return '' }
  $result = ([string]$Value).Trim()
  if ($result.Length -gt $Limit) { return $result.Substring(0, $Limit) }
  return $result
}
function Test-JobRelevant([string]$Subject, [string]$Sender, [string]$Body) {
  if ($IncludeAllMail) { return $true }
  $providerPattern = '(?i)(greenhouse|lever\.co|workday|myworkdayjobs|smartrecruiters|ashbyhq|icims|taleo|jobvite|indeed|linkedin)'
  $subjectPattern = '(?i)\b(application|applicant|candidate|recruiter|recruiting|interview|hiring|job|position|role|resume|résumé|screening|assessment|requisition|offer letter|background check|right to represent|not selected|moving forward)\b'
  $bodyPattern = '(?i)(thank you for (applying|your application)|received your application|application (status|was|has been)|candidate (profile|account)|recruit(er|ing)|interview (request|schedule|availability)|requisition|offer letter|background check|right to represent|not selected|moving forward with (your|the) application)'
  return $Sender -match $providerPattern -or $Subject -match $subjectPattern -or $Body -match $bodyPattern
}
function Read-Folder([object]$Store, [int]$FolderKind, [string]$FolderName, [DateTime]$Floor, [string]$AccountId) {
  $folder = Track-Com $Store.GetDefaultFolder($FolderKind)
  $items = Track-Com $folder.Items
  $dateProperty = if ($FolderName -eq 'sentitems') { '[SentOn]' } else { '[ReceivedTime]' }
  [void]$items.GetType().InvokeMember('Sort', [Reflection.BindingFlags]::InvokeMethod, $null, $items, @($dateProperty, $true))
  $result = [System.Collections.Generic.List[object]]::new()
  $scanned = 0
  $matched = 0
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  for ($index = 1; $index -le $items.Count; $index++) {
    $item = Track-Com $items.Item($index)
    if ($null -eq $item -or $item.Class -ne 43) { continue }
    $localDate = if ($FolderName -eq 'sentitems') { [DateTime]$item.SentOn } else { [DateTime]$item.ReceivedTime }
    $occurredAt = $localDate.ToUniversalTime()
    if ($occurredAt -lt $Floor) { break }
    $scanned++
    $stable = Get-StableIdentity $item
    $sender = if ($FolderName -eq 'sentitems') { $Mailbox } else { Get-String $item.SenderEmailAddress 320 }
    $body = Get-String $item.Body 6000
    $subject = Get-String $item.Subject 500
    if (-not (Test-JobRelevant $subject $sender $body)) { continue }
    $immutableId = Get-Sha256Hex "$AccountId|$($stable.Identity)"
    if (-not $seen.Add($immutableId)) { continue }
    $matched++
    if ($result.Count -ge $MaxMessagesPerFolder) { continue }
    $revision = ([DateTime]$item.LastModificationTime).ToUniversalTime().ToString('o')
    $result.Add([ordered]@{
      immutableId = $immutableId
      folder = $FolderName
      subject = $subject
      sender = $sender
      excerpt = Get-String $body 1500
      occurredAt = $occurredAt.ToString('o')
      conversationId = Get-String $item.ConversationID 1000
      internetMessageId = Get-String $stable.InternetId 1000
      revision = $revision
    })
  }
  return @{ Messages = $result; Scanned = $scanned; Matched = $matched; Truncated = $matched -gt $result.Count }
}

$outlook = $null
try {
  if ($null -eq [type]::GetTypeFromProgID('Outlook.Application')) { throw 'Classic Outlook COM is not registered.' }
  $outlook = Track-Com (New-Object -ComObject Outlook.Application)
  $session = Track-Com $outlook.GetNamespace('MAPI')
  $account = $null
  foreach ($candidate in @($session.Accounts)) {
    $candidate = Track-Com $candidate
    if ($candidate.SmtpAddress -ieq $Mailbox) { $account = $candidate; break }
  }
  if ($null -eq $account) { throw 'The requested mailbox is not configured in classic Outlook.' }
  $store = Track-Com $account.DeliveryStore
  if ($null -eq $store) { throw 'The requested mailbox has no accessible Outlook data store.' }
  $inbox = Track-Com $store.GetDefaultFolder(6)
  $sent = Track-Com $store.GetDefaultFolder(5)
  if ($ValidateOnly) {
    [pscustomobject]@{ classicOutlook = $true; mailboxConfigured = $true; inboxAccessible = $null -ne $inbox; sentAccessible = $null -ne $sent } | ConvertTo-Json -Compress
    exit 0
  }
  if (-not $OutputPath) { throw 'OutputPath is required unless ValidateOnly is used.' }
  $destination = [IO.Path]::GetFullPath($OutputPath)
  if ([IO.Path]::GetExtension($destination) -ne '.json') { throw 'OutputPath must end in .json.' }
  if ((Test-Path -LiteralPath $destination) -and -not $Force) { throw 'OutputPath already exists. Choose a new file or pass -Force.' }
  $parent = [IO.Path]::GetDirectoryName($destination)
  if (-not [IO.Directory]::Exists($parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
  $floor = [DateTime]::Parse($Since, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
  $accountId = Get-Sha256Hex ($Mailbox.Trim().ToLowerInvariant())
  $inboxResult = Read-Folder $store 6 'inbox' $floor $accountId
  $sentResult = Read-Folder $store 5 'sentitems' $floor $accountId
  [object[]]$messages = @(@($inboxResult.Messages) + @($sentResult.Messages) | Sort-Object occurredAt)
  $bundle = [ordered]@{
    format = 'job-search-intelligence.outlook-com.v1'
    accountId = $accountId
    exportedAt = [DateTime]::UtcNow.ToString('o')
    since = $floor.ToString('o')
    messages = $messages
    summary = [ordered]@{
      inboxScanned = $inboxResult.Scanned
      inboxMatched = $inboxResult.Matched
      sentitemsScanned = $sentResult.Scanned
      sentitemsMatched = $sentResult.Matched
      truncated = [bool]($inboxResult.Truncated -or $sentResult.Truncated)
    }
  }
  [IO.File]::WriteAllText($destination, ($bundle | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  [pscustomobject]@{ output = $destination; messages = $messages.Count; truncated = $bundle.summary.truncated } | ConvertTo-Json -Compress
} finally {
  for ($index = $script:ComObjects.Count - 1; $index -ge 0; $index--) {
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:ComObjects[$index]) } catch { }
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

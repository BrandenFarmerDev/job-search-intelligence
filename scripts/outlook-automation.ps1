[CmdletBinding()]
param(
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
  [string]$Mailbox,

  [ValidatePattern('^https://[^/\s]+(/\S*)?$')]
  [string]$ApiBase = 'https://jobs-api.brandenfarmer.com/api/job-intelligence',

  [string]$StateDirectory,
  [string]$ApprovedFoldersPath,
  [string]$JunkManifestPath,
  [string]$JunkApprovalHash,

  [ValidateRange(1048576, 1073741824)]
  [long]$QueueMaxBytes = 268435456,

  [ValidateRange(0, 30)]
  [int]$OverlapDays = 3,

  [switch]$DryRun,
  [switch]$SetupCredential,
  [switch]$FullBackfill,
  [switch]$SelfTest,
  [switch]$LibraryOnly
)

# Exit codes: 0 ok or sync still pending, 1 unexpected, 2 export truncated, 3 imports paused by owner,
# 4 Access rejected the credential, 5 forbidden or other client error, 6 Worker busy after retries,
# 7 server sync failed, 8 network or server error after retries.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Floor = [DateTime]::SpecifyKind([DateTime]'2026-09-30T07:00:00', [DateTimeKind]::Utc)
$script:MaxBatchMessages = 40
$script:MaxBatchBytes = 150000
$script:RetryDelays = @(30, 60, 120, 240)
$script:SyncPollSeconds = 15
$script:SyncWaitMinutes = 10
$script:RunBudgetMinutes = 25
$script:LogKeepDays = 30
$script:Utf8 = [Text.UTF8Encoding]::new($false)
$script:ExitCode = 1
$script:StateRoot = $null
$script:LogFile = $null
$script:Headers = $null
$script:Base = $null
$script:State = $null
$script:RuntimeContext = $null
$script:Queue = $null
$script:QueuePath = $null
$script:ApprovedFoldersResolved = $null
$script:Deadline = [DateTime]::MaxValue
$script:SleepFn = { param([int]$Seconds) Start-Sleep -Seconds $Seconds }
$script:RuntimeContextFactory = $null

function Stop-Run([int]$Code, [string]$Reason) {
  Write-Log "result=$Reason exit=$Code"
  $script:ExitCode = $Code
  throw [OperationCanceledException]::new($Reason)
}
function Write-Log([string]$Message) {
  $line = '{0} {1}' -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
  Write-Host $line
  if ($script:LogFile) { try { [IO.File]::AppendAllText($script:LogFile, $line + [Environment]::NewLine, $script:Utf8) } catch { } }
}
function Get-Prop([object]$Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}
function Format-Value([object]$Value) {
  if ($null -eq $Value) { return '' }
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('o') }
  return [string]$Value
}
function Get-Ticks([string]$Value) {
  return [DateTime]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks
}
function Get-Sha256Hex([string]$Value) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($script:Utf8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose()}
}
function Get-SinceWindow([string]$LastExportedAt, [int]$Overlap, [DateTime]$Now) {
  $since = $script:Floor
  if ($LastExportedAt) {
    $last = [DateTime]::Parse($LastExportedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    if ($last -gt $Now) { $last = $Now }
    $candidate = $last.AddDays(-$Overlap)
    if ($candidate -gt $since) { $since = $candidate }
  }
  return $since.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
}
function Get-UpdatedSweepCheckpoint([bool]$CollectionComplete,[string]$Since,[string]$ExportedAt,[string]$Previous) {
  if(-not $CollectionComplete -or -not $Since -or (Get-Ticks $Since) -ne $script:Floor.Ticks){return $Previous}
  return $ExportedAt
}
function Get-DateHealthLabel([string]$Value,[DateTime]$Now,[int]$MaxAgeDays) {
  if(-not $Value){return 'never'}
  $date=[DateTime]::Parse($Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  if($date -gt $Now.AddMinutes(5)){return 'future'}
  if($date -lt $Now.AddDays(-$MaxAgeDays)){return 'stale'}
  return 'recent'
}
function ConvertTo-Message([object]$Raw) {
  $message = [ordered]@{}
  foreach ($name in 'immutableId', 'folder', 'subject', 'sender', 'excerpt', 'occurredAt', 'conversationId', 'internetMessageId', 'revision') { $message[$name] = Format-Value (Get-Prop $Raw $name) }
  return $message
}
function Merge-Messages([object[]]$Messages) {
  $latest = @{}
  foreach ($message in $Messages) {
    $key = "$($message.immutableId):$($message.folder)"
    if (-not $latest.ContainsKey($key) -or (Get-Ticks $message.occurredAt) -gt (Get-Ticks $latest[$key].occurredAt)) { $latest[$key] = $message }
  }
  return ,@($latest.Values | Sort-Object -Property @{ Expression = { Get-Ticks $_.occurredAt } }, @{ Expression = { $_.immutableId } })
}
function ConvertTo-BundleJson([object]$Header, [object[]]$Messages) {
  $bundle = [ordered]@{
    format = 'job-search-intelligence.outlook-com.v1'
    accountId = Format-Value (Get-Prop $Header 'accountId')
    exportedAt = Format-Value (Get-Prop $Header 'exportedAt')
    since = Format-Value (Get-Prop $Header 'since')
    summary = [ordered]@{ truncated = $false }
    messages = $Messages
  }
  return ConvertTo-Json -InputObject $bundle -Depth 10 -Compress
}
function Get-ResponseClass([int]$Status, [string]$Body) {
  if ($Status -ge 200 -and $Status -lt 300) { return 'ok' }
  if ($Status -ge 300 -and $Status -lt 400) { return 'access_rejected' }
  $code = $null
  try { $parsed = $Body | ConvertFrom-Json; $value = Get-Prop $parsed 'error'; if ($value -is [string]) { $code = $value } } catch { }
  if ($Status -eq 401) { return 'access_rejected' }
  if ($Status -eq 403) { if ($code) { return 'forbidden' } else { return 'access_rejected' } }
  if ($Status -eq 409) {
    if ($code -eq 'sync_running') { return 'busy' }
    if ($code -eq 'reconnect_sources_to_resume') { return 'paused' }
    if ($code -in 'data_generation_required','data_generation_mismatch','stale_data_generation') { return 'stale_generation' }
    return 'fatal'
  }
  if ($Status -eq 413) { return 'too_large' }
  if ($Status -eq 0 -or $Status -eq 429 -or $Status -ge 500) { return 'retry' }
  return 'fatal'
}
function Get-StatePath([string]$Name) { return Join-Path $script:StateRoot $Name }
function Get-ErrorCode([string]$Body) {
  try {
    $value=Get-Prop ($Body | ConvertFrom-Json) 'error'
    if($value -is [string] -and $value -match '^[a-z_]{1,64}$'){
      $known=@('origin_not_allowed','origin_required','automation_route_forbidden','request_failed','not_found','method_not_allowed','authentication_required','auth_unconfigured','json_required','invalid_body','payload_too_large','sync_running','invalid_application','route_not_found','sheets_setup_required','reconnect_sources_to_resume','invalid_source','source_not_found','application_required','event_type_required','application_not_found','invalid_merge_target','merge_status_required','invalid_patch','invalid_field','invalid_status','invalid_date','invalid_url','confirmation_required','sync_lease_lost','missing_graph_checkpoint','mail_page_limit_resume_required','processing_limit_resume_required','data_generation_unavailable','data_generation_required','data_generation_mismatch','stale_data_generation','invalid_local_outlook_bundle','local_outlook_export_truncated','graph_is_authoritative','microsoft_setup_required','invalid_provider_scope','invalid_oauth_state','expired_oauth_state','mailbox_owner_required','historical_date_required','unsafe_graph_cursor','invalid_graph_page','invalid_message_date','invalid_message_body','sheet_row_limit','sheet_headers_changed','invalid_google_token','empty_sheet_response','provider_rate_limited','provider_request_failed','encryption_unconfigured')
      if($value -in $known){return $value}
      return 'unknown_error'
    }
  } catch { }
  return '-'
}
function Get-RemainingRunSeconds {
  if($script:Deadline -eq [DateTime]::MaxValue){return [int]::MaxValue}
  $remaining=[int][Math]::Floor(($script:Deadline-[DateTime]::UtcNow).TotalSeconds)
  if($remaining -le 0){Stop-Run 8 'run_budget_exhausted'}
  return $remaining
}
function Get-RunSyncDeadline {
  $candidate=[DateTime]::UtcNow.AddMinutes($script:SyncWaitMinutes)
  if($script:Deadline -lt $candidate){return $script:Deadline}
  return $candidate
}
function Invoke-Api([string]$Method, [string]$Path, [byte[]]$Body) {
  $request = @{ Uri = "$script:Base$Path"; Method = $Method; Headers = $script:Headers; UseBasicParsing = $true; MaximumRedirection = 0; TimeoutSec = [Math]::Min(60,(Get-RemainingRunSeconds)) }
  if ($null -ne $Body) { $request.Body = $Body; $request.ContentType = 'application/json' }
  try {
    $response = Invoke-WebRequest @request
    return @{ Status = [int]$response.StatusCode; Body = [string]$response.Content; Headers = $response.Headers }
  } catch {
    $failure = $_; $status = 0; $text = ''
    $reply = Get-Prop $failure.Exception 'Response'
    if ($reply) {
      $status = [int]$reply.StatusCode
      try {
        if ($reply -is [Net.HttpWebResponse]) { $reader = [IO.StreamReader]::new($reply.GetResponseStream(), $script:Utf8); try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() } }
        elseif ($failure.ErrorDetails) { $text = [string]$failure.ErrorDetails.Message }
      } catch { }
    } elseif ($failure.Exception.Message -match 'redirect') { $status = 302 }
    $headers = @{}
    try { if ($reply) { $headers = $reply.Headers } } catch { }
    return @{ Status = $status; Body = $text; Headers = $headers }
  }
}
function Invoke-ApiCall([string]$Method, [string]$Path, [byte[]]$Body, [string]$Label, [hashtable]$ExtraHeaders = @{}) {
  for ($attempt = 0; ; $attempt++) {
    [void](Get-RemainingRunSeconds)
    if ($ExtraHeaders.Count) {
      $original=$script:Headers; $script:Headers=@{} + $original + $ExtraHeaders
      try { $result = Invoke-Api $Method $Path $Body } finally { $script:Headers=$original }
    } else { $result = Invoke-Api $Method $Path $Body }
    $class = Get-ResponseClass $result.Status $result.Body
    Write-Log "call=$Label status=$($result.Status) error=$(Get-ErrorCode $result.Body) attempt=$($attempt + 1)"
    switch ($class) {
      'ok' { return $result }
      'too_large' { return $result }
      'paused' { Stop-Run 3 'imports_paused_by_owner' }
      'access_rejected' { Stop-Run 4 'access_rejected' }
      'forbidden' { Stop-Run 5 'forbidden' }
      'stale_generation' {
        if ($script:QueuePath -and (Test-Path -LiteralPath $script:QueuePath)) {
          $stalePath="$script:QueuePath.stale-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))"
          Move-Item -LiteralPath $script:QueuePath -Destination $stalePath
          try { Reset-ReconciliationForStaleQueue (Read-State) } catch { }
        }
        Stop-Run 5 'stale_queue_generation_owner_review_required'
      }
      'fatal' { Stop-Run 5 'client_error' }
    }
    if ($attempt -ge $script:RetryDelays.Count -or [DateTime]::UtcNow.AddSeconds($script:RetryDelays[$attempt]) -gt $script:Deadline) {
      if ($class -eq 'busy') { Stop-Run 6 'busy_after_retries' }
      Stop-Run 8 'server_unavailable_after_retries'
    }
    & $script:SleepFn $script:RetryDelays[$attempt]
  }
}
function Get-UploadPrivateStateBytes {
  $total=0L;$directories=[Collections.Generic.Stack[string]]::new();$directories.Push($script:StateRoot)
  while($directories.Count){$directory=$directories.Pop();$attributes=[IO.File]::GetAttributes($directory);if(($attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){Stop-Run 5 'private_state_reparse_point'}
    foreach($child in [IO.Directory]::GetDirectories($directory)){
      if($directory.Equals($script:StateRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($child).Equals('mailbox-cleanup',[StringComparison]::OrdinalIgnoreCase)){continue}
      $directories.Push($child)
    }
    foreach($file in [IO.Directory]::GetFiles($directory)){$fileAttributes=[IO.File]::GetAttributes($file);if(($fileAttributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){Stop-Run 5 'private_state_reparse_point'};if(-not $file.Equals($script:QueuePath,[StringComparison]::OrdinalIgnoreCase)){$total += ([IO.FileInfo]::new($file)).Length}}
  }
  return $total
}
function Save-Queue {
  $bytes = $script:Utf8.GetByteCount((ConvertTo-Json -InputObject $script:Queue -Depth 30 -Compress))
  $pendingBytes=Get-UploadPrivateStateBytes
  # Reserve 4 KiB for DPAPI framing/atomic replacement and count stale queues,
  # collection state, logs, credentials, and other durable private files.
  if (($pendingBytes + $bytes + 4096L) -gt $QueueMaxBytes) { Stop-Run 5 'durable_private_state_disk_ceiling' }
  Save-ProtectedJsonAtomic -Path $script:QueuePath -Value $script:Queue -Context $script:RuntimeContext
}
function Send-QueueNode([object]$Node) {
  if ($Node.acknowledged) { return }
  if (@($Node.children).Count -gt 0) { foreach ($child in $Node.children) { Send-QueueNode $child }; return }
  $payload = $script:Utf8.GetBytes((ConvertTo-BundleJson $script:Queue.header @($Node.messages)))
  if ($payload.Length -gt $script:MaxBatchBytes -and @($Node.messages).Count -eq 1) { Stop-Run 5 'single_message_too_large' }
  $result = Invoke-ApiCall 'POST' '/local-outlook/import' $payload "import-$($Node.id)" @{ 'X-Job-Data-Generation' = [string]$script:Queue.generation }
  if ($result.Status -ne 413) { $Node.acknowledged = $true; Save-Queue; return }
  if (@($Node.messages).Count -le 1) { Stop-Run 5 'single_message_too_large' }
  $half=[int][Math]::Ceiling(@($Node.messages).Count / 2)
  $Node.children=@(
    [ordered]@{ id="$($Node.id).0"; messages=@($Node.messages[0..($half-1)]); acknowledged=$false; children=@() },
    [ordered]@{ id="$($Node.id).1"; messages=@($Node.messages[$half..($Node.messages.Count-1)]); acknowledged=$false; children=@() }
  )
  $Node.messages=@()
  Save-Queue
  foreach ($child in $Node.children) { Send-QueueNode $child }
}
function Get-Generation {
  $result=Invoke-ApiCall 'GET' '/sync-runs' $null 'bind-data-generation'
  $generation=$null
  try { $generation=[string]$result.Headers['X-Job-Data-Generation'] } catch { }
  if (-not $generation -or $generation -notmatch '^[A-Za-z0-9._:-]{1,128}$') { Stop-Run 5 'data_generation_header_missing' }
  return $generation
}
function Start-Sync {
  $result = Invoke-ApiCall 'POST' '/sync/run' $null 'sync-run'
  return [string](Get-Prop ($result.Body | ConvertFrom-Json) 'id')
}
function Wait-SyncRun([string]$Id, [DateTime]$Until) {
  while ($true) {
    $result = Invoke-ApiCall 'GET' '/sync-runs' $null 'sync-runs'
    $runs = $result.Body | ConvertFrom-Json
    foreach ($run in @($runs)) {
      if ($run -and (Get-Prop $run 'id') -eq $Id) {
        $status = [string](Get-Prop $run 'status')
        if ($status -in 'completed', 'continued', 'failed', 'skipped_overlap') { return $status }
      }
    }
    if ([DateTime]::UtcNow.AddSeconds($script:SyncPollSeconds) -gt $Until) { return 'pending' }
    & $script:SleepFn $script:SyncPollSeconds
  }
}
function Read-State {
  $path = Get-StatePath 'state.json'
  if (-not (Test-Path -LiteralPath $path)) { return @{} }
  try {
    $raw=[IO.File]::ReadAllBytes($path); $first=0; while($first -lt $raw.Length -and $raw[$first] -in 9,10,13,32){$first++}
    if($first -lt $raw.Length -and $raw[$first] -eq 123) {
      $legacy=[IO.File]::ReadAllText($path,$script:Utf8)|ConvertFrom-Json -ErrorAction Stop
      $backup="$path.legacy-backup"; if(-not(Test-Path -LiteralPath $backup)){Copy-Item -LiteralPath $path -Destination $backup}
      $migrated=[ordered]@{schemaVersion=2;lastExportedAt=(Format-Value $legacy.lastExportedAt);lastMessages=$legacy.lastMessages;lastBatches=$legacy.lastBatches;lastSweepAt=''}
      Save-ProtectedJsonAtomic -Path $path -Value $migrated -Context $script:RuntimeContext
      return $migrated
    }
  } catch { Write-Log 'state=legacy_migration_failed_full_reconciliation_required' }
  try { $saved=Read-ProtectedJson -Path $path -Context $script:RuntimeContext -QuarantineInvalid; return $saved } catch {
    # One-time migration keeps a rollback copy before replacing the legacy checkpoint.
    try {
      $legacy=[IO.File]::ReadAllText($path,$script:Utf8) | ConvertFrom-Json -ErrorAction Stop
      $backup="$path.legacy-backup"
      if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $path -Destination $backup }
      if ($null -ne (Get-Prop $legacy 'lastExportedAt')) {
        $migrated=[ordered]@{ schemaVersion=2; lastExportedAt=(Format-Value $legacy.lastExportedAt); lastMessages=$legacy.lastMessages; lastBatches=$legacy.lastBatches; lastSweepAt='' }
        Save-ProtectedJsonAtomic -Path $path -Value $migrated -Context $script:RuntimeContext
        return $migrated
      }
    } catch { }
    Write-Log 'state=unreadable_full_reconciliation_required'
    return @{ schemaVersion=2; lastExportedAt=''; lastSweepAt='' }
  }
}
function Write-ContentFreeHealth([object]$Values,[DateTime]$Now) {
  $exportLabel=Get-DateHealthLabel (Format-Value (Get-Prop $Values 'lastExportedAt')) $Now 1
  $sweepLabel=Get-DateHealthLabel (Format-Value (Get-Prop $Values 'lastSweepAt')) $Now 7
  Write-Log "health_last_export=$exportLabel health_last_floor_sweep=$sweepLabel"
  if($exportLabel -eq 'stale'){Write-Log 'warning=last_successful_export_older_than_24h'}
  if($sweepLabel -in 'stale','never'){Write-Log 'warning=floor_reconciliation_sweep_due_or_never_completed'}
}
function Save-State([object]$Values) {
  $path = Get-StatePath 'state.json'
  if (-not $Values.schemaVersion) { $Values.schemaVersion=2 }
  Save-ProtectedJsonAtomic -Path $path -Value $Values -Context $script:RuntimeContext
}
function Reset-ReconciliationForStaleQueue([object]$Values) {
  $fresh=[ordered]@{schemaVersion=2;lastExportedAt='';lastMessages=0;lastBatches=0;lastSweepAt='';storeBinding=(Get-Prop $Values 'storeBinding')}
  Save-State $fresh
  $collectionPath=Get-StatePath 'collection-state.dpapi'
  if(Test-Path -LiteralPath $collectionPath){Remove-Item -LiteralPath $collectionPath -Force}
}
function Initialize-State {
  $script:StateRoot = if ($StateDirectory) { $StateDirectory } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'JobSearchIntelligence' } else { Join-Path ([IO.Path]::GetTempPath()) 'JobSearchIntelligence' }
  $script:StateRoot=[IO.Path]::GetFullPath($script:StateRoot)
  $repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  if($script:StateRoot.Equals($repository,[StringComparison]::OrdinalIgnoreCase) -or $script:StateRoot.StartsWith($repository+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Private Outlook state must be outside the repository.'}
  Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  Protect-PrivateDirectory $script:StateRoot
  foreach ($name in 'logs', 'work') { Protect-PrivateDirectory (Get-StatePath $name) }
  $binding=Get-Sha256Hex (($Mailbox.Trim().ToLowerInvariant()) + '|' + ([Uri]$ApiBase).Host)
  $script:RuntimeContext=New-OutlookRuntimeContext -StateRoot $script:StateRoot -Environment ([Uri]$ApiBase).Host -MailboxBinding $binding -ConfigVersion 'outlook-v2'
  $script:QueuePath=Get-StatePath 'upload-queue.dpapi'
  $script:LogFile = Join-Path (Get-StatePath 'logs') ([DateTime]::UtcNow.ToString('yyyyMMdd') + '.log')
}
function Clear-Work {
  $artifact=[IO.Path]::GetFullPath((Join-Path (Get-StatePath 'work') 'export.json'))
  if(-not $artifact.StartsWith([IO.Path]::GetFullPath((Get-StatePath 'work')).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Export artifact escaped private work directory.'}
  if(Test-Path -LiteralPath $artifact){$attributes=[IO.File]::GetAttributes($artifact);if(($attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Export artifact may not be a reparse point.'};if(($attributes -band [IO.FileAttributes]::Directory)-ne 0){throw 'Export artifact path is unexpectedly a directory.'};Remove-Item -LiteralPath $artifact -Force}
}
function Remove-OldLogs { Get-ChildItem -LiteralPath (Get-StatePath 'logs') -Filter '*.log' | Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-$script:LogKeepDays) } | Remove-Item -Force }
function Read-Credential {
  $path = Get-StatePath 'automation-credential.xml'
  if (-not (Test-Path -LiteralPath $path)) { Stop-Run 1 'credential_missing_run_setup' }
  try { $credential = Import-Clixml -LiteralPath $path } catch { Stop-Run 1 'credential_unreadable_run_setup' }
  $script:Headers = @{ 'CF-Access-Client-Id' = $credential.UserName; 'CF-Access-Client-Secret' = $credential.GetNetworkCredential().Password }
}
function Set-Credential {
  $script:StateRoot = if ($StateDirectory) { $StateDirectory } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'JobSearchIntelligence' } else { throw 'No state directory is available.' }
  [IO.Directory]::CreateDirectory($script:StateRoot) | Out-Null
  $plain = {
    param([Security.SecureString]$Value)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }
  $id = & $plain (Read-Host -AsSecureString 'Access service token client ID')
  $secret = Read-Host -AsSecureString 'Access service token client secret'
  if (-not $id -or $id -match '\s' -or (& $plain $secret).Length -eq 0) { throw 'Both the client ID and the client secret are required.' }
  Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
  Protect-PrivateDirectory $script:StateRoot
  [pscredential]::new($id, $secret) | Export-Clixml -LiteralPath (Get-StatePath 'automation-credential.xml')
  Write-Host 'Credential saved for this Windows user on this PC. It is not logged or displayed.'
}
function New-OutlookRuntimeContext([string]$StateRoot,[string]$Environment,[string]$MailboxBinding,[string]$ConfigVersion) {
  if($script:RuntimeContextFactory){return (& $script:RuntimeContextFactory $StateRoot $Environment $MailboxBinding $ConfigVersion)}
  return New-PrivateRuntimeContext -StateRoot $StateRoot -Environment $Environment -MailboxBinding $MailboxBinding -ConfigVersion $ConfigVersion
}
function Invoke-OutlookCollector([hashtable]$Arguments) {
  $exporter=Join-Path $PSScriptRoot 'outlook-com-export.ps1'
  return (& $exporter @Arguments)
}
function Export-Mail([string]$Since, [string]$Destination) {
  if ([bool]$JunkManifestPath -ne [bool]$JunkApprovalHash) { Stop-Run 5 'junk_capture_requires_manifest_and_exact_approval_hash' }
  $until=if($script:Queue -and $script:Queue.untilUtc){[string]$script:Queue.untilUtc}else{[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')}
  $statePath=Get-StatePath 'collection-state.dpapi'
  $approved=$script:ApprovedFoldersResolved
  $remaining=Get-RemainingRunSeconds
  $collectorBudget=[int][Math]::Min(1200,$remaining-60)
  if($collectorBudget -lt 1){Stop-Run 8 'run_budget_exhausted_before_export'}
  $arguments=@{Mailbox=$Mailbox;Since=$Since;Until=$until;OutputPath=$Destination;StatePath=$statePath;RuntimeContext=$script:RuntimeContext;ApprovedFoldersPath=$approved;BudgetSeconds=$collectorBudget;Force=$true;ProtectedOutput=$true}
  if($JunkManifestPath -and $JunkApprovalHash){$arguments.JunkManifestPath=$JunkManifestPath;$arguments.JunkApprovalHash=$JunkApprovalHash}
  try { [void](Invoke-OutlookCollector $arguments) }
  catch { Write-Log "export=failed type=$($_.Exception.GetType().Name)"; Stop-Run 1 'export_failed' }
  try { $bundle=Read-ProtectedJson -Path $Destination -Context $script:RuntimeContext }
  catch { throw 'Protected collector output could not be opened; it was not interpreted as plaintext.' }
  finally { if(Test-Path -LiteralPath $Destination){Remove-Item -LiteralPath $Destination -Force} }
  $summary = Get-Prop $bundle 'summary'
  if ((Get-Prop $summary 'truncated') -ne $false) {
    Write-Log 'export=truncated action=run_a_narrower_manual_export_with_outlook-com-export.ps1_and_import_it_from_the_dashboard'
    Stop-Run 2 'export_truncated'
  }
  return $bundle
}
function Get-CollectorValidation {
  $exporter=Join-Path $PSScriptRoot 'outlook-com-export.ps1'
  try { $json=& $exporter -Mailbox $Mailbox -ApprovedFoldersPath $script:ApprovedFoldersResolved -ValidateOnly }
  catch { Write-Log "collector_validation=failed type=$($_.Exception.GetType().Name)"; Stop-Run 1 'collector_validation_failed' }
  try { return ($json | ConvertFrom-Json -ErrorAction Stop) } catch { Stop-Run 5 'collector_validation_response_invalid' }
}
function Test-QueueNodePending([object]$Node) {
  if($Node.acknowledged){return $false}
  if(@($Node.children).Count -gt 0){foreach($child in $Node.children){if(Test-QueueNodePending $child){return $true}};return $false}
  return @($Node.messages).Count -gt 0
}
function Test-QueueNeedsCollectorValidation {
  if($script:Queue.phase -in 'discovering','collection_ready'){return $true}
  foreach($batch in @($script:Queue.batches)){if(Test-QueueNodePending $batch){return $true}}
  return $false
}
function Resolve-PendingSync([object]$Values) {
  if($script:Queue.phase -ne 'processing_pending' -or -not $script:Queue.syncRunId){return 'continue'}
  $outcome=Wait-SyncRun ([string]$script:Queue.syncRunId) (Get-RunSyncDeadline)
  if($outcome -eq 'completed'){
    if($script:Queue.collection.complete){Save-State $Values}
    Remove-Item -LiteralPath $script:QueuePath -Force
    Write-Log 'result=completed exit=0';return 'completed'
  }
  if($outcome -eq 'pending'){Write-Log 'result=upload_accepted_processing_pending exit=0';return 'pending'}
  if($outcome -eq 'failed' -or $outcome -eq 'skipped_overlap'){
    $script:Queue.phase='sync';$script:Queue.syncRunId='';Save-Queue;return 'retry'
  }
  if($outcome -eq 'continued'){
    $id=Start-Sync;$script:Queue.syncRunId=$id;Save-Queue
    $outcome=Wait-SyncRun $id (Get-RunSyncDeadline)
    if($outcome -eq 'completed'){
      if($script:Queue.collection.complete){Save-State $Values}
      Remove-Item -LiteralPath $script:QueuePath -Force;Write-Log 'result=completed exit=0';return 'completed'
    }
    if($outcome -eq 'failed' -or $outcome -eq 'skipped_overlap'){$script:Queue.phase='sync';$script:Queue.syncRunId='';Save-Queue;return 'retry'}
    $script:Queue.phase='processing_pending';$script:Queue.syncRunId=$id;Save-Queue
    Write-Log 'result=upload_accepted_processing_pending exit=0';return 'pending'
  }
  $script:Queue.phase='sync';$script:Queue.syncRunId='';Save-Queue;return 'retry'
}
function Invoke-Run {
  Initialize-State
  $lease=$null
  try {
    $lease=Enter-MaintenanceCoordinator -Context $script:RuntimeContext -RequireGateClear
    if (-not $lease.Acquired) { Write-Log 'result=already_running exit=0'; return 0 }
    if ($lease.GateEnabled) { Write-Log 'result=maintenance_gate_enabled exit=0'; return 0 }
    $started = [DateTime]::UtcNow
    $script:Deadline = $started.AddMinutes($script:RunBudgetMinutes)
    [void](Get-RemainingRunSeconds)
    Clear-Work; Remove-OldLogs
    $script:Base = $ApiBase.TrimEnd('/')
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $DryRun) { Read-Credential }
    $state=Read-State
    Write-ContentFreeHealth $state $started
    $script:ApprovedFoldersResolved=if($ApprovedFoldersPath){[IO.Path]::GetFullPath($ApprovedFoldersPath)}else{Get-StatePath 'approved-folders.dpapi'}
    if ($DryRun) {
      $since=Get-SinceWindow (Format-Value (Get-Prop $state 'lastExportedAt')) $OverlapDays $started
      $bundle=Export-Mail $since (Join-Path (Get-StatePath 'work') 'export.json')
      Write-Log "result=dry_run_ok messages=$(@(Get-Prop $bundle 'messages').Count) exit=0"
      return 0
    }
    $generation=Get-Generation
    $script:Queue=Read-ProtectedJson -Path $script:QueuePath -Context $script:RuntimeContext -QuarantineInvalid
    if ($script:Queue -and $script:Queue.generation -ne $generation) {
      $stalePath="$script:QueuePath.stale-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))"
      Move-Item -LiteralPath $script:QueuePath -Destination $stalePath
      Reset-ReconciliationForStaleQueue $state
      Stop-Run 5 'stale_queue_generation_owner_review_required'
    }
    if (-not $script:Queue) {
      $script:Queue=[ordered]@{ schemaVersion=1; generation=$generation; phase='discovering'; createdAt=$started.ToString('o'); untilUtc=$started.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ'); header=$null; batches=@(); collection=$null; syncRequired=$false; syncRunId='' }
      Save-Queue # bind generation before touching Outlook discovery
    }
    if(Test-QueueNeedsCollectorValidation){
      $validated=Get-CollectorValidation
      $liveStore=[string](Get-Prop $validated 'storeBinding')
      if(-not $liveStore){Stop-Run 5 'collector_store_binding_missing'}
      if((Get-Prop $state 'storeBinding') -and (Get-Prop $state 'storeBinding') -ne $liveStore){Stop-Run 5 'outlook_store_changed_owner_review_required'}
      $queueStore=[string](Get-Prop $script:Queue 'storeBinding')
      if($queueStore -and $queueStore -ne $liveStore){
        $stalePath="$script:QueuePath.store-stale-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))";Move-Item -LiteralPath $script:QueuePath -Destination $stalePath
        Stop-Run 5 'outlook_store_changed_queue_owner_review_required'
      }
      if(-not $queueStore){$script:Queue.storeBinding=$liveStore;Save-Queue}
    }
    if($script:Queue.createdAt -and (Get-Ticks $script:Queue.createdAt) -le $started.AddHours(-24).Ticks){Write-Log 'pending_queue_age_warning=true threshold_hours=24'}
    if ($script:Queue.phase -eq 'discovering') {
      $lastSweep=Get-Prop $state 'lastSweepAt'
      $since=if ($FullBackfill -or -not $lastSweep -or (Get-Ticks $lastSweep) -le $started.AddDays(-7).Ticks) { $script:Floor.ToString('yyyy-MM-ddTHH:mm:ssZ') } else { Get-SinceWindow (Format-Value (Get-Prop $state 'lastExportedAt')) $OverlapDays $started }
      Write-Log "start mailbox_configured=true since=$since dry_run=$([bool]$DryRun) full_backfill=$([bool]$FullBackfill)"
      $bundle=Export-Mail $since (Join-Path (Get-StatePath 'work') 'export.json')
      $collection=Get-Prop $bundle 'collection'
      if(-not $collection -or (Get-Prop $collection 'schemaVersion') -ne 1 -or -not (Get-Prop $collection 'storeBinding')) { Stop-Run 5 'collector_state_contract_invalid' }
      if((Get-Prop $state 'storeBinding') -and (Get-Prop $state 'storeBinding') -ne $collection.storeBinding){ Stop-Run 5 'outlook_store_changed_owner_review_required' }
      $messages=Merge-Messages @(@(Get-Prop $bundle 'messages') | Where-Object { $null -ne $_ } | ForEach-Object { ConvertTo-Message $_ })
      $header=[pscustomobject]@{ accountId=Get-Prop $bundle 'accountId'; exportedAt=Get-Prop $bundle 'exportedAt'; since=Get-Prop $bundle 'since' }
      $batches=@(); $current=[Collections.Generic.List[object]]::new(); $batchBytes=$script:Utf8.GetByteCount((ConvertTo-BundleJson $header @()))
      foreach($message in $messages) {
        $candidate=@($current.ToArray()) + @($message); $envelope=$script:Utf8.GetBytes((ConvertTo-BundleJson $header $candidate))
        if($current.Count -gt 0 -and ($current.Count -ge $script:MaxBatchMessages -or $envelope.Length -gt $script:MaxBatchBytes)) { $batches += ,([ordered]@{ id=([string]($batches.Count+1)); messages=@($current.ToArray()); acknowledged=$false; children=@() }); $current=[Collections.Generic.List[object]]::new(); $candidate=@($message); $envelope=$script:Utf8.GetBytes((ConvertTo-BundleJson $header $candidate)) }
        if($envelope.Length -gt $script:MaxBatchBytes) { Stop-Run 5 'single_message_too_large' }
        $current.Add($message); $batchBytes=$envelope.Length
      }
      if($current.Count) { $batches += ,([ordered]@{ id=([string]($batches.Count+1)); messages=@($current.ToArray()); acknowledged=$false; children=@() }) }
      $script:Queue.header=$header; $script:Queue.batches=@($batches); $script:Queue.phase='collection_ready'; $script:Queue.discoveredCount=$messages.Count
      $script:Queue.storeBinding=[string]$collection.storeBinding; $script:Queue.collection=$collection
      Save-Queue
    }
    if($script:Queue.phase -eq 'collection_ready') {
      Save-ProtectedJsonAtomic -Path (Get-StatePath 'collection-state.dpapi') -Value $script:Queue.collection.nextState -Context $script:RuntimeContext
      $script:Queue.phase='uploading'; Save-Queue
      Write-Log "coverage=collected complete=$([bool]$script:Queue.collection.complete) review_count=$([int]$script:Queue.collection.reviewCount) messages=$($script:Queue.discoveredCount) batches=$(@($script:Queue.batches).Count)"
    }
    if ($DryRun) { Write-Log 'result=dry_run_ok exit=0'; return 0 }
    $values=[ordered]@{ schemaVersion=2; lastExportedAt=if($script:Queue.collection.complete) { Format-Value (Get-Prop $script:Queue.header 'exportedAt') } else { Format-Value (Get-Prop $state 'lastExportedAt') }; lastMessages=$script:Queue.discoveredCount; lastBatches=@($script:Queue.batches).Count; reviewCount=[int](Get-Prop $script:Queue.collection 'reviewCount'); lastSweepAt=Get-UpdatedSweepCheckpoint ([bool]$script:Queue.collection.complete) ([string]$script:Queue.header.since) ([string]$script:Queue.header.exportedAt) (Format-Value (Get-Prop $state 'lastSweepAt')); storeBinding=$script:Queue.storeBinding }
    $resume=Resolve-PendingSync $values
    if($resume -eq 'completed'){return 0}
    if($resume -eq 'pending'){return 0}
    foreach($batch in $script:Queue.batches) { Send-QueueNode $batch }
    $script:Queue.syncRequired=$true; $script:Queue.phase='sync'; Save-Queue
    $id = $null; $deadline = Get-RunSyncDeadline
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $id = Start-Sync
      $script:Queue.syncRunId=$id; Save-Queue
      $outcome = Wait-SyncRun $id $deadline
      Write-Log "sync=$outcome attempt=$attempt"
      if ($outcome -eq 'completed') { if($script:Queue.collection.complete){Save-State $values}; Remove-Item -LiteralPath $script:QueuePath -Force; Write-Log 'result=completed exit=0'; return 0 }
      if ($outcome -eq 'continued') { $script:Queue.phase='processing_pending'; $script:Queue.syncRunId=$id; Save-Queue; Write-Log 'result=upload_accepted_processing_pending exit=0'; return 0 }
      if ($outcome -eq 'failed') { Stop-Run 7 'sync_failed' }
      if ($outcome -eq 'pending') { $script:Queue.phase='processing_pending'; $script:Queue.syncRunId=$id; Save-Queue; Write-Log 'result=upload_accepted_processing_pending exit=0'; return 0 }
      & $script:SleepFn 60
    }
    Write-Log 'result=pending_overlap exit=0'
    return 0
  } catch [OperationCanceledException] {
    return $script:ExitCode
  } catch {
    Write-Log "result=unexpected type=$($_.Exception.GetType().Name) exit=1"
    return 1
  } finally {
    if ($lease) { $lease.Dispose() }
  }
}
function Assert-Equal([object]$Actual, [object]$Expected, [string]$Name) {
  if ((ConvertTo-Json -InputObject $Actual -Compress -Depth 6) -ne (ConvertTo-Json -InputObject $Expected -Compress -Depth 6)) { throw "SelfTest failed: $Name" }
}
function Invoke-SelfTest {
  $now = [DateTime]::Parse('2026-10-10T12:00:00Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
  Assert-Equal (Get-SinceWindow '' 3 $now) '2026-09-30T07:00:00Z' 'first run uses the floor'
  Assert-Equal (Get-SinceWindow '2026-10-01T00:00:00.0000000Z' 3 $now) '2026-09-30T07:00:00Z' 'overlap never goes below the floor'
  Assert-Equal (Get-SinceWindow '2026-10-08T06:30:15.1234567Z' 3 $now) '2026-10-05T06:30:15Z' 'overlap is subtracted and fractions dropped'
  Assert-Equal (Get-SinceWindow '2027-01-01T00:00:00Z' 3 $now) '2026-10-07T12:00:00Z' 'a future state is clamped to now'
  Assert-Equal (Get-UpdatedSweepCheckpoint $true '2026-09-30T07:00:00.0000000Z' '2026-10-10T12:00:00.0000000Z' 'previous') '2026-10-10T12:00:00.0000000Z' 'fractional UTC floor checkpoint advances the sweep'
  Assert-Equal (Get-UpdatedSweepCheckpoint $false '2026-09-30T07:00:00.0000000Z' '2026-10-10T12:00:00.0000000Z' 'previous') 'previous' 'incomplete floor scan does not advance the sweep checkpoint'
  Assert-Equal (Get-DateHealthLabel '' $now 1) 'never' 'health distinguishes an initial empty state'
  Assert-Equal (Get-DateHealthLabel '2026-10-09T12:00:00.0000000Z' $now 1) 'recent' 'health reports recent export without message content'
  Assert-Equal (Get-DateHealthLabel '2026-10-08T11:59:59.0000000Z' $now 1) 'stale' 'health reports exports older than one day'
  Assert-Equal (Get-DateHealthLabel '2026-10-02T12:00:00.0000000Z' $now 7) 'stale' 'health reports floor sweep due after seven days'

  $a = [ordered]@{ immutableId = 'a'; folder = 'inbox'; occurredAt = '2026-10-02T10:00:00.0000000Z' }
  $newer = [ordered]@{ immutableId = 'a'; folder = 'inbox'; occurredAt = '2026-10-03T10:00:00.0000000Z' }
  $sent = [ordered]@{ immutableId = 'a'; folder = 'sentitems'; occurredAt = '2026-10-01T10:00:00.0000000Z' }
  $merged = Merge-Messages @($a, $sent, $newer)
  Assert-Equal @($merged | ForEach-Object { "$($_.folder)@$($_.occurredAt)" }) @('sentitems@2026-10-01T10:00:00.0000000Z', 'inbox@2026-10-03T10:00:00.0000000Z') 'dedupe keeps the latest per id and folder'
  Assert-Equal (Merge-Messages @()).Count 0 'empty merge stays empty'

  $header = [pscustomobject]@{ accountId = ('a' * 64); exportedAt = '2026-10-10T12:00:00.0000000Z'; since = '2026-09-30T07:00:00.0000000Z' }
  $one = ConvertTo-BundleJson $header @((ConvertTo-Message ([pscustomobject]@{ immutableId = 'x'; folder = 'inbox'; occurredAt = [DateTime]::Parse('2026-10-02T10:00:00Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal) })))
  if ($one -notmatch '"messages":\[\{' -or $one -notmatch '"occurredAt":"2026-10-02T10:00:00\.0000000Z"' -or $one -notmatch '"summary":\{"truncated":false\}' -or $one -notmatch '"accountId":"a{64}"' -or $one -notmatch '"exportedAt":"2026-10-10T12:00:00\.0000000Z"') { throw 'SelfTest failed: one-element batch must serialize as an array with ISO dates' }
  if ((ConvertTo-BundleJson $header @()) -notmatch '"messages":\[\]') { throw 'SelfTest failed: empty batch must serialize as an empty array' }

  $worker = '{"error":"automation_route_forbidden","message":"x"}'
  $cases = @(
    @(200, '', 'ok'), @(202, '{}', 'ok'), @(302, '', 'access_rejected'), @(401, $worker, 'access_rejected'), @(403, '<html>Access</html>', 'access_rejected'),
    @(403, '', 'access_rejected'), @(403, $worker, 'forbidden'), @(409, '{"error":"sync_running"}', 'busy'), @(409, '{"error":"reconnect_sources_to_resume"}', 'paused'),
    @(409, '{"error":"local_outlook_export_truncated"}', 'fatal'), @(413, '{"error":"payload_too_large"}', 'too_large'), @(400, '{"error":"invalid_body"}', 'fatal'),
    @(429, '', 'retry'), @(500, '', 'retry'), @(503, '<html>', 'retry'), @(0, '', 'retry'), @(404, '', 'fatal')
  )
  foreach ($case in $cases) { Assert-Equal (Get-ResponseClass $case[0] $case[1]) $case[2] "response $($case[0]) $($case[1])" }
  Assert-Equal (Get-ErrorCode $worker) 'automation_route_forbidden' 'error code is read from the Worker shape'
  Assert-Equal (Get-ErrorCode 'Subject: private <html>') '-' 'non-JSON bodies are never logged'
  Assert-Equal (Get-ErrorCode '{"error":"confidentialclienttoken"}') 'unknown_error' 'letters-only private API text is never copied into logs'
  Write-Host 'Self-test passed.'
}

if ($SelfTest) {
  try { Invoke-SelfTest; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}
if ($LibraryOnly) { return }
if ($SetupCredential) { Set-Credential; exit 0 }
if (-not $Mailbox) { [Console]::Error.WriteLine('Mailbox is required.'); exit 1 }
exit [int](Invoke-Run | Select-Object -Last 1)

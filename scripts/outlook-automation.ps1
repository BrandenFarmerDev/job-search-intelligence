[CmdletBinding()]
param(
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
  [string]$Mailbox,

  [ValidatePattern('^https://[^/\s]+(/\S*)?$')]
  [string]$ApiBase = 'https://jobs-api.brandenfarmer.com/api/job-intelligence',

  [string]$StateDirectory,

  [ValidateRange(0, 30)]
  [int]$OverlapDays = 3,

  [switch]$DryRun,
  [switch]$SetupCredential,
  [switch]$FullBackfill,
  [switch]$SelfTest
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
$script:Deadline = [DateTime]::MaxValue
$script:SleepFn = { param([int]$Seconds) Start-Sleep -Seconds $Seconds }

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
function Get-Bytes([object]$Value) {
  return $script:Utf8.GetByteCount((ConvertTo-Json -InputObject $Value -Depth 10 -Compress))
}
function Split-Batches([object[]]$Messages, [int[]]$Sizes, [int]$MaxCount, [int]$MaxBytes) {
  $batches = [System.Collections.Generic.List[object]]::new()
  $current = [System.Collections.Generic.List[object]]::new()
  $bytes = 0
  for ($index = 0; $index -lt $Messages.Count; $index++) {
    $size = $Sizes[$index] + 1
    if ($current.Count -gt 0 -and ($current.Count -ge $MaxCount -or $bytes + $size -gt $MaxBytes)) { $batches.Add($current.ToArray()); $current = [System.Collections.Generic.List[object]]::new(); $bytes = 0 }
    $current.Add($Messages[$index]); $bytes += $size
  }
  if ($current.Count -gt 0) { $batches.Add($current.ToArray()) }
  return ,$batches.ToArray()
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
    return 'fatal'
  }
  if ($Status -eq 413) { return 'too_large' }
  if ($Status -eq 0 -or $Status -eq 429 -or $Status -ge 500) { return 'retry' }
  return 'fatal'
}
function Get-StatePath([string]$Name) { return Join-Path $script:StateRoot $Name }
function Get-ErrorCode([string]$Body) {
  try { $value = Get-Prop ($Body | ConvertFrom-Json) 'error'; if ($value -is [string] -and $value -match '^[a-z_]{1,64}$') { return $value } } catch { }
  return '-'
}
function Invoke-Api([string]$Method, [string]$Path, [byte[]]$Body) {
  $request = @{ Uri = "$script:Base$Path"; Method = $Method; Headers = $script:Headers; UseBasicParsing = $true; MaximumRedirection = 0; TimeoutSec = 60 }
  if ($null -ne $Body) { $request.Body = $Body; $request.ContentType = 'application/json' }
  try {
    $response = Invoke-WebRequest @request
    return @{ Status = [int]$response.StatusCode; Body = [string]$response.Content }
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
    return @{ Status = $status; Body = $text }
  }
}
function Invoke-ApiCall([string]$Method, [string]$Path, [byte[]]$Body, [string]$Label) {
  for ($attempt = 0; ; $attempt++) {
    $result = Invoke-Api $Method $Path $Body
    $class = Get-ResponseClass $result.Status $result.Body
    Write-Log "call=$Label status=$($result.Status) error=$(Get-ErrorCode $result.Body) attempt=$($attempt + 1)"
    switch ($class) {
      'ok' { return $result }
      'too_large' { return $result }
      'paused' { Stop-Run 3 'imports_paused_by_owner' }
      'access_rejected' { Stop-Run 4 'access_rejected' }
      'forbidden' { Stop-Run 5 'forbidden' }
      'fatal' { Stop-Run 5 'client_error' }
    }
    if ($attempt -ge $script:RetryDelays.Count -or [DateTime]::UtcNow.AddSeconds($script:RetryDelays[$attempt]) -gt $script:Deadline) {
      if ($class -eq 'busy') { Stop-Run 6 'busy_after_retries' }
      Stop-Run 8 'server_unavailable_after_retries'
    }
    & $script:SleepFn $script:RetryDelays[$attempt]
  }
}
function Send-Batch([object]$Header, [object[]]$Messages, [int]$Number) {
  $payload = $script:Utf8.GetBytes((ConvertTo-BundleJson $Header $Messages))
  $result = Invoke-ApiCall 'POST' '/local-outlook/import' $payload "import-batch-$Number"
  if ($result.Status -ne 413) { return }
  if ($Messages.Count -le 1) { Stop-Run 5 'single_message_too_large' }
  $half = [int][Math]::Ceiling($Messages.Count / 2)
  Send-Batch $Header @($Messages[0..($half - 1)]) $Number
  Send-Batch $Header @($Messages[$half..($Messages.Count - 1)]) $Number
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
        if ($status -in 'completed', 'failed', 'skipped_overlap') { return $status }
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
    $saved = [IO.File]::ReadAllText($path, $script:Utf8) | ConvertFrom-Json
    $last = Get-Prop $saved 'lastExportedAt'
    if ($last) { return @{ lastExportedAt = Format-Value $last } }
  } catch { Write-Log 'state=unreadable' }
  return @{}
}
function Save-State([hashtable]$Values) {
  $path = Get-StatePath 'state.json'
  $temporary = "$path.tmp"
  [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Values -Compress), $script:Utf8)
  Move-Item -LiteralPath $temporary -Destination $path -Force
}
function Initialize-State {
  $script:StateRoot = if ($StateDirectory) { $StateDirectory } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'JobSearchIntelligence' } else { Join-Path ([IO.Path]::GetTempPath()) 'JobSearchIntelligence' }
  foreach ($name in 'logs', 'work') { [IO.Directory]::CreateDirectory((Get-StatePath $name)) | Out-Null }
  $script:LogFile = Join-Path (Get-StatePath 'logs') ([DateTime]::UtcNow.ToString('yyyyMMdd') + '.log')
}
function Clear-Work { Get-ChildItem -LiteralPath (Get-StatePath 'work') -Force | Remove-Item -Recurse -Force }
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
  [pscredential]::new($id, $secret) | Export-Clixml -LiteralPath (Get-StatePath 'automation-credential.xml')
  Write-Host 'Credential saved for this Windows user on this PC. It is not logged or displayed.'
}
function Export-Mail([string]$Since, [string]$Destination) {
  $exporter = Join-Path $PSScriptRoot 'outlook-com-export.ps1'
  try { [void](& $exporter -Mailbox $Mailbox -Since $Since -OutputPath $Destination -Force) }
  catch { Write-Log "export=failed type=$($_.Exception.GetType().Name) message=$(([string]$_.Exception.Message).Substring(0, [Math]::Min(200, ([string]$_.Exception.Message).Length)))"; Stop-Run 1 'export_failed' }
  $bundle = [IO.File]::ReadAllText($Destination, $script:Utf8) | ConvertFrom-Json
  Remove-Item -LiteralPath $Destination -Force # mail content leaves the disk as soon as it is in memory
  $summary = Get-Prop $bundle 'summary'
  if ((Get-Prop $summary 'truncated') -ne $false) {
    Write-Log 'export=truncated action=run_a_narrower_manual_export_with_outlook-com-export.ps1_and_import_it_from_the_dashboard'
    Stop-Run 2 'export_truncated'
  }
  return $bundle
}
function Invoke-Run {
  Initialize-State
  $mutex = [Threading.Mutex]::new($false, 'Local\JobSearchIntelligenceOutlookUpload')
  $held = $false
  try {
    if (-not $mutex.WaitOne(0)) { Write-Log 'result=already_running exit=0'; return 0 }
    $held = $true
    Clear-Work; Remove-OldLogs
    $started = [DateTime]::UtcNow
    $script:Deadline = $started.AddMinutes($script:RunBudgetMinutes)
    $script:Base = $ApiBase.TrimEnd('/')
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $DryRun) { Read-Credential }
    $state = if ($FullBackfill) { @{} } else { Read-State }
    $since = Get-SinceWindow $state['lastExportedAt'] $OverlapDays $started
    Write-Log "start mailbox_configured=true since=$since dry_run=$([bool]$DryRun) full_backfill=$([bool]$FullBackfill)"
    $bundle = Export-Mail $since (Join-Path (Get-StatePath 'work') 'export.json')
    $messages = Merge-Messages @(@(Get-Prop $bundle 'messages') | Where-Object { $null -ne $_ } | ForEach-Object { ConvertTo-Message $_ })
    $header = [pscustomobject]@{ accountId = Get-Prop $bundle 'accountId'; exportedAt = Get-Prop $bundle 'exportedAt'; since = Get-Prop $bundle 'since' }
    $overhead = $script:Utf8.GetByteCount((ConvertTo-BundleJson $header @()))
    $sizes = [int[]]@($messages | ForEach-Object { Get-Bytes $_ })
    $batches = @()
    if ($messages.Count) { $batches = Split-Batches $messages $sizes $script:MaxBatchMessages ($script:MaxBatchBytes - $overhead) }
    Write-Log "export=ok messages=$($messages.Count) batches=$($batches.Count)"
    if ($DryRun) { Write-Log 'result=dry_run_ok exit=0'; return 0 }
    $number = 0
    foreach ($batch in $batches) { $number++; Send-Batch $header $batch $number }
    $values = @{ lastExportedAt = Format-Value (Get-Prop $header 'exportedAt'); lastMessages = $messages.Count; lastBatches = $batches.Count }
    Save-State $values
    $id = $null; $deadline = [DateTime]::UtcNow.AddMinutes($script:SyncWaitMinutes)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $id = Start-Sync
      $outcome = Wait-SyncRun $id $deadline
      Write-Log "sync=$outcome attempt=$attempt"
      if ($outcome -eq 'completed') { Write-Log 'result=completed exit=0'; return 0 }
      if ($outcome -eq 'failed') { Stop-Run 7 'sync_failed' }
      if ($outcome -eq 'pending') { Write-Log 'result=pending exit=0'; return 0 }
      & $script:SleepFn 60
    }
    Write-Log 'result=pending_overlap exit=0'
    return 0
  } catch [OperationCanceledException] {
    if ($script:ExitCode -eq 3) { try { Save-State @{} } catch { } }
    return $script:ExitCode
  } catch {
    Write-Log "result=unexpected type=$($_.Exception.GetType().Name) exit=1"
    return 1
  } finally {
    if ($held) { try { Clear-Work } catch { }; $mutex.ReleaseMutex() }
    $mutex.Dispose()
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

  $a = [ordered]@{ immutableId = 'a'; folder = 'inbox'; occurredAt = '2026-10-02T10:00:00.0000000Z' }
  $newer = [ordered]@{ immutableId = 'a'; folder = 'inbox'; occurredAt = '2026-10-03T10:00:00.0000000Z' }
  $sent = [ordered]@{ immutableId = 'a'; folder = 'sentitems'; occurredAt = '2026-10-01T10:00:00.0000000Z' }
  $merged = Merge-Messages @($a, $sent, $newer)
  Assert-Equal @($merged | ForEach-Object { "$($_.folder)@$($_.occurredAt)" }) @('sentitems@2026-10-01T10:00:00.0000000Z', 'inbox@2026-10-03T10:00:00.0000000Z') 'dedupe keeps the latest per id and folder'
  Assert-Equal (Merge-Messages @()).Count 0 'empty merge stays empty'

  $items = 1..85 | ForEach-Object { "m$_" }
  $split = Split-Batches $items ([int[]]@($items | ForEach-Object { 10 })) 40 150000
  Assert-Equal @($split | ForEach-Object { $_.Count }) @(40, 40, 5) 'batches split by count'
  $split = Split-Batches $items[0..4] ([int[]]@(60, 60, 60, 200, 10)) 40 150
  Assert-Equal @($split | ForEach-Object { $_.Count }) @(2, 1, 1, 1) 'batches split by bytes and an oversized item stands alone'
  $split = Split-Batches @() ([int[]]@()) 40 100
  Assert-Equal @($split).Count 0 'no messages, no batches'

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
  Write-Host 'Self-test passed.'
}

if ($SelfTest) {
  try { Invoke-SelfTest; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}
if ($SetupCredential) { Set-Credential; exit 0 }
if (-not $Mailbox) { [Console]::Error.WriteLine('Mailbox is required.'); exit 1 }
exit [int](Invoke-Run | Select-Object -Last 1)

[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:TestMutexName='Local\JSI-OutlookRun-'+[guid]::NewGuid().ToString('N')
$script:TestProtect={param([byte[]]$Bytes,[byte[]]$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))}
$script:TestUnprotect={param([byte[]]$Bytes,[byte[]]$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
$script:GenerationRequests=0
$script:NextGetIsGeneration=$true
$script:CurrentSyncId=''
$script:CollectorRequests=0
$script:ImportRequests=0
$script:SyncStarts=0
$script:Statuses=[Collections.Generic.Queue[string]]::new()
$script:ApiResponses=[Collections.Generic.Queue[object]]::new()
$global:RetrySleepCount=0
$script:GenerationHeader='generation-synthetic-v1'
$script:ImportResponseStatus=200
$script:ObservedGeneration=$null
$script:ObservedTemporaryHeader=$null
$script:QueueBoundBeforeDiscovery=$false
$script:StatePersistedBeforeImport=$false
$script:RuntimeContext=$null
$script:WebRequestBehavior=$null
$script:ForcedSyncOutcome=$null
$script:LastCollectorBudget=0
$script:CollectorFailure=$false
$script:CollectorOutputMode='protected'
$script:CollectorComplete=$true
$script:CollectorTruncated=$false
function Assert-Run([bool]$Value,[string]$Name){if(-not $Value){throw "Uploader lifecycle behavior failed: $Name"}}

$automation=Join-Path $PSScriptRoot 'outlook-automation.ps1'
$stateRoot=Join-Path ([IO.Path]::GetTempPath()) ('jsi-run-lifecycle-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stateRoot)|Out-Null
try {
  . $automation -Mailbox 'owner@example.invalid' -ApiBase 'https://jobs-api.example.invalid/api/job-intelligence' -StateDirectory $stateRoot -LibraryOnly
  $script:RealInvokeApi=(Get-Item Function:\Invoke-Api).ScriptBlock
  $script:RealReadCredential=(Get-Item Function:\Read-Credential).ScriptBlock
  $script:RealSetCredential=(Get-Item Function:\Set-Credential).ScriptBlock
  $script:RealWaitSyncRun=(Get-Item Function:\Wait-SyncRun).ScriptBlock
  $script:RuntimeContextFactory={
    param($Root,$Environment,$MailboxBinding,$ConfigVersion)
    $context=outlook-private-runtime\New-PrivateRuntimeContext -StateRoot $Root -Environment $Environment -MailboxBinding $MailboxBinding -ConfigVersion $ConfigVersion -ProtectBytes $script:TestProtect -UnprotectBytes $script:TestUnprotect
    $script:RuntimeContext=$context
    outlook-private-runtime\Set-PrivateRuntimeMutexFactory ({param($Name)[Threading.Mutex]::new($false,$script:TestMutexName)}.GetNewClosure())
    return $context
  }.GetNewClosure()
  function Read-Credential { $script:Headers=@{'synthetic-auth'='fixture'} }
  function Protect-PrivateDirectory { param([string]$Path) [IO.Directory]::CreateDirectory($Path)|Out-Null }
  function Read-Host {
    param([string]$Prompt,[switch]$AsSecureString)
    if($script:PromptValues.Count -eq 0){throw 'No synthetic prompt value configured.'}
    return $script:PromptValues.Dequeue()
  }
  function Invoke-WebRequest {
    param([string]$Uri,[string]$Method,[hashtable]$Headers,[switch]$UseBasicParsing,[int]$MaximumRedirection,[int]$TimeoutSec,[byte[]]$Body,[string]$ContentType)
    if($script:WebRequestBehavior -is [scriptblock]){return (& $script:WebRequestBehavior $PSBoundParameters)}
    return $script:WebRequestBehavior
  }
  function Wait-SyncRun {
    param([string]$Id,[DateTime]$Until)
    if($script:ForcedSyncOutcome){return $script:ForcedSyncOutcome}
    return (& $script:RealWaitSyncRun $Id $Until)
  }
  function Get-CollectorValidation { return [pscustomobject]@{storeBinding='store-synthetic-v1'} }
  function Invoke-OutlookCollector {
    param([hashtable]$Arguments)
    $script:CollectorRequests++
    $script:LastCollectorBudget=[int]$Arguments.BudgetSeconds
    if($script:CollectorFailure){throw 'synthetic collector failure'}
    $queue=Read-ProtectedJson -Path (Join-Path $stateRoot 'upload-queue.dpapi') -Context $script:RuntimeContext
    $script:QueueBoundBeforeDiscovery=($null -ne $queue -and $queue.generation -eq 'generation-synthetic-v1' -and $queue.phase -eq 'discovering')
    $script:TestBundle=[ordered]@{
      schemaVersion=1;format='job-search-intelligence.outlook-com.v1';accountId='account-synthetic';exportedAt='2026-10-11T12:00:00.0000000Z';since='2026-09-30T07:00:00.0000000Z'
      summary=[ordered]@{truncated=$script:CollectorTruncated}
      messages=@([ordered]@{immutableId='synthetic-message-1';folder='inbox';subject='Synthetic role';sender='recruiter@example.invalid';excerpt='Synthetic content';occurredAt='2026-10-10T09:00:00.0000000Z';conversationId='conv-1';internetMessageId='msg-1';revision='r1'})
      collection=[ordered]@{schemaVersion=1;storeBinding='store-synthetic-v1';complete=$script:CollectorComplete;reviewCount=2;nextState=[ordered]@{schemaVersion=1;cursor='cursor-next';lastExportedAt='2026-10-11T12:00:00.0000000Z'}}
    }
    if($script:CollectorOutputMode -eq 'plaintext'){[IO.File]::WriteAllText($Arguments.OutputPath,'{"schemaVersion":1}')}else{Save-ProtectedJsonAtomic -Path $Arguments.OutputPath -Value $script:TestBundle -Context $Arguments.RuntimeContext}
  }
  function Invoke-Api {
    param([string]$Method,[string]$Path,[byte[]]$Body)
    if($Path -eq '/synthetic-response' -and $script:ApiResponses.Count -gt 0){$response=$script:ApiResponses.Dequeue();$script:ObservedTemporaryHeader=[string]$script:Headers['X-Synthetic-Test'];return $response}
    if($Method -eq 'GET' -and $Path -eq '/sync-runs'){
      if($script:NextGetIsGeneration){$script:NextGetIsGeneration=$false;$script:GenerationRequests++;$headers=@{};if($script:GenerationHeader){$headers['X-Job-Data-Generation']=$script:GenerationHeader};return @{Status=200;Body='[]';Headers=$headers}}
      if($script:Statuses.Count -gt 0){$status=$script:Statuses.Dequeue();return @{Status=200;Body=(ConvertTo-Json -InputObject @(@{id=$script:CurrentSyncId;status=$status}) -Compress);Headers=@{'X-Job-Data-Generation'='generation-synthetic-v1'}}}
      throw 'Unexpected sync status request.'
    }
    if($Method -eq 'POST' -and $Path -eq '/local-outlook/import'){
      $script:ImportRequests++
      $script:ObservedGeneration=[string]$script:Headers['X-Job-Data-Generation']
      $queue=Read-ProtectedJson -Path (Join-Path $stateRoot 'upload-queue.dpapi') -Context $script:RuntimeContext
      $collectionState=Read-ProtectedJson -Path (Join-Path $stateRoot 'collection-state.dpapi') -Context $script:RuntimeContext
      $script:StatePersistedBeforeImport=($queue.phase -eq 'uploading' -and $collectionState.cursor -eq 'cursor-next')
      return @{Status=$script:ImportResponseStatus;Body='{}';Headers=@{}}
    }
    if($Method -eq 'POST' -and $Path -eq '/sync/run'){$script:SyncStarts++;$script:CurrentSyncId="run-$script:SyncStarts";return @{Status=202;Body=(ConvertTo-Json -InputObject @{id=$script:CurrentSyncId} -Compress);Headers=@{}}}
    throw "Unexpected synthetic API call $Method $Path"
  }
  $script:SleepFn={param([int]$Seconds)$global:RetrySleepCount++}
  Invoke-SelfTest
  Assert-Run ((Get-DateHealthLabel ([DateTime]::UtcNow.AddHours(1).ToString('o')) ([DateTime]::UtcNow) 7) -eq 'future') 'future checkpoint health is reported without exposing message content'
  $ackNode=[pscustomobject]@{acknowledged=$true;children=@();messages=@(@{id='synthetic'})}
  $emptyNode=[pscustomobject]@{acknowledged=$false;children=@();messages=@()}
  $pendingNode=[pscustomobject]@{acknowledged=$false;children=@();messages=@(@{id='synthetic'})}
  $childTree=[pscustomobject]@{acknowledged=$false;children=@($ackNode,$pendingNode);messages=@()}
  Assert-Run (-not (Test-QueueNodePending $ackNode) -and -not (Test-QueueNodePending $emptyNode) -and (Test-QueueNodePending $pendingNode) -and (Test-QueueNodePending $childTree)) 'queue acknowledgement traversal handles complete, empty, pending, and split children'
  $script:Statuses.Enqueue('continued')
  $first=Invoke-Run
  Assert-Run ($first -eq 0) 'initial upload returns accepted while sync continues'
  Assert-Run $script:QueueBoundBeforeDiscovery 'generation is durably bound before collector discovery'
  Assert-Run ($script:ImportRequests -eq 1 -and $script:ObservedGeneration -eq 'generation-synthetic-v1') 'automated import carries the bound generation header'
  Assert-Run $script:StatePersistedBeforeImport 'collection checkpoint is persisted after queue commit and before import'
  Assert-Run ($script:LastCollectorBudget -le 1200 -and $script:LastCollectorBudget -gt 0) 'collector budget is capped with time reserved for upload and sync'
  $queuePath=Join-Path $stateRoot 'upload-queue.dpapi'
  $pending=Read-ProtectedJson -Path $queuePath -Context $script:RuntimeContext
  Assert-Run ($pending.phase -eq 'processing_pending' -and $pending.syncRunId -eq 'run-1') 'continued sync state is durably resumable'

  # Invoke the actual HTTP adapter against a synthetic web-request seam. No
  # network connection is opened by this test.
  $script:WebRequestBehavior={param($request) $script:CapturedWebRequest=$request;return @{StatusCode=201;Content='{}';Headers=@{'x-fixture'='ok'}}}
  $wireResponse=& $script:RealInvokeApi -Method POST -Path '/wire-test' -Body ([byte[]](1,2,3))
  Assert-Run ($wireResponse.Status -eq 201 -and $wireResponse.Body -eq '{}' -and $script:CapturedWebRequest.Uri -eq 'https://jobs-api.example.invalid/api/job-intelligence/wire-test') 'real HTTP adapter returns synthetic success and joins API URL'
  Assert-Run ($script:CapturedWebRequest.ContentType -eq 'application/json' -and $script:CapturedWebRequest.Body.Length -eq 3 -and $script:CapturedWebRequest.MaximumRedirection -eq 0) 'real HTTP adapter encodes JSON request and disables redirects'
  $script:WebRequestBehavior={throw [InvalidOperationException]::new('synthetic redirect refused')}
  $redirectResponse=& $script:RealInvokeApi -Method GET -Path '/wire-test' -Body $null
  Assert-Run ($redirectResponse.Status -eq 302) 'real HTTP adapter maps redirect errors to access rejection'
  $script:WebRequestBehavior={param($request) $script:CapturedWebRequest=$request;return @{StatusCode=201;Content='{}';Headers=@{'x-fixture'='ok'}}}
  $savedDeadline=$script:Deadline;$script:Deadline=[DateTime]::UtcNow.AddSeconds(7)
  $nearDeadlineResponse=& $script:RealInvokeApi -Method GET -Path '/wire-test' -Body $null
  Assert-Run ($nearDeadlineResponse.Status -eq 201 -and $script:CapturedWebRequest.TimeoutSec -le 7 -and $script:CapturedWebRequest.TimeoutSec -ge 1) 'HTTP timeout is capped to the remaining run budget'
  $script:Deadline=$savedDeadline

  # Load only synthetic CLIXML credentials and confirm secrets stay out of
  # logs and plaintext on disk.
  $script:StateRoot=$stateRoot
  $credentialSecret='synthetic-secret-never-log'
  $script:PromptValues=[Collections.Generic.Queue[Security.SecureString]]::new()
  $script:PromptValues.Enqueue((ConvertTo-SecureString 'synthetic-client-id' -AsPlainText -Force))
  $script:PromptValues.Enqueue((ConvertTo-SecureString $credentialSecret -AsPlainText -Force))
  $credentialPath=Join-Path $stateRoot 'automation-credential.xml'
  & $script:RealSetCredential
  & $script:RealReadCredential
  Assert-Run ($script:Headers['CF-Access-Client-Id'] -eq 'synthetic-client-id' -and $script:Headers['CF-Access-Client-Secret'] -eq $credentialSecret) 'real credential loader populates Access headers from protected CLIXML'
  Assert-Run (-not (Get-Content -LiteralPath $credentialPath -Raw).Contains($credentialSecret)) 'credential secret is protected at rest'
  $logText=if($script:LogFile -and (Test-Path -LiteralPath $script:LogFile)){Get-Content -LiteralPath $script:LogFile -Raw}else{''}
  Assert-Run (-not $logText.Contains($credentialSecret)) 'credential secret is absent from uploader logs'
  Remove-Item -LiteralPath $credentialPath -Force
  $script:PromptValues.Enqueue((ConvertTo-SecureString '   ' -AsPlainText -Force))
  $script:PromptValues.Enqueue((ConvertTo-SecureString 'synthetic-secret' -AsPlainText -Force))
  $invalidCredentialRejected=$false;try{& $script:RealSetCredential}catch{$invalidCredentialRejected=$true}
  Assert-Run ($invalidCredentialRejected -and -not (Test-Path -LiteralPath $credentialPath)) 'credential setup rejects an empty client ID without writing a file'
  $missingCredentialRejected=$false;try{& $script:RealReadCredential}catch{$missingCredentialRejected=$true}
  Assert-Run ($missingCredentialRejected -and $script:ExitCode -eq 1) 'missing Access credential stops with setup guidance'
  $script:Headers=@{'synthetic-auth'='fixture'};$script:ExitCode=1

  # A continuation after restart must launch a new finite sync probe. It may
  # not keep polling the same continued ID indefinitely.
  $script:NextGetIsGeneration=$true
  $script:Statuses.Enqueue('continued');$script:Statuses.Enqueue('completed')
  $second=Invoke-Run
  Assert-Run ($second -eq 0) 'recovery after continued sync completes'
  Assert-Run ($script:SyncStarts -eq 2) 'continued recovery starts a new sync probe'
  Assert-Run (-not (Test-Path -LiteralPath $queuePath)) 'completed recovery removes the durable queue'
  $state=Read-ProtectedJson -Path (Join-Path $stateRoot 'state.json') -Context $script:RuntimeContext
  Assert-Run ($state.lastExportedAt -eq $script:TestBundle.exportedAt) 'successful complete collection advances exported checkpoint'
  Assert-Run ($state.lastSweepAt -eq $script:TestBundle.exportedAt) 'complete floor reconciliation advances sweep checkpoint'
  Assert-Run ($state.reviewCount -eq 2) 'bounded review count is retained in content-free sync state'

  $exportPath=Join-Path (Join-Path $stateRoot 'work') 'export.json'
  $script:CollectorTruncated=$true;$script:ExitCode=1;$truncatedRejected=$false
  try{Export-Mail $script:Floor.ToString('o') $exportPath|Out-Null}catch{$truncatedRejected=$true}
  Assert-Run ($truncatedRejected -and $script:ExitCode -eq 2 -and -not (Test-Path -LiteralPath $exportPath)) 'truncated local export is rejected and protected temporary output is removed'
  $script:CollectorTruncated=$false;$script:ExitCode=1;$script:CollectorFailure=$true;$collectorRejected=$false
  try{Export-Mail $script:Floor.ToString('o') $exportPath|Out-Null}catch{$collectorRejected=$true}
  Assert-Run ($collectorRejected -and $script:ExitCode -eq 1) 'collector exceptions map to export failure without interpreting output'
  $script:CollectorFailure=$false;$script:CollectorOutputMode='plaintext';$plaintextRejected=$false
  try{Export-Mail $script:Floor.ToString('o') $exportPath|Out-Null}catch{$plaintextRejected=$true}
  Assert-Run ($plaintextRejected -and -not (Test-Path -LiteralPath $exportPath)) 'unprotected collector output is rejected and deleted without plaintext fallback'
  $script:CollectorOutputMode='protected';$script:ExitCode=1

  # Pending syncs retain their queue; failed and overlap-skipped syncs clear
  # the old ID and return the durable queue to its retry phase.
  $script:Queue=[ordered]@{schemaVersion=1;generation='generation-synthetic-v1';phase='processing_pending';syncRunId='run-pending';collection=[ordered]@{complete=$true};header=@{since='2026-09-30T07:00:00Z';exportedAt='2026-10-11T12:00:00.0000000Z'};batches=@();storeBinding='store-synthetic-v1'}
  Save-Queue
  $script:ForcedSyncOutcome='pending';$pendingOutcome=Resolve-PendingSync $state
  Assert-Run ($pendingOutcome -eq 'pending' -and $script:Queue.phase -eq 'processing_pending') 'pending sync keeps the resumable queue phase'
  foreach($syncOutcome in 'failed','skipped_overlap'){
    $script:Queue.phase='processing_pending';$script:Queue.syncRunId='run-retry';Save-Queue
    $script:ForcedSyncOutcome=$syncOutcome;$retryOutcome=Resolve-PendingSync $state
    Assert-Run ($retryOutcome -eq 'retry' -and $script:Queue.phase -eq 'sync' -and -not $script:Queue.syncRunId) "$syncOutcome clears the old sync ID for a new probe"
  }
  $script:ForcedSyncOutcome=$null
  Remove-Item -LiteralPath $queuePath -Force
  $script:Queue=$null

  # Legacy plaintext checkpoints migrate once with a preserved rollback copy;
  # malformed state falls back to full reconciliation after quarantine.
  $statePath=Join-Path $stateRoot 'state.json'
  [IO.File]::WriteAllText($statePath,'{"lastExportedAt":"2026-10-10T00:00:00.0000000Z","lastMessages":4,"lastBatches":1}')
  $migratedState=Read-State
  Assert-Run ($migratedState.lastExportedAt -eq '2026-10-10T00:00:00.0000000Z' -and $migratedState.schemaVersion -eq 2) 'legacy plaintext checkpoint migrates to protected schema v2'
  Assert-Run (Test-Path -LiteralPath ($statePath+'.legacy-backup')) 'legacy migration retains a rollback copy'
  [IO.File]::WriteAllText($statePath,'{malformed')
  $invalidState=Read-State
  Assert-Run (-not $invalidState.lastExportedAt -and @(Get-ChildItem -LiteralPath $stateRoot -Filter 'state.json.*.quarantine').Count -eq 1) 'malformed state is quarantined and forces full reconciliation'
  Save-State $state

  # The HTTP adapter must retry transient responses, restore temporary headers,
  # and keep public exit codes stable for paused/busy/server failures.
  $baselineHeaders=@{}+$script:Headers;$script:ApiResponses.Enqueue(@{Status=429;Body=''});$script:ApiResponses.Enqueue(@{Status=200;Body='{}'})
  $retryResponse=Invoke-ApiCall 'GET' '/synthetic-response' $null 'retry-fixture' @{'X-Synthetic-Test'='temporary'}
  Assert-Run ($retryResponse.Status -eq 200 -and $global:RetrySleepCount -eq 1) 'transient 429 response retries once before success'
  Assert-Run ($script:ObservedTemporaryHeader -eq 'temporary' -and -not $script:Headers.ContainsKey('X-Synthetic-Test')) 'extra request headers are scoped to the request'
  Assert-Run ($script:Headers['synthetic-auth'] -eq $baselineHeaders['synthetic-auth']) 'original credential headers are restored after request'

  $script:ExitCode=1;$script:ApiResponses.Enqueue(@{Status=403;Body='{"error":"automation_route_forbidden"}'});$forbiddenRejected=$false
  try{Invoke-ApiCall 'GET' '/synthetic-response' $null 'forbidden-fixture'|Out-Null}catch{$forbiddenRejected=$true}
  Assert-Run ($forbiddenRejected -and $script:ExitCode -eq 5) 'explicit backend authorization denial maps to owner-review exit code'

  # A backend generation conflict archives the queue and resets local
  # reconciliation state before returning the owner-review exit code.
  $conflictingQueue=[ordered]@{schemaVersion=1;generation='generation-old';phase='uploading';createdAt=[DateTime]::UtcNow.ToString('o');untilUtc=[DateTime]::UtcNow.ToString('o');header=$null;batches=@();collection=$null;syncRequired=$false;syncRunId=''}
  Save-ProtectedJsonAtomic -Path $queuePath -Value $conflictingQueue -Context $script:RuntimeContext
  $script:ExitCode=1;$script:ApiResponses.Enqueue(@{Status=409;Body='{"error":"data_generation_mismatch"}'});$generationRejected=$false
  try{Invoke-ApiCall 'POST' '/synthetic-response' $null 'generation-conflict'|Out-Null}catch{$generationRejected=$true}
  Assert-Run ($generationRejected -and $script:ExitCode -eq 5 -and -not (Test-Path -LiteralPath $queuePath)) 'generation conflict archives stale upload queue and stops for review'
  Assert-Run (@(Get-ChildItem -LiteralPath $stateRoot -Filter 'upload-queue.dpapi.stale-*').Count -eq 1) 'generation conflict retains stale queue for owner inspection'
  $postConflictState=Read-ProtectedJson -Path (Join-Path $stateRoot 'state.json') -Context $script:RuntimeContext
  Assert-Run (-not $postConflictState.lastExportedAt -and -not $postConflictState.lastSweepAt) 'generation conflict resets reconciliation checkpoints'
  $script:Queue=$null;$script:ExitCode=1

  # The supported dry-run path still validates and collects into protected
  # local output, but must not bind a generation, import, or launch a sync.
  $DryRun=$true
  $dryGenerationBefore=$script:GenerationRequests;$dryImportBefore=$script:ImportRequests;$drySyncBefore=$script:SyncStarts
  $dryCollectorBefore=$script:CollectorRequests
  $dryCode=Invoke-Run
  $DryRun=$false
  Assert-Run ($dryCode -eq 0 -and $script:CollectorRequests -eq ($dryCollectorBefore+1)) 'dry run performs synthetic local collection'
  Assert-Run ($script:GenerationRequests -eq $dryGenerationBefore -and $script:ImportRequests -eq $dryImportBefore -and $script:SyncStarts -eq $drySyncBefore) 'dry run makes no generation, import, or sync API calls'

  $script:ExitCode=1;$script:ApiResponses.Enqueue(@{Status=409;Body='{"error":"reconnect_sources_to_resume"}'});$pausedRejected=$false
  try{Invoke-ApiCall 'GET' '/synthetic-response' $null 'paused-fixture'|Out-Null}catch{$pausedRejected=$true}
  Assert-Run ($pausedRejected -and $script:ExitCode -eq 3) 'owner-paused imports stop with documented code'

  $script:ExitCode=1;for($i=0;$i -lt 5;$i++){$script:ApiResponses.Enqueue(@{Status=409;Body='{"error":"sync_running"}'})};$busyRejected=$false
  try{Invoke-ApiCall 'GET' '/synthetic-response' $null 'busy-fixture'|Out-Null}catch{$busyRejected=$true}
  Assert-Run ($busyRejected -and $script:ExitCode -eq 6) 'exhausted sync-busy retries stop with documented code'

  $script:ExitCode=1;for($i=0;$i -lt 5;$i++){$script:ApiResponses.Enqueue(@{Status=503;Body=''} )};$serverRejected=$false
  try{Invoke-ApiCall 'GET' '/synthetic-response' $null 'server-fixture'|Out-Null}catch{$serverRejected=$true}
  Assert-Run ($serverRejected -and $script:ExitCode -eq 8) 'exhausted server retries stop with documented code'

  # Missing generation headers stop before queue creation or mailbox discovery.
  $script:NextGetIsGeneration=$true;$script:GenerationHeader=''
  $collectorsBefore=$script:CollectorRequests
  $missingGeneration=Invoke-Run
  Assert-Run ($missingGeneration -eq 5) 'missing generation header is rejected with owner-review exit code'
  Assert-Run ($script:CollectorRequests -eq $collectorsBefore) 'generation failure occurs before collector discovery'
  Assert-Run (-not (Test-Path -LiteralPath $queuePath)) 'generation failure creates no queue'

  # A persisted queue from a different backend generation is quarantined and
  # forces reconciliation reset before collector validation.
  $script:GenerationHeader='generation-synthetic-v1';$script:NextGetIsGeneration=$true
  $staleQueue=[ordered]@{schemaVersion=1;generation='generation-old';phase='uploading';createdAt=[DateTime]::UtcNow.ToString('o');untilUtc=[DateTime]::UtcNow.ToString('o');header=$null;batches=@();collection=$null;syncRequired=$false;syncRunId=''}
  Save-ProtectedJsonAtomic -Path $queuePath -Value $staleQueue -Context $script:RuntimeContext
  $staleCode=Invoke-Run
  Assert-Run ($staleCode -eq 5) 'stale generation queue fails closed for owner review'
  Assert-Run (@(Get-ChildItem -LiteralPath $stateRoot -Filter 'upload-queue.dpapi.stale-*').Count -eq 2) 'stale generation queue is retained for review'
  $resetState=Read-ProtectedJson -Path (Join-Path $stateRoot 'state.json') -Context $script:RuntimeContext
  Assert-Run (-not $resetState.lastExportedAt -and -not $resetState.lastSweepAt) 'stale generation resets reconciliation checkpoints'

  # A store-bound queue cannot be continued against another live store.
  $script:NextGetIsGeneration=$true
  $storeQueue=[ordered]@{schemaVersion=1;generation='generation-synthetic-v1';phase='discovering';createdAt=[DateTime]::UtcNow.ToString('o');untilUtc=[DateTime]::UtcNow.ToString('o');header=$null;batches=@();collection=$null;syncRequired=$false;syncRunId='';storeBinding='different-store'}
  Save-ProtectedJsonAtomic -Path $queuePath -Value $storeQueue -Context $script:RuntimeContext
  $storeCode=Invoke-Run
  Assert-Run ($storeCode -eq 5) 'store-bound queue mismatch requires owner review'
  Assert-Run (@(Get-ChildItem -LiteralPath $stateRoot -Filter 'upload-queue.dpapi.store-stale-*').Count -eq 1) 'store-mismatched queue is retained for review'
  Assert-Run ($script:CollectorRequests -eq $collectorsBefore) 'store mismatch stops before discovery'

  # Authentication failure leaves the accepted-to-queue batch unacknowledged
  # for a safe retry and never starts a sync run.
  $script:NextGetIsGeneration=$true;$script:ImportResponseStatus=401
  $syncStartsBefore=$script:SyncStarts
  $authCode=Invoke-Run
  Assert-Run ($authCode -eq 4) 'Access authentication failure maps to the documented exit code'
  $authQueue=Read-ProtectedJson -Path $queuePath -Context $script:RuntimeContext
  Assert-Run ($authQueue.phase -eq 'uploading' -and -not $authQueue.batches[0].acknowledged) 'failed import retains an unacknowledged durable batch'
  Assert-Run ($script:SyncStarts -eq $syncStartsBefore) 'failed import does not start sync'

  # An incomplete bounded collection may upload, but must never advance either
  # successful-export or floor-sweep checkpoints.
  Remove-Item -LiteralPath $queuePath -Force
  $stateBeforeIncomplete=Read-ProtectedJson -Path (Join-Path $stateRoot 'state.json') -Context $script:RuntimeContext
  $script:ImportResponseStatus=200;$script:CollectorComplete=$false;$script:NextGetIsGeneration=$true
  $script:Statuses.Enqueue('completed')
  $incompleteCode=Invoke-Run
  $stateAfterIncomplete=Read-ProtectedJson -Path (Join-Path $stateRoot 'state.json') -Context $script:RuntimeContext
  Assert-Run ($incompleteCode -eq 0 -and $stateAfterIncomplete.lastExportedAt -eq $stateBeforeIncomplete.lastExportedAt -and $stateAfterIncomplete.lastSweepAt -eq $stateBeforeIncomplete.lastSweepAt) 'incomplete collection does not advance durable reconciliation checkpoints'
  $script:CollectorComplete=$true

  # An exhausted wall-clock budget stops before housekeeping, backend calls,
  # or collector discovery, preserving both queue and export work marker.
  $workArtifact=Join-Path (Join-Path $stateRoot 'work') 'export.json'
  [IO.File]::WriteAllText($workArtifact,'synthetic retained work marker')
  $queueForBudget=[ordered]@{schemaVersion=1;generation='generation-synthetic-v1';phase='uploading';createdAt=[DateTime]::UtcNow.ToString('o');untilUtc=[DateTime]::UtcNow.ToString('o');header=$null;batches=@();collection=$null;syncRequired=$false;syncRunId=''}
  Save-ProtectedJsonAtomic -Path $queuePath -Value $queueForBudget -Context $script:RuntimeContext
  $apiBeforeBudget=$script:GenerationRequests;$collectorBeforeBudget=$script:CollectorRequests
  $script:RunBudgetMinutes=0
  $expiredRun=Invoke-Run
  $script:RunBudgetMinutes=25
  Assert-Run ($expiredRun -eq 8) 'expired wall-clock budget returns the documented retryable exit code'
  Assert-Run ($script:GenerationRequests -eq $apiBeforeBudget -and $script:CollectorRequests -eq $collectorBeforeBudget) 'expired run budget makes no API or collector requests'
  Assert-Run ((Test-Path -LiteralPath $queuePath) -and (Test-Path -LiteralPath $workArtifact)) 'expired run preserves durable queue and work marker'
  Write-Output 'Synthetic Outlook Invoke-Run lifecycle tests passed.'
} finally {
  if(Test-Path -LiteralPath $stateRoot){Remove-Item -LiteralPath $stateRoot -Recurse -Force}
}

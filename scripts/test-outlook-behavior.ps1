[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$scriptPath=Join-Path $PSScriptRoot 'outlook-automation.ps1'
. $scriptPath -Mailbox 'owner@example.invalid' -ApiBase 'https://jobs-api.example.invalid/api/job-intelligence' -LibraryOnly -QueueMaxBytes 1048576
$global:QueueMaxBytes=1048576
$global:SaveCount=0
$global:ApiCalls=[Collections.Generic.List[object]]::new()
$global:ApiBehavior=$null
$global:FailCall=$null
function Save-Queue { $global:SaveCount++; $global:LastQueueSnapshot=ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $script:Queue -Depth 20 -Compress) }
function Invoke-ApiCall([string]$Method,[string]$Path,[byte[]]$Body,[string]$Label,[hashtable]$ExtraHeaders=@{}) {
  $global:ApiCalls.Add([pscustomobject]@{Method=$Method;Path=$Path;Body=[Text.Encoding]::UTF8.GetString($Body);Label=$Label;Headers=$ExtraHeaders})
  return & $global:ApiBehavior $Method $Path $Body $Label $ExtraHeaders
}
function Save-State($Values) { $global:SavedState=$Values }
function Write-Log([string]$Message) { $global:BehaviorLogs.Add($Message) }
function Start-Sync { $global:SyncStartCount++; return "run-$($global:SyncStartCount)" }
function Wait-SyncRun([string]$RunId,[DateTime]$Until) {
  $global:SyncWaitCount++
  if($global:SyncOutcomes.Count -eq 0){throw 'Unexpected sync poll.'}
  $value=$global:SyncOutcomes[0];$global:SyncOutcomes.RemoveAt(0);return $value
}

function Assert-True([bool]$Condition,[string]$Name){if(-not $Condition){throw "Behavior assertion failed: $Name"}}
function Assert-Equal([object]$Actual,[object]$Expected,[string]$Name){if((ConvertTo-Json -InputObject $Actual -Compress -Depth 12) -ne (ConvertTo-Json -InputObject $Expected -Compress -Depth 12)){throw "Behavior assertion failed: $Name"}}

$root=Join-Path ([IO.Path]::GetTempPath()) ('jsi-outlook-behavior-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$protect={param([byte[]]$bytes,[byte[]]$entropy)
  $sha=[Security.Cryptography.SHA256]::Create();try{$key=$sha.ComputeHash($entropy)}finally{$sha.Dispose()}
  $cipher=[byte[]]::new($bytes.Length);for($i=0;$i -lt $bytes.Length;$i++){$cipher[$i]=$bytes[$i] -bxor $key[$i % $key.Length]}
  $hmac=[Security.Cryptography.HMACSHA256]::new($key);try{$tag=$hmac.ComputeHash($cipher)}finally{$hmac.Dispose()}
  return ,([byte[]](@($tag)+@($cipher)))
}
$unprotect={param([byte[]]$protected,[byte[]]$entropy)
  if($protected.Length -lt 32){throw 'invalid synthetic protected bytes'}
  $sha=[Security.Cryptography.SHA256]::Create();try{$key=$sha.ComputeHash($entropy)}finally{$sha.Dispose()}
  $tag=$protected[0..31];$cipher=if($protected.Length -eq 32){[byte[]]@()}else{$protected[32..($protected.Length-1)]}
  $hmac=[Security.Cryptography.HMACSHA256]::new($key);try{$expected=$hmac.ComputeHash($cipher)}finally{$hmac.Dispose()}
  if(-not [Linq.Enumerable]::SequenceEqual([byte[]]$tag,[byte[]]$expected)){throw 'synthetic context binding mismatch'}
  $plain=[byte[]]::new($cipher.Length);for($i=0;$i -lt $cipher.Length;$i++){$plain[$i]=$cipher[$i] -bxor $key[$i % $key.Length]}
  return ,$plain
}
Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
$script:BehaviorMutexName='Local\JSI-OutlookBehavior-'+[guid]::NewGuid().ToString('N')
Set-PrivateRuntimeMutexFactory ({param($Name)[Threading.Mutex]::new($false,$script:BehaviorMutexName)}.GetNewClosure())
$context=New-PrivateRuntimeContext -StateRoot $root -Environment synthetic -MailboxBinding ('a'*64) -ConfigVersion harness-v1 -ProtectBytes $protect -UnprotectBytes $unprotect

try {
  $statePath=Join-Path $root 'queue.json'
  $saved=[ordered]@{schemaVersion=1;generation='g-1';value='synthetic'}
  Save-ProtectedJsonAtomic -Path $statePath -Value $saved -Context $context
  Assert-Equal (Read-ProtectedJson -Path $statePath -Context $context) ([pscustomobject]$saved) 'protected state round-trips'
  $isoSubject='2026-10-11T07:15:30.1234567-07:00'
  Save-ProtectedJsonAtomic -Path $statePath -Value ([ordered]@{schemaVersion=1;subject=$isoSubject;receivedAt='2026-10-11T14:15:30.1234567Z'}) -Context $context
  $isoRead=Read-ProtectedJson -Path $statePath -Context $context
  Assert-Equal ([string]$isoRead.subject) $isoSubject 'ISO-looking subject strings retain exact value and offset'
  Assert-Equal ([string]$isoRead.receivedAt) '2026-10-11T14:15:30.1234567Z' 'protected ISO date strings remain strings'
  $escapeFixture=[ordered]@{'2026-10-11T07:15:30.1234567-07:00'='key stays exact';subject='quoted "title" and slash \';body="line one`nline two";unicode='café ☕'}
  $escapeJson=ConvertTo-Json -InputObject $escapeFixture -Compress
  $runtimeModule=Get-Module outlook-private-runtime
  $escapeRead=$runtimeModule.Invoke({param($json) ConvertFrom-JsonPreservingStrings $json},$escapeJson)
  Assert-Equal ([string]$escapeRead.subject) 'quoted "title" and slash \' 'fallback JSON parser decodes escaped quotes and backslashes exactly'
  Assert-Equal ([string]$escapeRead.body) "line one`nline two" 'fallback JSON parser retains escaped newlines'
  Assert-Equal ([string]$escapeRead.unicode) 'café ☕' 'fallback JSON parser retains unicode text'
  Assert-Equal ([string]$escapeRead.PSObject.Properties['2026-10-11T07:15:30.1234567-07:00'].Value) 'key stays exact' 'fallback JSON parser preserves ISO-looking property names'
  $dpapiContext=New-PrivateRuntimeContext -StateRoot $root -Environment synthetic -MailboxBinding ('c'*64) -ConfigVersion real-dpapi-v1
  $dpapiPath=Join-Path $root 'dpapi.json'
  $bytePath=Join-Path $root 'dpapi.bytes';$secretBytes=[Text.Encoding]::UTF8.GetBytes('private-test-bytes')
  if($env:OS -eq 'Windows_NT'){
    Save-ProtectedJsonAtomic -Path $dpapiPath -Value $saved -Context $dpapiContext
    Assert-Equal (Read-ProtectedJson -Path $dpapiPath -Context $dpapiContext) ([pscustomobject]$saved) 'Windows DPAPI CurrentUser round-trips'
    Assert-True (-not ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($dpapiPath))).Contains('synthetic')) 'DPAPI file does not contain plaintext JSON'
    Save-ProtectedBytesAtomic -Path $bytePath -Bytes $secretBytes -Context $dpapiContext
    Assert-Equal ([Text.Encoding]::UTF8.GetString((Read-ProtectedBytes -Path $bytePath -Context $dpapiContext))) 'private-test-bytes' 'DPAPI protected binary payload round-trips'
  }else{
    $jsonProtectRejected=$false;try{Save-ProtectedJsonAtomic -Path $dpapiPath -Value $saved -Context $dpapiContext}catch{$jsonProtectRejected=$true}
    Assert-True ($jsonProtectRejected -and -not [IO.File]::Exists($dpapiPath)) 'default JSON protector fails closed off Windows without writing plaintext'
    $bytesProtectRejected=$false;try{Save-ProtectedBytesAtomic -Path $bytePath -Bytes $secretBytes -Context $dpapiContext}catch{$bytesProtectRejected=$true}
    Assert-True ($bytesProtectRejected -and -not [IO.File]::Exists($bytePath)) 'default binary protector fails closed off Windows without writing plaintext'
    $runtimeModule=Get-Module outlook-private-runtime
    $unprotectRejected=$false;try{$runtimeModule.Invoke({param($bytes,$ctx) Unprotect-PrivateBytes $bytes $ctx},([byte[]](1,2,3)),$dpapiContext)|Out-Null}catch{$unprotectRejected=$true}
    Assert-True $unprotectRejected 'default DPAPI unprotector fails closed off Windows'
  }
  $wrong=New-PrivateRuntimeContext -StateRoot $root -Environment synthetic -MailboxBinding ('b'*64) -ConfigVersion harness-v1 -ProtectBytes $protect -UnprotectBytes $unprotect
  $rejected=$false;try{Read-ProtectedJson -Path $statePath -Context $wrong -QuarantineInvalid|Out-Null}catch{$rejected=$true}
  Assert-True $rejected 'wrong mailbox binding is rejected'
  Assert-True (@(Get-ChildItem -LiteralPath $root -Filter 'queue.json.*.quarantine').Count -eq 1) 'invalid queue is quarantined'
  $outside=Join-Path (Join-Path $root '..') 'outside.json';$pathRejected=$false;try{Save-ProtectedJsonAtomic -Path $outside -Value $saved -Context $context}catch{$pathRejected=$true}
  Assert-True $pathRejected 'state writes cannot escape state root'
  $repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$StateDirectory=$repoRoot;$repoRejected=$false
  try{Initialize-State}catch{$repoRejected=$true}
  Assert-True $repoRejected 'uploader rejects private state rooted inside the repository'
  $ceilingRoot=Join-Path $root 'ceiling-fixture';[IO.Directory]::CreateDirectory($ceilingRoot)|Out-Null;$script:StateRoot=$ceilingRoot;$script:QueuePath=Join-Path $ceilingRoot 'upload-queue.dpapi'
  $work=Join-Path $ceilingRoot 'work';$backupRoot=Join-Path $ceilingRoot 'mailbox-cleanup';[IO.Directory]::CreateDirectory($work)|Out-Null;[IO.Directory]::CreateDirectory($backupRoot)|Out-Null
  [IO.File]::WriteAllBytes((Join-Path $ceilingRoot 'uploader-state.bin'),[byte[]](1,2,3,4,5,6,7))
  [IO.File]::WriteAllBytes((Join-Path $work 'retained-work.bin'),[byte[]](1,2,3))
  [IO.File]::WriteAllBytes((Join-Path $backupRoot 'retained-backup.pst'),[byte[]]::new(2MB))
  Assert-Equal (Get-UploadPrivateStateBytes) 10 'uploader ceiling counts uploader state and excludes retained cleanup backups'
  [IO.File]::WriteAllText((Join-Path $work 'export.json'),'synthetic export')
  Clear-Work
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $work 'export.json'))) 'work cleanup removes only known export artifact'
  Assert-True (Test-Path -LiteralPath (Join-Path $work 'retained-work.bin')) 'work cleanup preserves unrelated files'
  Assert-True (Test-Path -LiteralPath (Join-Path $backupRoot 'retained-backup.pst')) 'work cleanup preserves retained cleanup backup'

  Set-MaintenanceGate -Context $context -Enabled $true -Reason synthetic
  $otherContext=New-PrivateRuntimeContext -StateRoot $root -Environment uploader -MailboxBinding user -ConfigVersion upload-v2 -ProtectBytes $protect -UnprotectBytes $unprotect
  Assert-True (Test-MaintenanceGate -Context $otherContext) 'cleanup and uploader contexts share maintenance gate'
  Set-MaintenanceGate -Context $context -Enabled $false -Reason synthetic
  Assert-True (-not (Test-MaintenanceGate -Context $context)) 'gate can be explicitly cleared'
  [IO.File]::WriteAllBytes((Join-Path $root 'maintenance-gate.dpapi'),[byte[]](1,2,3))
  Assert-True (Test-MaintenanceGate -Context $context) 'corrupt gate fails closed'
  Remove-Item -LiteralPath (Join-Path $root 'maintenance-gate.dpapi') -Force
  Assert-True (Test-MaintenanceGate -Context $context) 'corrupt gate marker survives subsequent reads'

  $lease1=Enter-MaintenanceCoordinator -Context $context
  Assert-True $lease1.Acquired 'first process acquires shared mutex'
  $job=Start-Job -ArgumentList $script:BehaviorMutexName -ScriptBlock {param($mutexName)
    $other=[Threading.Mutex]::new($false,$mutexName)
    try{$got=$other.WaitOne(0);if($got){$other.ReleaseMutex()};return $got}finally{$other.Dispose()}
  }
  $job|Wait-Job|Out-Null;$second=Receive-Job $job;Remove-Job $job -Force
  Assert-True (-not $second) 'second process cannot enter while lock held'
  $lease1.Dispose();$lease3=Enter-MaintenanceCoordinator -Context $context
  Assert-True $lease3.Acquired 'mutex releases for the next phase'
  $lease3.Dispose()

  $script:Queue=[ordered]@{schemaVersion=1;generation='g-1';header=[pscustomobject]@{accountId='acct';exportedAt='2026-10-11T00:00:00.0000000Z';since='2026-09-30T07:00:00.0000000Z'};batches=@()}
  $node=[ordered]@{id='1';messages=@(
    [ordered]@{immutableId='a';folder='inbox';subject='synthetic A';sender='jobs@example.test';excerpt='A';occurredAt='2026-10-10T00:00:00.0000000Z';conversationId='';internetMessageId='';revision='r1'},
    [ordered]@{immutableId='b';folder='inbox';subject='synthetic B';sender='jobs@example.test';excerpt='B';occurredAt='2026-10-10T00:00:01.0000000Z';conversationId='';internetMessageId='';revision='r1'},
    [ordered]@{immutableId='c';folder='inbox';subject='synthetic C';sender='jobs@example.test';excerpt='C';occurredAt='2026-10-10T00:00:02.0000000Z';conversationId='';internetMessageId='';revision='r1'}
  );acknowledged=$false;children=@()}
  $global:ApiBehavior={param($method,$path,$body,$label,$headers)
    if($global:FailCall -and $global:ApiCalls.Count -eq $global:FailCall){throw 'synthetic process interruption'}
    if($global:ApiCalls.Count -eq 1){return @{Status=413;Body='{"error":"payload_too_large"}'}}
    return @{Status=200;Body='{"imported":1}'}}
  $script:Queue.batches=@($node);$global:FailCall=2
  try{Send-QueueNode $node;throw 'expected synthetic interruption'}catch{if($_.Exception.Message -ne 'synthetic process interruption'){throw}}
  $script:Queue=$global:LastQueueSnapshot
  $resume=$script:Queue.batches[0]
  Assert-Equal @($resume.children|ForEach-Object id) @('1.0','1.1') 'interrupted 413 split survives restart'
  Assert-True (-not $resume.children[0].acknowledged -and -not $resume.children[1].acknowledged) 'unacknowledged children remain pending after interruption'
  $global:FailCall=$null
  Send-QueueNode $resume
  $node=$resume
  Assert-Equal @($node.children|ForEach-Object id) @('1.0','1.1') '413 creates stable child identifiers'
  Assert-Equal @($node.children|Where-Object{-not $_.acknowledged}).Count 0 'all split children acknowledged'
  Assert-Equal $global:SaveCount 3 'parent split and both child acknowledgements are durably checkpointed'
  Assert-True (@($global:ApiCalls|Where-Object{$_.Path -eq '/local-outlook/import' -and $_.Headers['X-Job-Data-Generation'] -ne 'g-1'}).Count -eq 0) 'every import carries its bound generation'

  # Simulate the server accepting an import while the client loses its response.
  $global:ApiCalls.Clear();$global:SaveCount=0;$global:AcceptedPayload=$null;$global:LostResponse=$true
  $global:ApiBehavior={param($method,$path,$body,$label,$headers)
    if($global:LostResponse){$global:LostResponse=$false;$global:AcceptedPayload=[Text.Encoding]::UTF8.GetString($body);throw 'synthetic response lost after server acceptance'}
    return @{Status=200;Body='{"imported":1}'}
  }
  $retryMessage=[ordered]@{immutableId='retry-id';folder='inbox';subject='synthetic retry';sender='jobs@example.test';excerpt='retry';occurredAt='2026-10-10T00:00:00.0000000Z';conversationId='';internetMessageId='';revision='r1'}
  $retryNode=[ordered]@{id='retry';messages=@($retryMessage);acknowledged=$false;children=@()}
  $script:Queue.batches=@($retryNode)
  try{Send-QueueNode $retryNode;throw 'expected lost response'}catch{if($_.Exception.Message -ne 'synthetic response lost after server acceptance'){throw}}
  Assert-True (-not $retryNode.acknowledged) 'lost response leaves request unacknowledged'
  $firstPayload=$global:AcceptedPayload
  Send-QueueNode $retryNode
  Assert-Equal $global:ApiCalls[0].Body $global:ApiCalls[1].Body 'retry after lost response replays identical bytes'
  Assert-Equal $global:ApiCalls[1].Headers['X-Job-Data-Generation'] 'g-1' 'lost response retry retains original generation binding'
  Assert-True $retryNode.acknowledged 'successful replay records acknowledgement'

  # A continued sync is a bounded checkpoint, so each resumed local run probes
  # again until it reaches a terminal outcome.
  $global:BehaviorLogs=[Collections.Generic.List[string]]::new();$global:SyncStartCount=0;$global:SyncWaitCount=0
  $global:SyncOutcomes=[Collections.Generic.List[string]]::new();$global:SyncOutcomes.Add('continued');$global:SyncOutcomes.Add('continued');$global:SyncOutcomes.Add('completed')
  $script:QueuePath=Join-Path $root 'sync-queue.dpapi';[IO.File]::WriteAllText($script:QueuePath,'synthetic')
  $script:Queue=[ordered]@{phase='processing_pending';syncRunId='run-initial';collection=[pscustomobject]@{complete=$true}}
  $global:SaveCount=0;$script:Queue | Out-Null
  $status=Resolve-PendingSync ([ordered]@{lastExportedAt='now'})
  Assert-Equal $status 'pending' 'continued sync remains pending after its next probe'
  Assert-Equal $script:Queue.syncRunId 'run-1' 'continued sync stores the new probe id'
  Assert-Equal $script:Queue.phase 'processing_pending' 'continued sync persists resumable phase'
  $status=Resolve-PendingSync ([ordered]@{lastExportedAt='now'})
  Assert-Equal $status 'completed' 'continued then continued then completed terminates recovery'
  Assert-True (-not (Test-Path -LiteralPath $script:QueuePath)) 'completed sync removes durable queue'
  Assert-Equal $global:SyncStartCount 1 'continued starts one finite follow-up probe'
  Assert-Equal $global:SyncWaitCount 3 'resumed path polls each recorded sync run'

  foreach($terminal in 'failed','skipped_overlap'){
    $script:QueuePath=Join-Path $root ("sync-$terminal.dpapi");[IO.File]::WriteAllText($script:QueuePath,'synthetic')
    $script:Queue=[ordered]@{phase='processing_pending';syncRunId='run-old';collection=[pscustomobject]@{complete=$true}}
    $global:SyncOutcomes=[Collections.Generic.List[string]]::new();$global:SyncOutcomes.Add($terminal)
    $status=Resolve-PendingSync ([ordered]@{lastExportedAt='now'})
    Assert-Equal $status 'retry' "$terminal sync transitions to safe retry"
    Assert-Equal $script:Queue.phase 'sync' "$terminal sync retains durable queue for a fresh sync"
    Assert-True (Test-Path -LiteralPath $script:QueuePath) "$terminal sync does not discard acknowledged imports"
  }
  $script:QueuePath=Join-Path $root 'sync-pending.dpapi';[IO.File]::WriteAllText($script:QueuePath,'synthetic')
  $script:Queue=[ordered]@{phase='processing_pending';syncRunId='run-old';collection=[pscustomobject]@{complete=$true}}
  $global:SyncOutcomes=[Collections.Generic.List[string]]::new();$global:SyncOutcomes.Add('pending')
  Assert-Equal (Resolve-PendingSync ([ordered]@{lastExportedAt='now'})) 'pending' 'pending sync outcome preserves queue'
  Assert-Equal $script:Queue.syncRunId 'run-old' 'pending outcome remains attached to original run'
  Write-Host 'Synthetic Outlook behavior harness passed.'
} finally {
  Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
}

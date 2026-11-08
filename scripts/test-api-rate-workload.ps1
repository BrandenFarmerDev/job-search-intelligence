# Synthetic transport only: exercise the real uploader retry and split/ack functions.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-automation.ps1') -Mailbox 'synthetic@example.invalid' -ApiBase 'https://jobs-api.example.invalid/api/job-intelligence' -LibraryOnly
function Assert-Workload([bool]$Value,[string]$Reason){if(-not $Value){throw "Rate workload: $Reason"}}
function Write-Log {param([string]$Message)}
function Save-Queue {
  # A failed request cannot acknowledge a leaf. Durable persistence is tested by the existing lifecycle suite.
  $script:SavedAcks=@($script:Queue.batches | Where-Object {$_.acknowledged}).Count
}
function Get-RemainingRunSeconds {
  $remaining=1500-$script:Clock
  if($remaining -le 0){throw 'synthetic run budget exhausted'}
  return [int][Math]::Ceiling($remaining)
}
function Add-Trace([string]$App,[string]$Environment,[string]$Method,[string]$Route,[string]$Client,[int]$Bytes,[string]$Batch,[int]$Status,[string]$Layer,[string]$Relation=''){
  $script:Trace.Add([ordered]@{seconds=$script:Clock;app=$App;environment=$Environment;method=$Method;routeClass=$Route;clientClass=$Client;bodyBytes=$Bytes;preflightRelation=$Relation;batchId=$Batch;attempt=$script:Attempt;status=$Status;layer=$Layer;reachedWorker=($Layer -ne 'zone');requestGeneration='synthetic-v1';ackGeneration=$(if($Status -eq 200 -and $Client -eq 'uploader' -and $Method -eq 'POST'){'synthetic-v1'}else{''})})
}
function Admit-Synthetic([string]$App,[string]$Environment){
  $zone=@($script:Trace | Where-Object {$_.seconds -gt ($script:Clock-10)})
  if($script:Clock -lt $script:MitigationUntil){return 'zone'}
  if($zone.Count -ge 120){$script:MitigationUntil=$script:Clock+10;return 'zone'}
  $worker=@($script:Trace | Where-Object {$_.app -eq $App -and $_.environment -eq $Environment -and $_.reachedWorker -and $_.seconds -gt ($script:Clock-60)})
  if($worker.Count -ge 300){return 'worker'}
  return 'allow'
}
function Browser-Call([string]$App,[string]$Environment,[string]$Method,[string]$Route){
  $relation=''
  if($Method -notin @('GET','HEAD')){
    $relation="$App-$Route";$layer=Admit-Synthetic $App $Environment
    Add-Trace $App $Environment 'OPTIONS' $Route 'owner' 0 '' $(if($layer -eq 'allow'){204}else{429}) $layer $relation
    if($layer -ne 'allow'){return}
  }
  $layer=Admit-Synthetic $App $Environment
  Add-Trace $App $Environment $Method $Route 'owner' 0 '' $(if($layer -eq 'allow'){200}else{429}) $layer $relation
}
function Invoke-Api {
  param([string]$Method,[string]$Path,[byte[]]$Body)
  $script:Attempt++
  $layer=Admit-Synthetic 'jobs' 'production';$status=200
  $batch='';$bytes=0
  if($Body){$bytes=$Body.Length;$bundle=$script:Utf8.GetString($Body)|ConvertFrom-Json;$batch=[string]$bundle.messages[0].immutableId
    Assert-Workload ($script:Headers['X-Job-Data-Generation'] -eq 'synthetic-v1') 'generation must survive every retry'
    Assert-Workload (@($bundle.messages).Count -le 40) 'message limit'
    if($bytes -gt 150000){$status=413}
  }
  if($layer -ne 'allow'){$status=429}
  if($layer -eq 'allow' -and $script:Variant -eq 'forced' -and $Path -eq '/local-outlook/import' -and $script:ForcedRemaining -gt 0){$script:ForcedRemaining--;$status=429;$layer='forced'}
  if($layer -eq 'allow' -and $script:Variant -eq 'forced' -and $Path -eq '/sync-runs' -and $script:PollDenialReady){$script:PollDenialReady=$false;$status=429;$layer='forced'}
  if($status -eq 413){$script:ByteSplits++}
  Add-Trace 'jobs' 'production' $Method $Path 'uploader' $bytes $batch $status $layer
  $script:Clock+=$script:AckSeconds
  if($status -eq 200 -and $Body){foreach($message in $bundle.messages){Assert-Workload ($script:AckIds.Add([string]$message.immutableId)) 'no duplicate acknowledged message'}}
  return @{Status=$status;Body='{}';Headers=@{'X-Job-Data-Generation'='synthetic-v1'}}
}
$results=@()
foreach($variant in @('ordinary','fast','forced','edge413')){
  $script:Variant=$variant;$script:Clock=0.0;$script:MitigationUntil=0.0;$script:Attempt=0;$script:ByteSplits=0;$script:ForcedRemaining=0;$script:PollDenialReady=$false
  $script:AckSeconds=if($variant -in @('ordinary','edge413')){1.0}else{0.001}
  $script:Trace=[Collections.Generic.List[object]]::new();$script:AckIds=[Collections.Generic.HashSet[string]]::new();$script:Waits=[Collections.Generic.List[int]]::new()
  $script:Headers=@{};$script:Deadline=[DateTime]::UtcNow.AddMinutes(25)
  $script:SleepFn={param([int]$Seconds)$script:Waits.Add($Seconds);$script:Clock+=$Seconds}
  # Three simultaneous tabs, plus preview visits, from one synthetic egress address.
  foreach($environment in @('preview','production')){
    foreach($route in @('/api/health','/api/ask/status','/api/owner/contacts','/api/owner/bookings','/api/owner/settings')){Browser-Call 'portfolio' $environment 'GET' $route}
    foreach($route in @('/api/health','/api/projects','/api/projects/synthetic-id')){Browser-Call 'municipal' $environment 'GET' $route}
    foreach($route in @('/api/health','/dashboard','/review','/applications','/sync-runs')){Browser-Call 'jobs' $environment 'GET' $route}
  }
  Browser-Call 'portfolio' 'production' 'POST' '/api/contact'
  Browser-Call 'portfolio' 'production' 'POST' '/api/ask'
  Browser-Call 'jobs' 'production' 'PATCH' '/applications'
  Browser-Call 'jobs' 'production' 'GET' '/dashboard';Browser-Call 'jobs' 'production' 'GET' '/review'
  $script:Clock=.25;Browser-Call 'portfolio' 'production' 'GET' '/api/owner/contacts?q'
  if($variant -in @('fast','forced')){
    # Explicit stress: 300 owner reads over 40 seconds. No such background poll exists in the apps.
    for($i=0;$i -lt 300;$i++){$script:Clock+=.133;Browser-Call 'jobs' 'production' 'GET' '/dashboard'}
  }
  if($variant -in @('fast','forced')){
    # Explicit fast burst across the shared zone; this is a stress fixture, never generated live traffic.
    for($burst=0;$burst -lt 130;$burst++){Browser-Call 'portfolio' 'preview' 'GET' '/api/health'}
  }
  if($variant -eq 'forced'){$script:ForcedRemaining=4}
  $script:Queue=@{generation='synthetic-v1';header=@{accountId='synthetic';exportedAt='2026-11-07T00:00:00Z';since='2026-09-30T07:00:00Z'};batches=@()}
  $expectedMessages=0
  if($variant -eq 'edge413'){
    # Explicit persisted-queue/server-413 fallback edge case, never the ordinary preparation trace.
    for($batch=0;$batch -lt 80;$batch++){
      $messages=@();for($message=0;$message -lt 40;$message++){$messages+=@{immutableId="$batch-$message";excerpt=('x' * $(if($batch -lt 20){3800}else{100}));occurredAt='2026-10-01T00:00:00Z'}}
      $script:Queue.batches+=@{id=[string]$batch;acknowledged=$false;children=@();messages=$messages}
    }
    $expectedMessages=3200
  }else{
    # Prove feasibility against production normalization/serialization and the unique greedy
    # boundaries at outlook-automation.ps1:520, rather than sending oversized ordinary nodes.
    $largeTemplate=ConvertTo-Message ([pscustomobject]@{immutableId='m-000000';excerpt=('x'*7400);occurredAt='2026-10-01T00:00:00Z'})
    $largeCount=0
    for($count=1;$count -le $script:MaxBatchMessages;$count++){
      $bytes=$script:Utf8.GetByteCount((ConvertTo-BundleJson $script:Queue.header (@($largeTemplate)*$count)))
      if($bytes -gt $script:MaxBatchBytes){break};$largeCount=$count
    }
    Assert-Workload ($largeCount -gt 0 -and $largeCount -lt 40) 'fixture must exercise byte-bound preparation'
    $flat=[Collections.Generic.List[object]]::new()
    for($batch=0;$batch -lt 100;$batch++){
      $messages=@();$count=if($batch -lt 50){40}else{$largeCount};$excerptLength=if($batch -lt 50){100}else{7400}
      for($message=0;$message -lt $count;$message++){
        $normalized=ConvertTo-Message ([pscustomobject]@{immutableId=('m-{0:D6}' -f $flat.Count);excerpt=('x'*$excerptLength);occurredAt='2026-10-01T00:00:00Z'})
        $flat.Add($normalized);$messages+=$normalized
      }
      $script:Queue.batches+=@{id=[string]$batch;acknowledged=$false;children=@();messages=$messages}
    }
    $ordered=Merge-Messages @($flat.ToArray())
    Assert-Workload (($ordered.immutableId -join ',') -eq ($flat.ToArray().immutableId -join ',')) 'production merge preserves this unique sorted input'
    for($batch=0;$batch -lt 100;$batch++){
      $node=$script:Queue.batches[$batch]
      Assert-Workload (@($node.messages).Count -le $script:MaxBatchMessages) 'prepared message bound'
      Assert-Workload ($script:Utf8.GetByteCount((ConvertTo-BundleJson $script:Queue.header @($node.messages))) -le $script:MaxBatchBytes) 'prepared byte bound'
      if($batch -lt 99){
        $withNext=@($node.messages)+@($script:Queue.batches[$batch+1].messages[0])
        Assert-Workload (@($node.messages).Count -eq $script:MaxBatchMessages -or $script:Utf8.GetByteCount((ConvertTo-BundleJson $script:Queue.header $withNext)) -gt $script:MaxBatchBytes) 'every nonfinal boundary equals the production greedy preparation boundary'
      }
    }
    $expectedMessages=$flat.Count
  }
  $generation=Get-Generation;Assert-Workload ($generation -eq 'synthetic-v1') 'generation bind'
  foreach($node in $script:Queue.batches){Send-QueueNode $node}
  Invoke-ApiCall 'POST' '/sync/run' $null 'synthetic-sync'|Out-Null
  $script:PollDenialReady=($variant -eq 'forced')
  for($poll=0;$poll -lt 3;$poll++){$script:Clock+=$script:SyncPollSeconds;Invoke-ApiCall 'GET' '/sync-runs' $null 'synthetic-poll'|Out-Null}
  foreach($node in $script:Queue.batches){Assert-Workload (-not(Test-QueueNodePending $node)) 'all leaves acknowledged'}
  Assert-Workload ($script:AckIds.Count -eq $expectedMessages) 'all messages acknowledged exactly once'
  Assert-Workload ($script:ByteSplits -eq $(if($variant -eq 'edge413'){20}else{0})) 'only the explicit413 edge variant emits oversized roots'
  Assert-Workload ($script:Clock -lt 1500) '25-minute budget'
  $rollingZone=0;$rollingWorker=0
  foreach($event in $script:Trace){
    $rollingZone=[Math]::Max($rollingZone,@($script:Trace|Where-Object {$_.seconds -le $event.seconds -and $_.seconds -gt ($event.seconds-10)}).Count)
    $rollingWorker=[Math]::Max($rollingWorker,@($script:Trace|Where-Object {$_.reachedWorker -and $_.app -eq $event.app -and $_.environment -eq $event.environment -and $_.seconds -le $event.seconds -and $_.seconds -gt ($event.seconds-60)}).Count)
  }
  $zoneDenials=@($script:Trace|Where-Object {$_.layer -eq 'zone'}).Count;$workerDenials=@($script:Trace|Where-Object {$_.layer -eq 'worker'}).Count
  if($variant -in @('ordinary','edge413')){Assert-Workload ($zoneDenials -eq 0 -and $workerDenials -eq 0) 'ordinary assumed one-second acknowledgements fit limits'}else{Assert-Workload ($zoneDenials -gt 0 -and $workerDenials -gt 0) "stress crosses both limits (zone=$zoneDenials worker=$workerDenials)"}
  $results+=@{variant=$variant;ackSeconds=$script:AckSeconds;elapsedSeconds=$script:Clock;requests=$script:Trace.Count;rollingZone10s=$rollingZone;rollingWorker60s=$rollingWorker;zoneDenials=$zoneDenials;workerDenials=$workerDenials;retryDelays=@($script:Waits);acknowledgedMessages=$script:AckIds.Count;successfulLeafBatches=100;byteSplits=$script:ByteSplits;preparationEvidence=$(if($variant -eq 'edge413'){'explicit persisted-queue413 fallback'}else{'production normalization and serialization; equivalent unique greedy boundaries'});trace=@($script:Trace)}
}
[IO.Directory]::CreateDirectory((Join-Path $PSScriptRoot '../reports'))|Out-Null
$results|ConvertTo-Json -Depth 12|Set-Content (Join-Path $PSScriptRoot '../reports/api-rate-workload.json')
$results|ForEach-Object {Write-Output ("{0}: requests={1} elapsed={2} zone10={3} worker60={4} deniedZone={5} deniedWorker={6}" -f $_.variant,$_.requests,$_.elapsedSeconds,$_.rollingZone10s,$_.rollingWorker60s,$_.zoneDenials,$_.workerDenials)}

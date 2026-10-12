[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'outlook-mailbox-cleanup.ps1') -Library
Import-Module (Join-Path $PSScriptRoot 'outlook-private-runtime.psm1') -Force
function Assert-EngineTest([bool]$Value,[string]$Name){if(-not $Value){throw "Cleanup orchestration test failed: $Name"}}
$engineProtect={param($Bytes,$Entropy);return ,[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($Bytes))}
$engineUnprotect={param($Bytes,$Entropy);return ,[Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($Bytes))}
$script:RuntimeContextFactory={param($Root,$Environment,$Binding,$Version);New-PrivateRuntimeContext -StateRoot $Root -Environment $Environment -MailboxBinding $Binding -ConfigVersion $Version -ProtectBytes $script:engineProtect -UnprotectBytes $script:engineUnprotect}

# These functions replace only the cleanup script's Outlook/task boundaries. The real
# manifest, approval checks, protected journal, phase transitions, and orchestration run.
function Get-ScheduledTask { param($TaskName,$ErrorAction); return [pscustomobject]@{State=$script:MockTaskState} }
function Enter-MaintenanceCoordinator { param($Context);$script:CoordinatorCalls++;$lease=[pscustomobject]@{Acquired=$true;GateEnabled=$true};$lease|Add-Member ScriptMethod Dispose {};return $lease }
function Get-CleanupSession { param([string]$MailboxAddress);return $script:MockSession }
function Close-CleanupSession { param($Session) }
function Get-SourceItem { param($Session,$Row);if($script:MockLocation -eq 'source'){return $script:MockItem};return $null }
function Get-ApprovedDestination { param($Session,$Folders,$Row);return $script:MockDestination }
function Get-ItemRecord { param($Item,[string]$StoreId,[string]$FolderId,[string]$FolderLabel);$location=$script:MockLocation;$fid=if($location -eq 'destination'){$script:MockDestination.EntryID}else{$script:MockSource.EntryID};return [pscustomobject]@{storeId=$StoreId;folderId=$fid;entryId='entry-synthetic';internetMessageId='<fixture@example.invalid>';conversationId='fixture-thread';subject='Synthetic application';sender='jobs@example.invalid';receivedAt='2026-10-01T12:00:00.0000000Z';modifiedAt='2026-10-01T12:01:00.0000000Z';fingerprint=$script:MockRow.fingerprint;bodyHash=$script:MockRow.bodyHash;bodyLength=21;unread=$script:MockItem.UnRead;unreadStatus='readable';flagStatus='0';flagged=$false;categories='';categoriesStatus='readable';attachmentCount=0;attachmentStatus='readable';searchKey='';bodyStatus='complete';evidenceComplete=$true;actionEligible=$true;protected=$false;inaccessible=$false;body=$script:MockItem.Body} }
function Test-ApprovedSnapshot { param($Current,$Approved) }
function Test-RecoverySnapshot { param($Current,$Approved);if($script:BadRecoveryFidelity){throw 'injected changed fidelity'} }
function Test-ItemBackupFidelity { param($Item,$Expected,$ScratchRoot,[string]$AllowedRoot,$Context);if($script:BadRecoveryFidelity){throw 'injected changed fidelity'} }
function Find-PhysicalMatches { param($Session,$Folder,$Row);if($script:MockLocation -eq 'source' -and $Folder.EntryID -eq $script:MockSource.EntryID){return ,@($script:MockItem)};if($script:MockLocation -eq 'destination' -and $Folder.EntryID -eq $script:MockDestination.EntryID){return ,@($script:MockItem)};return ,@() }
function Get-ActionRows($Manifest){return ,@($Manifest.items|Where-Object{$_.action -in 'move','delete_to_deleted_items'})}
function Get-ActionRowsNeedingBackup($Manifest,$Journal){$result=[Collections.Generic.List[object]]::new();foreach($row in $Manifest.items){if((Get-JournalStatus $Journal $row.rowId) -notin 'backup_verified','move_started','completed'){$result.Add($row)}};return ,$result.ToArray()}

$base=Join-Path ([IO.Path]::GetTempPath()) ('cleanup-engine-'+[guid]::NewGuid().ToString('N'))
$run=Join-Path $base 'mailbox-cleanup\engine-fixture';[IO.Directory]::CreateDirectory($run)|Out-Null
$script:StateRoot=$base;$script:Mailbox='engine@example.invalid';$script:ManifestPath=Join-Path $run 'inventory.manifest.dpapi';$script:ApprovalHash='';$script:ApprovedFoldersPath=Join-Path $base 'approved-folders.dpapi';$script:BackendIdleProofPath=Join-Path $base 'backend-idle.dpapi';$script:SyntheticAcceptanceProofPath=Join-Path $base 'synthetic-proof.dpapi';$script:RolloutAcceptanceProofPath=Join-Path $base 'rollout-proof.dpapi';$script:BackupCeilingBytes=10000000
$script:MockTaskState='Disabled'
$context=New-CleanupRuntimeContext $base 'outlook-cleanup' (Get-StringHash $script:Mailbox.ToLowerInvariant()) 'cleanup-v1'
$script:MockSource=[pscustomobject]@{EntryID='source-inbox';Name='Inbox';StoreID='synthetic-store'}
$script:MockDestination=[pscustomobject]@{EntryID='approved-destination';Name='Rejections';StoreID='synthetic-store'}
$script:MockDeleted=[pscustomobject]@{EntryID='deleted';Name='Deleted Items';StoreID='synthetic-store'}
$script:MockNamespace=[pscustomobject]@{};$script:MockNamespace|Add-Member ScriptMethod GetFolderFromID {param($EntryID,$StoreID) if($EntryID -eq $script:MockSource.EntryID){return $script:MockSource};if($EntryID -eq $script:MockDestination.EntryID){return $script:MockDestination};if($EntryID -eq $script:MockDeleted.EntryID){return $script:MockDeleted};throw 'mock folder outside fixture'};$script:MockNamespace|Add-Member ScriptMethod OpenSharedItem {param($Path)return $script:MockItem}
$script:MockSession=[pscustomobject]@{StoreId='synthetic-store';Inbox=$script:MockSource;Junk=[pscustomobject]@{EntryID='source-junk'};Deleted=$script:MockDeleted;Namespace=$script:MockNamespace}
$script:MockRow=[ordered]@{rowId=('e'*64);storeId='synthetic-store';folderId='source-inbox';folder='Inbox';entryId='entry-synthetic';internetMessageId='<fixture@example.invalid>';conversationId='fixture-thread';subject='Synthetic application';sender='jobs@example.invalid';receivedAt='2026-10-01T12:00:00.0000000Z';modifiedAt='2026-10-01T12:01:00.0000000Z';fingerprint=(Get-StringHash 'synthetic fingerprint');bodyHash=(Get-StringHash 'synthetic body');bodyLength=14;unread=$true;unreadStatus='readable';flagStatus='0';flagged=$false;categories='';categoriesStatus='readable';attachmentCount=0;attachmentStatus='readable';bodyStatus='complete';evidenceComplete=$true;actionEligible=$true;protected=$false;inaccessible=$false;action='move';class='Rejections';destination='Rejections';confidence='high';reason='synthetic';attachmentMetadata=@()}
$manifest=[ordered]@{schema='outlook-cleanup-manifest.v2';schemaVersion=2;utilityVersion='1.0.0';ruleVersion='cleanup-rules-2026-10-11.2';createdAt=[datetime]::UtcNow.ToString('o');mailboxBinding=(Get-StringHash $script:Mailbox.ToLowerInvariant());storeId='synthetic-store';sources=@(@{folderId='source-inbox';folder='Inbox';defaultFolderId=6},@{folderId='source-junk';folder='Junk';defaultFolderId=23});complete=$true;evidenceComplete=$true;itemCount=1;items=@($script:MockRow)}
$manifestHashValue=Get-ManifestHash $manifest;$manifest.manifestHash=$manifestHashValue;$script:ApprovalHash=$manifest.manifestHash
$idle=[ordered]@{schemaVersion=1;manifestHash=$script:ApprovalHash;dataGeneration='fixture-generation';pendingMessages=0;pendingTrackerRows=0;runningSyncs=0;activeLeases=0;workflowsTerminal=$true;taskDisabled=$true;verifiedAt=[datetime]::UtcNow.ToString('o')}
$synthetic=[ordered]@{schemaVersion=1;syntheticPstRestoreVerified=$true;backupReopenVerified=$true;attachmentHashesVerified=$true;stateFidelityVerified=$true;cleanupFinalized=$true}
$folders=[ordered]@{schemaVersion=1;storeId='synthetic-store';rootId='root';rootName='Job Search';folders=@(@('Application receipts','f1'),@('Recruiter follow-ups','f2'),@('Interviews','f3'),@('Assessments','f4'),@('Offers','f5'),@('Rejections','approved-destination'),@('Job alerts','f7'),@('Review','f8')|ForEach-Object{@{name=$_[0];entryId=$_[1]}})}
$rollout=[ordered]@{schemaVersion=1;manifestHash=$script:ApprovalHash;capturedManifestHash=$script:ApprovalHash;processedManifestHash=$script:ApprovalHash;captureGeneration='fixture-generation';uploadReceiptId='fixture-receipt';processingRunId='fixture-processing';captureItemCount=1;candidateCount=1;candidateRowIds=@($script:MockRow.rowId);candidateSetHash=(Get-CandidateSetHash @($script:MockRow));uploadAccepted=$true;processingComplete=$true;approvedFoldersDiscovered=$true;preMoveCaptureComplete=$true;stableReplayVerified=$true;runtimeGateInteropVerified=$true}
foreach($pair in @(@($script:ManifestPath,$manifest),@($script:BackendIdleProofPath,$idle),@($script:SyntheticAcceptanceProofPath,$synthetic),@($script:ApprovedFoldersPath,$folders),@($script:RolloutAcceptanceProofPath,$rollout))){Save-ProtectedJsonAtomic -Path $pair[0] -Value $pair[1] -Context $context}
$backupBytes=[Text.Encoding]::Unicode.GetBytes('synthetic opaque MSG fixture');$backupPath=Join-Path $run 'backups\e.msg.dpapi';Save-ProtectedBytesAtomic -Path $backupPath -Bytes $backupBytes -Context $context
$fidelity=[ordered]@{subject=$script:MockRow.subject;bodyHash=$script:MockRow.bodyHash;receivedAt=$script:MockRow.receivedAt;unread=$true;flagStatus=0;categories='';wasSent=$true;attachmentHashes=@();attachmentCount=0}
$journal=[ordered]@{schemaVersion=1;manifestHash=$script:ApprovalHash;phase='actions';items=[ordered]@{}};$journal.items[$script:MockRow.rowId]=[ordered]@{status='backup_verified';backupPath=$backupPath;backupHash=(Get-BytesHash $backupBytes);fidelity=$fidelity;backupBytes=$backupBytes.Length;verifiedAt=[datetime]::UtcNow.ToString('o')}
$journalPath=Join-Path $run 'action-journal.dpapi';Save-ProtectedJsonAtomic -Path $journalPath -Value $journal -Context $context
$script:MockLocation='source';$script:MockMoveCount=0;$script:CoordinatorCalls=0;$script:CrashAfterMove=$false;$script:ThrowBeforeMove=$false;$script:BadRecoveryFidelity=$false
$script:DestinationItems=[pscustomobject]@{Count=1};$script:DestinationItems|Add-Member ScriptMethod Item {param($Index) if($script:MockLocation -eq 'destination' -and $Index -eq 1){return $script:MockItem};throw 'no mocked destination item'};$script:MockDestination|Add-Member NoteProperty Items $script:DestinationItems
$script:MockItem=[pscustomobject]@{EntryID='entry-synthetic';StoreID='synthetic-store';Subject=$script:MockRow.subject;Body='synthetic body';ReceivedTime=[datetime]::Parse($script:MockRow.receivedAt);UnRead=$true;FlagStatus=0;Categories='';Sent=$true;Attachments=[pscustomobject]@{Count=0};Parent=$script:MockSource}
$script:MockItem|Add-Member ScriptMethod Move {param($Destination);if($script:ThrowBeforeMove){throw 'injected move failure'};$script:MockMoveCount++;$script:MockLocation=if($Destination.EntryID -eq $script:MockSource.EntryID){'source'}else{'destination'};$this.Parent=$Destination;if($script:CrashAfterMove){throw 'simulated crash after Move before journal completion'};return $this}
$script:MockItem|Add-Member ScriptMethod SaveAs {param($Path,$Format);[IO.File]::WriteAllBytes($Path,[Text.Encoding]::UTF8.GetBytes('synthetic verified message'))}
$script:MockClockNow=[datetime]::UtcNow;$script:Clock={return $script:MockClockNow}
try {
  Set-MaintenanceGate -Context $context -Enabled $true -Reason 'synthetic test'
  Assert-EngineTest (Test-MaintenanceGate -Context $context) 'shared gate context reads enabled test gate'
  $roundManifest=Read-ProtectedJson -Path $script:ManifestPath -Context $context
  if((Get-ManifestHash $roundManifest) -cne $script:ApprovalHash){throw "Synthetic manifest canonical hash mismatch: $script:ApprovalHash vs $(Get-ManifestHash $roundManifest)."}
  $reviewRow=ConvertTo-MutableMap $script:MockRow;$reviewRow.rowId='f'*64;$reviewRow.entryId='entry-review';$reviewRow.action='review';$reviewRow.class='Review';$reviewRow.destination='Review';$reviewRow.actionEligible=$false;$reviewRow.evidenceComplete=$false;$manifest.items=@($script:MockRow,$reviewRow);$manifest.itemCount=2;$manifest.evidenceComplete=$false
  Assert-EngineTest ((Assert-ManifestActionScope $manifest) -eq $null) 'fully accounted Review evidence coexists with an individually eligible action'
  $manifest.items=@($script:MockRow);$manifest.itemCount=1;$manifest.evidenceComplete=$true
  $badAction=ConvertTo-MutableMap $script:MockRow;$badAction.actionEligible=$false;$manifest.items=@($badAction);$rejectedMalformed=$false;try{Assert-ManifestActionScope $manifest}catch{$rejectedMalformed=$true};Assert-EngineTest $rejectedMalformed 'action without per-item eligibility fails closed'
  $manifest.items=@($script:MockRow);$staleManifest=ConvertTo-MutableMap $manifest;$staleManifest.schemaVersion=1;$rejectedStale=$false;try{Assert-ManifestActionScope $staleManifest}catch{$rejectedStale=$true};Assert-EngineTest $rejectedStale 'legacy provisional schema is rejected before action authorization'
  $script:ApprovalHash=Get-ManifestHash $manifest;$manifest.manifestHash=$script:ApprovalHash;Save-ProtectedJsonAtomic -Path $script:ManifestPath -Value $manifest -Context $context
  $partialSynthetic=Read-ProtectedJson -Path $script:SyntheticAcceptanceProofPath -Context $context;$partialSynthetic.cleanupFinalized=$false;Save-ProtectedJsonAtomic -Path $script:SyntheticAcceptanceProofPath -Value $partialSynthetic -Context $context
  $beforeCoordinator=$script:CoordinatorCalls;$cleanupProofRejected=$false;try{Invoke-Execute}catch{$cleanupProofRejected=$true}
  Assert-EngineTest ($cleanupProofRejected -and $script:CoordinatorCalls -eq $beforeCoordinator) 'pending synthetic cleanup cannot satisfy Execute proof requirements'
  Save-ProtectedJsonAtomic -Path $script:SyntheticAcceptanceProofPath -Value $synthetic -Context $context
  function Assert-ExecutePreflightReject([string]$ProofPath,$GoodProof,[string]$Field,$BadValue,[string]$Name){
    $candidate=ConvertTo-MutableMap $GoodProof;$candidate[$Field]=$BadValue;Save-ProtectedJsonAtomic -Path $ProofPath -Value $candidate -Context $context
    $beforeCoordinator=$script:CoordinatorCalls;$beforeMove=$script:MockMoveCount;$rejected=$false;try{Invoke-Execute}catch{$rejected=$true}
    Assert-EngineTest ($rejected -and $script:CoordinatorCalls -eq $beforeCoordinator -and $script:MockMoveCount -eq $beforeMove) $Name
    Save-ProtectedJsonAtomic -Path $ProofPath -Value $GoodProof -Context $context
  }
  # Exercise each approval receipt dimension independently so a corrupted or
  # incomplete receipt can never reach the maintenance coordinator.
  Assert-ExecutePreflightReject $script:BackendIdleProofPath $idle 'pendingMessages' 1 'idle proof with queued messages blocks before coordinator'
  Assert-ExecutePreflightReject $script:BackendIdleProofPath $idle 'taskDisabled' $false 'idle proof with enabled task blocks before coordinator'
  Assert-ExecutePreflightReject $script:BackendIdleProofPath $idle 'dataGeneration' '' 'idle proof without current data generation blocks before coordinator'
  Assert-ExecutePreflightReject $script:BackendIdleProofPath $idle 'dataGeneration' 'stale-generation' 'idle and capture data generations must match before coordinator'
  $staleIdle=ConvertTo-MutableMap $idle;$staleIdle.verifiedAt=[datetime]::UtcNow.AddMinutes(-6).ToString('o');Save-ProtectedJsonAtomic -Path $script:BackendIdleProofPath -Value $staleIdle -Context $context
  $beforeCoordinator=$script:CoordinatorCalls;$staleRejected=$false;try{Invoke-Execute}catch{$staleRejected=$true};Assert-EngineTest ($staleRejected -and $script:CoordinatorCalls -eq $beforeCoordinator) 'stale backend idle receipt blocks before coordinator';Save-ProtectedJsonAtomic -Path $script:BackendIdleProofPath -Value $idle -Context $context
  foreach($field in 'backupReopenVerified','attachmentHashesVerified','stateFidelityVerified','cleanupFinalized'){Assert-ExecutePreflightReject $script:SyntheticAcceptanceProofPath $synthetic $field $false "synthetic proof missing $field blocks before coordinator"}
  foreach($field in 'manifestHash','capturedManifestHash','processedManifestHash'){Assert-ExecutePreflightReject $script:RolloutAcceptanceProofPath $rollout $field 'wrong-manifest' "rollout $field mismatch blocks before coordinator"}
  foreach($field in 'uploadAccepted','processingComplete','approvedFoldersDiscovered','preMoveCaptureComplete','stableReplayVerified','runtimeGateInteropVerified'){Assert-ExecutePreflightReject $script:RolloutAcceptanceProofPath $rollout $field $false "rollout proof missing $field blocks before coordinator"}
  foreach($field in 'captureGeneration','uploadReceiptId','processingRunId'){Assert-ExecutePreflightReject $script:RolloutAcceptanceProofPath $rollout $field '' "rollout proof missing $field blocks before coordinator"}
  Assert-ExecutePreflightReject $script:RolloutAcceptanceProofPath $rollout 'captureItemCount' 2 'rollout captured count mismatch blocks before coordinator'
  Assert-ExecutePreflightReject $script:RolloutAcceptanceProofPath $rollout 'candidateSetHash' 'wrong-set' 'rollout candidate set hash mismatch blocks before coordinator'
  $wrongIds=ConvertTo-MutableMap $rollout;$wrongIds.candidateRowIds=@('different-row');Save-ProtectedJsonAtomic -Path $script:RolloutAcceptanceProofPath -Value $wrongIds -Context $context
  $beforeCoordinator=$script:CoordinatorCalls;$idsRejected=$false;try{Invoke-Execute}catch{$idsRejected=$true};Assert-EngineTest ($idsRejected -and $script:CoordinatorCalls -eq $beforeCoordinator) 'rollout physical candidate row IDs must match exactly';Save-ProtectedJsonAtomic -Path $script:RolloutAcceptanceProofPath -Value $rollout -Context $context
  $foldersWrong=ConvertTo-MutableMap $folders;$foldersWrong.folders[0].name='Other';Save-ProtectedJsonAtomic -Path $script:ApprovedFoldersPath -Value $foldersWrong -Context $context
  $beforeCoordinator=$script:CoordinatorCalls;$taxonomyRejected=$false;try{Invoke-Execute}catch{$taxonomyRejected=$true};Assert-EngineTest ($taxonomyRejected -and $script:CoordinatorCalls -eq $beforeCoordinator) 'taxonomy names and selected store binding are checked before coordinator';Save-ProtectedJsonAtomic -Path $script:ApprovedFoldersPath -Value $folders -Context $context
  $script:MockTaskState='Ready';$beforeCoordinator=$script:CoordinatorCalls;$taskRejected=$false;try{Invoke-Execute}catch{$taskRejected=$true};Assert-EngineTest ($taskRejected -and $script:CoordinatorCalls -eq $beforeCoordinator) 'enabled scheduled task blocks item actions';$script:MockTaskState='Disabled'
  $roundIdle=Read-ProtectedJson -Path $script:BackendIdleProofPath -Context $context;$parsedIdle=ConvertTo-CleanupUtcDate $roundIdle.verifiedAt;if(([datetime]::UtcNow-$parsedIdle).TotalMinutes -gt 5 -or $parsedIdle -gt [datetime]::UtcNow.AddMinutes(1)){throw 'Synthetic idle proof timestamp outside accepted freshness.'}
  # Run the actual encrypted backup phase against a COM-shaped item before any
  # Move. This proves the scratch file is cleaned, the encrypted copy reopens,
  # fidelity is journaled, and the phase transition is restartable.
  $script:MockLocation='source';$beforeBackupMove=$script:MockMoveCount
  $backupJournal=[ordered]@{schemaVersion=1;manifestHash=$script:ApprovalHash;phase='backups';items=[ordered]@{}}
  Save-ProtectedJsonAtomic -Path $journalPath -Value $backupJournal -Context $context
  $backupPhase=Invoke-Execute;$verifiedJournal=Read-ProtectedJson -Path $journalPath -Context $context
  $verifiedState=Get-Field $verifiedJournal.items $script:MockRow.rowId $null;$restoredBackupBytes=Read-ProtectedBytes -Path $verifiedState.backupPath -Context $context
  Assert-EngineTest ($backupPhase.Phase -eq 'backups_complete' -and (Get-JournalStatus $verifiedJournal.items $script:MockRow.rowId) -eq 'backup_verified' -and $verifiedState.fidelity.bodyHash -eq $script:MockRow.bodyHash -and (Get-BytesHash $restoredBackupBytes) -eq $verifiedState.backupHash -and $script:MockMoveCount -eq $beforeBackupMove -and @(Get-ChildItem -LiteralPath (Join-Path $run 'scratch') -Filter '*.msg' -File).Count -eq 0) 'actual backup phase encrypts, reopens, records item fidelity, cleans scratch, and never moves the source'
  $backupBytes=$restoredBackupBytes;$backupPath=$verifiedState.backupPath
  # Move failure leaves a protected move_started journal; restart can still locate the source.
  $script:ThrowBeforeMove=$true;$failed=$false;try{Invoke-Execute}catch{$failed=$true};Assert-EngineTest $failed 'injected Move exception propagates'
  $j=Read-ProtectedJson -Path $journalPath -Context $context;$failedStatus=Get-JournalStatus $j.items $script:MockRow.rowId;Assert-EngineTest ($failedStatus -eq 'move_started') 'Move exception keeps recoverable intent in journal'
  # Move succeeds but process fails before completion journal write. Execute restart reconciles destination.
  $script:ThrowBeforeMove=$false;$script:CrashAfterMove=$true;$failed=$false;try{Invoke-Execute}catch{$failed=$true};Assert-EngineTest $failed 'post-Move crash is injected'
  $j=Read-ProtectedJson -Path $journalPath -Context $context;Assert-EngineTest ((Get-JournalStatus $j.items $script:MockRow.rowId) -eq 'move_started') 'crash preserves move_started state'
  $script:CrashAfterMove=$false;$script:MockLocation='destination';$before=$script:MockMoveCount;$result=Invoke-Execute
  $j=Read-ProtectedJson -Path $journalPath -Context $context;Assert-EngineTest ((Get-JournalStatus $j.items $script:MockRow.rowId) -eq 'completed' -and $script:MockMoveCount -eq $before) 'restart reconciles moved item without repeating Move'
  # Completed run is idempotent.
  $before=$script:MockMoveCount;$null=Invoke-Execute;Assert-EngineTest ($script:MockMoveCount -eq $before) 'completed action restart does not move again'
  # Recovery refuses duplicate physical matches rather than restoring another copy.
  $j=Read-ProtectedJson -Path $journalPath -Context $context;$j.items.PSObject.Properties[$script:MockRow.rowId].Value.status='move_started';Save-ProtectedJsonAtomic -Path $journalPath -Value $j -Context $context
  function Find-PhysicalMatches {param($Session,$Folder,$Row);if($Folder.EntryID -eq $script:MockSource.EntryID -or $Folder.EntryID -eq $script:MockDestination.EntryID){return ,@($script:MockItem,$script:MockItem)};return ,@()}
  $ambiguous=$false;try{Invoke-Recover}catch{$ambiguous=$true};Assert-EngineTest $ambiguous 'recovery refuses ambiguous duplicate source/destination matches'
  # When the item is still in its source after an interrupted action, recovery must
  # validate the source contents/state against the verified backup before completing.
  function Find-PhysicalMatches {param($Session,$Folder,$Row);if($script:MockLocation -eq 'source' -and $Folder.EntryID -eq $script:MockSource.EntryID){return ,@($script:MockItem)};return ,@()}
  $script:MockLocation='source';$script:BadRecoveryFidelity=$true;$sourceRejected=$false;try{Invoke-Recover}catch{$sourceRejected=$true};$j=Read-ProtectedJson -Path $journalPath -Context $context
  Assert-EngineTest ($sourceRejected -and (Get-JournalStatus $j.items $script:MockRow.rowId) -eq 'move_started') 'source-present recovery rejects changed backup fidelity before marking restored'
  $script:BadRecoveryFidelity=$false;$before=$script:MockMoveCount;$sourceResume=Invoke-Recover;$j=Read-ProtectedJson -Path $journalPath -Context $context;Assert-EngineTest ((Get-JournalStatus $j.items $script:MockRow.rowId) -eq 'restored_original' -and $script:MockMoveCount -eq $before -and $sourceResume.Phase -eq 'recovery_complete') 'source-present recovery accepts unchanged original and preserves its no-move location'
  # A changed recovery fidelity check also blocks journaling a successful restore.
  function Find-PhysicalMatches {param($Session,$Folder,$Row);if($script:MockLocation -eq 'destination' -and $Folder.EntryID -eq $script:MockDestination.EntryID){return ,@($script:MockItem)};return ,@()}
  $j=Read-ProtectedJson -Path $journalPath -Context $context;$j.items.PSObject.Properties[$script:MockRow.rowId].Value.status='move_started';Save-ProtectedJsonAtomic -Path $journalPath -Value $j -Context $context
  $script:MockLocation='destination';$script:BadRecoveryFidelity=$true;$failed=$false;try{Invoke-Recover}catch{$failed=$true};Assert-EngineTest $failed 'recovery refuses changed item fidelity before completion journal update'
  # Corrupted backup bytes reject before any recovery move.
  $script:BadRecoveryFidelity=$false;$j=Read-ProtectedJson -Path $journalPath -Context $context;$j.items.PSObject.Properties[$script:MockRow.rowId].Value.backupHash='bad-hash';Save-ProtectedJsonAtomic -Path $journalPath -Value $j -Context $context
  $before=$script:MockMoveCount;$corrupt=$false;try{Invoke-Recover}catch{$corrupt=$true};Assert-EngineTest ($corrupt -and $script:MockMoveCount -eq $before) 'backup corruption blocks recovery actions'
  $j=Read-ProtectedJson -Path $journalPath -Context $context;$j.items.PSObject.Properties[$script:MockRow.rowId].Value.backupHash=(Get-BytesHash $backupBytes);$j.items.PSObject.Properties[$script:MockRow.rowId].Value.status='move_started';Save-ProtectedJsonAtomic -Path $journalPath -Value $j -Context $context
  function Find-PhysicalMatches {param($Session,$Folder,$Row);return ,@()}
  $script:MockLocation='missing';$script:MockItem.Parent=$script:MockDestination;$before=$script:MockMoveCount;$backupRestored=Invoke-Recover;$j=Read-ProtectedJson -Path $journalPath -Context $context
  Assert-EngineTest ((Get-JournalStatus $j.items $script:MockRow.rowId) -eq 'restored_from_backup' -and $script:MockMoveCount -eq ($before+1) -and $backupRestored.Phase -eq 'recovery_complete' -and $j.items.PSObject.Properties[$script:MockRow.rowId].Value.backupHash -eq (Get-BytesHash $backupBytes)) 'missing originals restore from the integrity-checked encrypted MSG and preserve backup metadata in journal'

  # Final proof is a second phase: exact detached PST cleanup must succeed after
  # Outlook releases its file handles. All Outlook/filesystem boundaries are injected.
  $fixtureRoot=Join-Path (Join-Path $base 'mailbox-cleanup') ('synthetic-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($fixtureRoot)|Out-Null
  $fixturePst=Join-Path $fixtureRoot 'isolated-fixture.pst';[IO.File]::WriteAllBytes($fixturePst,[byte[]](1,2,3))
  $pendingPath=Join-Path $base 'pending-synthetic-restore.dpapi';$script:FinalizerNamespace=[pscustomobject]@{Stores=[pscustomobject]@{Count=0}}
  $script:SyntheticNamespaceFactory={return [pscustomobject]@{Namespace=$script:FinalizerNamespace;Application=$null}}
  $script:MockCleanupShouldSucceed=$false;$script:SyntheticCleanupRemover={param($Root,$Context);if(-not $script:MockCleanupShouldSucceed){return $false};$validated=Test-SyntheticRunPath $Root $Context;Remove-Item -LiteralPath $validated -Recurse -Force;return (-not(Test-Path -LiteralPath $validated))}
  $pendingReceipt=[ordered]@{schemaVersion=1;accepted=$false;syntheticPstRestoreVerified=$true;backupReopenVerified=$true;attachmentHashesVerified=$true;stateFidelityVerified=$true;fixtureRunRoot=$fixtureRoot;pstFileName='isolated-fixture.pst';verifiedAt=[datetime]::UtcNow.ToString('o')}
  Save-ProtectedJsonAtomic -Path $pendingPath -Value $pendingReceipt -Context $context
  $pendingResult=Invoke-FinalizeSyntheticRestore;$stillPending=Read-ProtectedJson -Path $pendingPath -Context $context
  Assert-EngineTest ($pendingResult.Phase -eq 'cleanup_pending' -and -not $pendingResult.Accepted -and -not (Test-Path -LiteralPath (Join-Path $base 'synthetic-restore-proof.dpapi')) -and -not [bool]$stillPending.accepted) 'locked fixture cleanup leaves only an unaccepted pending receipt'
  $pendingReceipt.fixtureRunRoot=Join-Path (Join-Path $base 'mailbox-cleanup') 'not-a-synthetic-run';Save-ProtectedJsonAtomic -Path $pendingPath -Value $pendingReceipt -Context $context
  $wrongPathRejected=$false;try{Invoke-FinalizeSyntheticRestore}catch{$wrongPathRejected=$true};Assert-EngineTest ($wrongPathRejected -and (Test-Path -LiteralPath $fixturePst)) 'wrong receipt path fails closed without touching the real fixture'
  Save-ProtectedBytesAtomic -Path $pendingPath -Bytes ([byte[]](0,1,2,3)) -Context $context
  $corruptReceiptRejected=$false;try{Invoke-FinalizeSyntheticRestore}catch{$corruptReceiptRejected=$true};Assert-EngineTest ($corruptReceiptRejected -and (Test-Path -LiteralPath $fixturePst)) 'corrupt encrypted receipt fails closed without fixture deletion'
  Save-ProtectedJsonAtomic -Path $pendingPath -Value ([ordered]@{schemaVersion=1;accepted=$false;syntheticPstRestoreVerified=$true;backupReopenVerified=$true;attachmentHashesVerified=$true;stateFidelityVerified=$true;fixtureRunRoot=$fixtureRoot;pstFileName='isolated-fixture.pst';verifiedAt=[datetime]::UtcNow.ToString('o')}) -Context $context
  $script:MockCleanupShouldSucceed=$true;$finalResult=Invoke-FinalizeSyntheticRestore;$acceptedProof=Read-ProtectedJson -Path (Join-Path $base 'synthetic-restore-proof.dpapi') -Context $context
  Assert-EngineTest ($finalResult.Accepted -and $acceptedProof.cleanupFinalized -and $acceptedProof.syntheticPstRestoreVerified -and -not(Test-Path -LiteralPath $pendingPath) -and -not(Test-Path -LiteralPath $fixtureRoot)) 'successful exact-path cleanup writes accepted final proof and removes pending receipt'
  $script:SyntheticNamespaceFactory=$null;$script:SyntheticCleanupRemover=$null
  Write-Output 'Synthetic Execute/Recover orchestration tests passed.'
} finally {
  try{Set-MaintenanceGate -Context $context -Enabled $false -Reason 'synthetic test complete'}catch{}
  $script:Clock=$null
  $script:RuntimeContextFactory=$null
  if(Test-Path -LiteralPath $base){Remove-Item -LiteralPath $base -Recurse -Force}
}

# Plan 1: Outlook mailbox cleanup

**Plan only — implementation and mailbox changes await approval.** Prepared October 11, 2026 on `bfarmer/outlook-mailbox-export-plan`. Review with [Plan 2: export process](outlook-export-process-plan.md) and the [independent QA critique](outlook-plans-qa.md). No mailbox/cloud access, task changes, code implementation or live verification is part of this planning phase.

## Scope and proposed result

Use the working classic Outlook COM profile for the selected Microsoft 365 Personal / Outlook.com mailbox. Organize job mail and retain job alerts; delete other mail from the **direct contents of Inbox and Junk only**, across all available dates. Existing subfolders, Sent, Archive, Deleted Items, calendars, other accounts and PSTs are not cleanup sources. Existing destination metadata may be inspected to resolve destinations. Unsupported item classes, including meeting requests, remain pending review; never accept/decline meetings automatically.

The app floor, September 30, 2026 midnight Pacific (`2026-09-30T07:00:00Z`), limits app ingestion, not mailbox preservation: retain older job mail. Select the account's delivery store and default folder IDs, not localized names: Inbox=6, **Junk=23, Deleted Items=3**, per [Microsoft's folder enumeration](https://learn.microsoft.com/en-us/office/vba/api/outlook.oldefaultfolders).

The documented baseline is an enabled daily 07:00 / ten-minute-after-logon task with installed script copies, 489 messages, 239 tracker rows and zero backlog; see [QA](qa.md). This is previous acceptance, not a new inventory. The reported account reset date is November 1, 2026; Graph remains runtime-disabled regardless. Backend cron and AI stay disabled; paid AI budget stays $0.

## Folder taxonomy and classification

Proposed same-store destinations are children of **Inbox / Job Search**. Safely reuse existing folders by IDs; resolve naming collisions before creation.

| Folder | Purpose |
| --- | --- |
| Application receipts | Specific submission confirmations and application acknowledgments |
| Recruiter follow-ups | Individual outreach, screening/status requests and recruiter correspondence, including genuine pre-application opportunities |
| Interviews | Interview invitations, scheduling, logistics and substantive follow-up |
| Assessments | Tests, exercises, assessment deadlines and results |
| Offers | Offers, negotiation and linked pre-employment/background-check steps |
| Rejections | Explicit rejection, cancellation or closed/withdrawn candidacy |
| Job alerts | Generic job alerts/recruiting newsletters without a specific application/conversation; **keep, per owner decision** |
| Review | Potential job mail whose purpose, legitimacy or destination is uncertain |

Classify each message's primary current purpose, using conversation context as support. An earlier receipt stays a receipt after a later rejection. Precedence: explicit offer-stage purpose, negative outcome, assessment action, interview action, receipt, recruiter correspondence, generic alert. Multiple conflicting substantive purposes go to Review. Quoted older outcomes, footer text, generic “offer” wording or a recruiting-domain sender cannot decide classification alone. A specific interview request takes precedence over a generic application acknowledgment footer.

Use deterministic local rules with high recall for potential job mail and explicit owner overrides. The existing exporter keyword filter is not safe as a deletion classifier. Attachment-only, protected, incomplete, suspicious and mixed personal/job messages need review. Do not run attachments, load remote images, follow links or send content to AI. Preserve unread state, flags, categories, timestamps, bodies and attachments; do not add Outlook categories.

Confident non-job mail is a deletion candidate even when personal, financial, medical, account/security, unread or flagged. **Do not silently exempt these from the owner's broad deletion intent.** Make their exact counts/items conspicuous in the private approval manifest. Ambiguity holds an item for review; exceptions must be explicit. Job alerts remain kept even though they are not specific app evidence.

## Approval gates and order

1. Owner reviews both plans and QA, then authorizes implementation/read-only inventory and creation of the listed empty folders under Inbox / Job Search after tested code and inventory. Until approval, documentation only.
2. Implement and test; inventory Inbox/Junk read-only and prepare the private item-level manifest. Create/reuse **empty** destinations matching the approved taxonomy/root as a logged non-mail action; bind actual IDs and verify collector discovery. No extra approval is needed when names/root match. Ambiguous collisions, changed names or a different root require clarification of that changed case. Journal created IDs; rollback may remove only a still-empty folder created by this run. Otherwise leave it for owner review.
3. Complete Plan 2 exporter/contract changes and authorized release acceptance. Verify target-folder discovery **before moves**, and capture all in-floor job-evidence candidates before cleanup. For relevant Junk mail, obtain approval of the specific inventory candidates for one-time direct read-only capture as semantically received messages; do not add routine all-Junk collection. Complete pre-move capture protects existing evidence but does not substitute for verified future folder discovery.
4. Produce actual action counts, private previews, preservation/restore proof and a manifest identifier/hash. Owner approves that exact move/delete set, destinations and immediate deletion versus optional quarantine. Written plan approval alone does not approve unspecified items.
5. Execute bounded approved actions; verify outcomes and restore the previous task state. Publish only scrubbed results and recovery instructions.

Thus the runtime dependency is **plan approval → tested code/inventory → approved-taxonomy empty folders → verified exporter and approved complete capture → verified backups/restore proof → exact item-action approval → cleanup → acceptance**. Plan numbering is not execution order. Existing source-publication authorization applies; merge/deployment need applicable release authorization. Initial approval can cover the listed folder configuration; item moves/deletions still require the later concrete manifest.

This is one-time cleanup. Never attach deletion to the daily exporter/task, install persistent Inbox rules or create later cleanup automation without new approval. Daily automation remains read-only toward Outlook; writing a local classification/export file or upload queue does not authorize mailbox writes.

## Inventory, identity and stale plans

Keep private files outside the repository, proposed `%LOCALAPPDATA%\JobSearchIntelligence\mailbox-cleanup\<run-id>`, separate from uploader `work` that is automatically cleared. Restrict ACLs and use approved encrypted storage/DPAPI for private contents. No subjects, addresses, bodies, attachment names, raw IDs, credentials or manifests in Git/PRs/routine logs. Retain existing credential protection; COM needs no new credential.

The versioned manifest records mailbox/store/folder IDs, inventory/tool/rule versions, completeness and hash; per physical item: opaque row ID, `StoreID`/`EntryID`, Internet Message-ID/search key when available, timestamps/conversation, corroborating content fingerprint, modification/read/flag/category state, attachment metadata, classification/confidence/reasons/alternatives, approved action, backup proof, and before/after journal locators/status.

Internet Message-ID is correlation evidence, not guaranteed unique. Handle duplicate/missing IDs without collapsing physical items. Keep app canonical identity compatible with the existing exporter/Worker; never add folder paths to it. Received versus Sent direction must not depend solely on a destination's name. Microsoft warns [EntryID can change across store moves](https://learn.microsoft.com/en-us/office/vba/api/outlook.mailitem.entryid); [Move returns the resulting item](https://learn.microsoft.com/en-us/office/vba/api/outlook.mailitem.move), whose locator must be journaled.

Report complete source counts by class/date/action/destination, unresolved/inaccessible items, and deletion intersections for unread, flagged, sensitive/personal/financial, attachment-bearing and pre-floor mail. Provide exact candidate lists privately and representative previews across each group. Distinguish physical-item counts from deduplicated app evidence. Scan caps, missing bodies or unsynchronized cache yield incomplete inventory, never permission to delete.

Before each action, resolve the approved locator in its approved source and compare identity, fingerprint, modification and state snapshot. Changed, missing, ambiguous or already moved items are skipped for review; new arrivals are outside approval. Unique corroborated fallback resolution is bounded to the approved source or journaled recovery destination. Never chase an item into other folders. Resume from the journal; do not repeat deletion against Deleted Items. Changed items/actions require renewed approval.

## Backup, deletion and recovery

Before originals move, save complete Unicode `.msg` backups for every approved action candidate, including attachments, with opaque filenames and original-folder/state mapping. App excerpts are not backups. Check space, counts, hashes and reopenability; protected/unsupported/corrupt items are ineligible for deletion. [SaveAs supports MSG/Unicode MSG](https://learn.microsoft.com/en-us/office/vba/api/outlook.mailitem.saveas), but fidelity must be verified.

Reopen every deletion backup read-only through [OpenSharedItem](https://learn.microsoft.com/en-us/office/vba/api/outlook.namespace.openshareditem), compare body/timestamps and attachment count/byte hashes where accessible, and retain flags/categories/read state separately. Never save reopened real mail into the live mailbox merely to test restoration. Prove actual round-trip restoration with synthetic fixtures in an isolated local test store excluded from all collectors; no synthetic live-mail or production-app writes. Clean owner-only plaintext temp files after encrypted-backup validation.

Default deletion proposal: explicitly move approved non-job originals to the same store's **Deleted Items**, journal returned IDs and verify destinations. Never empty trash/Junk, permanently purge, change retention, or delete an item already in Deleted Items: [Microsoft documents that Delete there permanently removes it](https://learn.microsoft.com/en-us/office/vba/api/outlook.mailitem.delete).

Optional owner-selected quarantine is a named same-store folder outside Inbox. It stages removal but does not finish deletion. Later disposal requires a separately approved manifest; no timer/rule is created. Deleted Items is not durable backup: Microsoft documents 30-day Outlook.com Deleted Items/Junk retention and limited additional recovery in [recovery guidance](https://support.microsoft.com/en-US/Outlook/mail/recover-and-restore-deleted-items-in-outlook). Verify current settings; do not promise a recovery SLA. Owner decides encrypted backup location/retention; this cleanup never deletes backups. DPAPI recovery depends on the Windows environment, so durable external recovery needs an approved encrypted destination.

Recovery prefers moving the journaled original back. Verify its original folder/state/attachments. Restore a backup copy only for an actually missing original, after integrity and duplicate checks; stop on ambiguity. Pause imports during recovery and verify replay cannot duplicate app evidence. Keep backups/journal until acceptance.

## Safe operation and acceptance

Record the task definition, prior enabled state and installed hashes. First disable only `JobSearchIntelligence-OutlookUpload`, let an active uploader finish, and acquire the existing `Local\JobSearchIntelligenceOutlookUpload` mutex. Hold it while installing and verifying the gate-aware script unit; set the durable private maintenance gate before releasing ownership between phases. Do not overwrite enabled or running installed copies. Cleanup and emergency recovery acquire the same mutex; the uploader checks the gate before work. The gate blocks manual/task runs and survives crashes until recovery revalidates safety. During controlled capture call the collector directly, not an uploader child that would deadlock reacquiring the mutex.

The coordinator records owner-authorized read-only D1 proof of zero pending messages, pending tracker rows, running syncs and active leases before moves; inspect Cloudflare terminal Workflow state if needed. Task exit 0 and bounded sync history do not prove idle. Do not add a service-token route. Do not kill Outlook, rewrite checkpoints or toggle backend cron/Graph/AI. After successful acceptance/recovery, clear the gate and restore the previous task state; never enable a previously disabled task. On unsafe failure retain gate/pause and report required recovery.

Preflight mailbox/store, cache completeness, destination IDs, approved manifest hash, backup space/proof and unattended COM availability. Stop on prompts without weakening Outlook security. Snapshot locators; proposed processing is 25 actions or five minutes per checkpoint, with per-item journal writes. Stop on identity drift, denied access, backup or destination failure; reconcile potentially completed actions before retrying.

Acceptance requires:

- Complete inventory/journal reconciliation; approved job mail and alerts preserved in expected folders; every residual, skipped or new item explained.
- Every deleted item matches approval, has verified backup and is located in Deleted Items; zero purges/out-of-scope actions. Quarantine is reported as staged.
- Plan 2 pre/post-move capture and unchanged replay prove continued folder discovery, stable evidence/owner decisions and no duplicate events/applications. Reconcile legitimate newly captured evidence rather than demand unchanged totals blindly.
- Meaningful isolated tests cover classification ambiguity/precedence, newsletters, sensitive non-job visibility, pre-floor preservation, duplicate/missing IDs, stale/store/folder mismatch, partial restart, backup corruption, attachment/state restore fidelity, dry-run without mutation, empty-folder rollback, durable gate/mutex races and crash recovery, and prior task-state restoration. Stub COM; use a disposable local store for round trips.
- `npm run quality` passes: every suite's four coverage metrics ≥85%, duplication <3%, zero lint warnings/vulnerabilities. Cover new meaningful cleanup logic. Run PowerShell checks; regenerate `npm run cf:types` and both named dry runs if Worker configuration changes. Record separate live provider acceptance and independent cost-effective QA findings/rechecks.

Handoff lists counts, private manifest/backup locations, recovery proof, installed exporter hashes, prior/final task state and unresolved checks. Owner decisions remain folder names, explicit non-job exceptions, Deleted Items versus quarantine, and encrypted backup retention. Current counts/cache, folder conflicts, backup fidelity, new folder integration and live acceptance remain unverified until authorized work. Future clock/logon triggers have not been newly verified here.

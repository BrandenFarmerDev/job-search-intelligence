# Plan 2: Outlook collection and upload

Approved by the owner on October 11, 2026 for implementation, read-only inventory and the listed empty-folder setup. Installed-client release, merge/deployment, production capture and the exact mailbox action manifest remain separate acceptance gates. Accept collector coverage **before** [Plan 1](outlook-mailbox-cleanup-plan.md) moves mail.

## Outcome and baseline

Improve the working classic Outlook COM path for Microsoft 365 Personal: preserve organized job evidence, reduce repeated reads, resume interrupted work, and distinguish accepted uploads from completed processing. Keep unrelated alerts/newsletters in **Job alerts**, without manufacturing applications from them.

Graph remains disabled; November 1 account reset is a future review opportunity. AI remains disabled/$0 paid budget, Worker cron disabled. Preserve Access/server owner authorization, the automation principal's exact three-route allowlist, workspace boundaries and additive ingestion. Planning and validating QA use Sol 6.1 high or Sol 5.6 high, with the same selected model for both roles; implementation uses a faster cost-effective capable model following the approved plan. Follow the [agent execution protocol](agent-protocol.md).

Reviewed collector/uploader/registration/PowerShell scripts, backend local import/identity/sync/Workflow and tests. See [operation](outlook-local-fallback.md), [architecture](architecture.md), [deployment](deployment.md), [QA](qa.md).

| Current behavior | Required improvement |
| --- | --- |
| Direct Inbox/Sent only; individual COM reads | Approved organized-folder coverage and fewer repeated reads |
| Keywords within first 6,000 body characters; 1,500-character excerpt | Full local relevance; useful minimal evidence span |
| Default 2,000 matches/folder; truncation rejected | Bounded resumable windows without silent omissions |
| Three-day occurrence overlap; transient payload | Historical reconciliation and durable retry |
| ≤40 messages/~150,000 bytes/upload; 256 KiB Worker ceiling | Preserve bounds and recover interrupted 413 splits |
| Workflow 20×2 messages, 15 changed Sheet rows, ≤50 continuations | Distinguish upload/queue/completion |

Floor stays September 30 midnight Pacific, `2026-09-30T07:00:00Z`. Installed task already runs at 07:00 and ten minutes after logon with private installed copies/DPAPI credential. Recorded acceptance: 489 messages, 239 tracker rows, zero backlog and unchanged replay; these are historical observations, not fresh checks.

## Folder and cleanup contract

Default Inbox/Sent remain **direct-items only**. Recursion applies solely to Plan 1's newly approved `Inbox/Job Search` subtree/eight child folders. Preexisting custom children require explicit inventory approval. Exclude other accounts/stores, archives/PSTs, search folders, Deleted Items/recovery trees, and routine Junk. Missing/renamed approved roots are coverage errors.

Approve/create empty folders as a logged non-mail stage, then validate installed collector inventory/coverage before moves. Capture an exact pre-move manifest. For direct Junk candidates, perform a **one-time manifest-selected job-evidence capture**, semantic received, into the private outbox before rescue/moves/deletion; production import follows only when release-authorized. Routine Junk stays excluded. After each tranche, account for every retained physical message before proceeding.

Keep physical paths/locators/policies in private manifests. Backend v1 `folder` stays semantic `inbox`/`sentitems`, never a custom path. Establish direction from verified sender/recipient/owner aliases/context; Plan 1's journal preserves original received direction for Inbox/Junk moves. Mixed custom folders require reliable per-item evidence or review. Neither inherited location nor `MailItem.Sent` alone establishes direction. Preserve actual sender and consistent ReceivedTime/SentOn.

Folder names never establish application/date/status. Unrelated Job alerts remain local-only; a misfiled receipt or recruiter conversation must still be detected/reviewed.

Both processes use existing `Local\JobSearchIntelligenceOutlookUpload` mutex plus a durable maintenance gate checked by the uploader. Pause task/verify no holder before cleanup; acquire gate/lock and recheck. Controlled capture must run under the coordinator's ownership or after deliberate lock release, never launch a child waiting on a mutex cleanup holds. Prove backend idle through owner read-only D1 backlog/lease counts and terminal Workflow status when needed; Task result 0 is insufficient.

The installed unit includes the uploader, collector, private runtime and cleanup helper. The collector uses the cleanup helper's pure purpose classification in an isolated cached module, so definite cleanup job purposes and export eligibility share one decision. Loading the helper as a library does not run mailbox cleanup. Include all four files in install hashes, prior-file snapshots and rollback verification; selected-Junk manifest hashing also requires that helper.

## Collection, content and identity

Start with `Items.Restrict` date/modification candidates and per-item projection. Benchmark `GetTable` before adding it: body evaluation still needs items. Restrict cannot filter Body/HTMLBody; Table Body holds only 255 bytes. [Restrict](https://learn.microsoft.com/en-us/office/vba/api/outlook.items.restrict), [Table limitations](https://learn.microsoft.com/en-us/office/vba/outlook/how-to/search-and-filter/unsupported-properties-in-a-table-object-or-table-filter).

Use captured upper bounds, inclusive overlap, minute-widened filters and exact UTC comparisons afterward. Prefer tested DASL namespace UTC filters; Jet explicit-property comparisons are local. Respect locale/minute precision; do not paste ISO literals or assume fixed Pacific offsets. Test floor, DST, locales, equal/fractional timestamps and another Windows timezone. [Microsoft date guidance](https://learn.microsoft.com/en-us/office/vba/outlook/how-to/search-and-filter/filtering-items-using-a-date-time-comparison).

Routine passes union occurrence/modification overlaps and deduplicate before body reads; identity/revision fingerprints skip unchanged projections. First run/new folder/config/filter version forces floor reconciliation. Independently complete a bounded floor sweep every seven days to catch delayed cached old mail and moves without reliable timestamp changes. Report Outlook/cache synchronization uncertainty.

Persist unfinished windows rather than collection indices. Split dense windows; equal-timestamp groups need bounded durable candidate manifests. Resume idempotently within 25 minutes, never advance past unenumerated work, and report incomplete limits. Release COM references promptly.

Read one full available plain-text body at a time locally; large/unreadable/incomplete content requires review. Preserve full content in Outlook; queue only minimal projections. Select deterministic useful evidence within the existing 1,500-character server excerpt. Larger server content/structured hints or a full-body local archive require separate contract/privacy/retention review. No attachments, HTML execution or mailbox modification.

Preserve canonical identity: normalized Internet Message-ID, otherwise normalized subject + UTC occurrence + conversation (or sender). Collector Internet-ID/search-key/EntryID hashes are separate locators; physical path/revision/excerpt/current EntryID cannot define canonical identity. EntryID can change across stores. [Microsoft identity guidance](https://learn.microsoft.com/en-us/office/vba/api/outlook.mailitem.entryid).

Keep moves within this store; capture identity inputs/direction/locator and recapture returned locators after move/restore. Prove stable evidence/events/manual decisions and revision-only replay. No-ID fingerprints can conflate distinct physical messages: cleanup journals require stricter physical-item identity, never canonical-fingerprint deduplication of move/delete candidates. Ambiguities require review. Local absence never authorizes D1 deletion.

## Durable queue and deletion protection

Use versioned manifests and bounded DPAPI-encrypted payloads in existing private state, user-only ACLs, bound to mailbox/store/environment/config. No extra database/service/runtime. Same-volume temp-write/flush/replace commits; integrity/schema validation; corrupt state quarantined with pending payloads retained. Migrate `lastExportedAt` with rollback copy and a floor sweep.

| State | Recovery |
| --- | --- |
| Enumeration incomplete | Replay window; do not advance |
| Payload/manifest committed | Scan progress advances with recoverable queue commit |
| Batch accepted | Atomic acknowledgement; lost response replays safely |
| Upload complete; sync required | Retry sync without acknowledged reuploads |
| Processing pending | Persist safe metadata; retry/check later |

Only lock holder mutates state. Replace blanket work cleanup with acknowledged-content pruning; preserve pending payloads across kills. Validate cleanup paths, warn after 24 hours pending, and stop discovery at an approved disk ceiling. Persist 413 child acknowledgements; measure complete serialized UTF-8 envelopes and oversized single items. Retain bounded network/429/5xx/busy retries and explicit Access/forbidden/pause failures.

**Required narrow backend change:** add a data-generation guard, rotated atomically with typed deletion. Existing `GET /sync-runs` returns the current generation through an additive response header; its array stays unchanged and no automation route/auth expansion occurs. Fetch/bind generation before discovery and persist it with each queue. Automated import supplies expected generation; missing generation fails closed. Check it atomically with **all** batch writes (references, memberships, metadata and checkpoint), not a preflight SELECT alone. Preserve existing maintenance-lease serialization of deletion/import; the header establishes freshness, not authorization. Stale queues are rejected/quarantined for owner review, never relabeled current. Test the PC missing both deletion and reconnect. If this guard cannot be completed, durable payload queuing waits; a local reset procedure cannot claim equivalent protection.

Cut over while paused: disable the old task, let its holder finish, acquire the shared mutex, and deploy the server guard that rejects missing or stale generations on automated imports. Install and verify the matching gate-aware client requiring the header, set the maintenance gate, then release ownership between controlled phases. Legacy automated clients fail closed; no temporary unguarded acceptance is needed. Manual owner browser v1 import remains supported as an explicit owner action. Generation enforcement/deployment need separate release approval; resume scheduling only after compatible installed-client acceptance and completion of maintenance.

## Completion, freshness and cost

Import 200 means references accepted; sync 202 means queued. `continued`, pending and Task result 0 do not prove continuation completion. Persist `syncRequired` before enqueue; later local runs recover failed hand-offs through existing `/sync/run`, using D1 backlog without reupload or cron. Report **upload accepted; processing pending** separately.

Bounded run history lacks durable chain/backlog correlation. MVP reports that limitation. During controlled acceptance, the coordinator combines completed run records, zero pending message/tracker counts, zero running history/active leases, and terminal Workflow inspection to establish a drained baseline at that observation time. This is not ongoing proof for every future chain; unattended end-to-end completion remains unverified without an authoritative correlated signal. Defer stronger chain health unless justified. Track content-free coverage/review/queue/upload/sync metrics; proposed warnings are 24-hour routine/pending age and seven-day reconciliation age. Offline/signed-out/unsynchronized means degraded freshness. No new notification/schedule.

Retain batching/Workflow limits. Free Workers allow 1,000 internal-service subrequests/invocation; D1 daily account quotas are five million rows read/100,000 written, reset 00:00 UTC. Continuations do not reset them. Measure synthetic backfill/replay cost; defer quota exhaustion without paid upgrades. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/pricing/). Sheets `A1:O1000` remains actual configured coverage; 10,000-row parser capacity does not extend it.

## Implementation and acceptance after approval

1. Finalize inventory/direction/disk policy; implement generation contract and synthetic seams.
2. Implement scoped collection, full local relevance, resumable windows, encrypted queue/acknowledgements/migration/freshness. Benchmark before GetTable.
3. QA, release-approved contract/client rollout, read-only coverage acceptance, separately approved production import, then cleanup tranches.

Required synthetic proof: nested/unknown/deleted/Junk scope; mixed direction; late-body receipt versus alert; locale/DST/floor/equal dates; delayed old mail/moves; >2,000 matches; no-ID collisions/move/restore/revision replay; kills around commits/HTTP/acks/enqueue; interrupted 413, disk-full/corrupt state, duplicates; maintenance contention; deletion/reconnect/offline/stale-generation/concurrent import; active lease blocks deletion and queued pre-deletion Workflows cannot repopulate old content; Access boundaries; continuation failure/cap/pending exit 0 and later recovery. Assert privacy, lineage, no duplicate events and bounded cost.

Commit injectable COM/HTTP/clock/filesystem behavior harnesses. Existing parse/`-SelfTest` is not collector behavior/coverage proof. Exercise Windows PowerShell 5.1 and available pwsh. Keep four coverage metrics ≥85% per existing suite; measure new maintained logic with vetted test-only tooling, enforce floors where measurable, disclose unmeasured COM paths for live acceptance. Never weaken gates/exclusions. Run `npm run quality`: duplication <3%, zero lint warnings/vulnerabilities. Worker config changes require `cf:types` and named environment dry runs.

Live evidence: installed/config hashes, task/cache readiness, selected-folder/date/item coverage, review gaps, queue drain, D1/run backlog and unchanged replay. Synthetic data stays isolated; no mail content/IDs/credentials/journals in repository/logs. Separate read-only coverage, production import and processing completion. Align architecture/setup/QA/release docs.

Rollout snapshots the prior task definition/state and installed files, disables the task, waits for the shared mutex, sets the durable maintenance gate, and installs the compatible unit. Registration leaves the task disabled; complete maintenance and restore the prior enabled state only after installed-client acceptance. Never overwrite live copies blindly or stop Outlook to obtain the mutex. Rollback retains queues, restores protected prior files/task in disabled state and keeps the gate set; it does not reverse server generation enforcement. After cleanup, Inbox/Sent-only rollback loses coverage: stay paused until compatible collection or separately approved mailbox restoration. Merge/deployment require release authorization.

Review defaults: selected Job Search subtree, minimal v1 excerpt, guarded encrypted queue, seven-day reconciliation and 24-hour warnings. Exact configuration/disk ceiling/review workflow need finalization. Graph eligibility, COM filter/cache behavior, performance, installed rollout and production acceptance remain unverified.


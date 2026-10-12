# Version-one local Outlook import

Version one reads the existing **classic Outlook for Windows** profile through the local Outlook Object Model (COM), exports a bounded JSON bundle, and uploads it through the private owner dashboard. It does not require Microsoft Entra, Azure or Graph. The future Graph implementation remains gated off for a separately reviewed release.

This machine was verified to have classic Outlook COM registered, the owner mailbox configured, and both Inbox and Sent Items accessible. New Outlook is also installed, but Microsoft does not support Outlook Object Model or COM automation in new Outlook. Keep classic Outlook installed and its local mailbox cache current while this fallback is needed.

## Export

Run from a normal PowerShell window on this PC:

```powershell
cd C:\GitHub\Apps\job-search-intelligence
.\scripts\outlook-com-export.ps1 `
  -Mailbox branden_farmer@live.com `
  -Since 2026-09-30T07:00:00Z `
  -OutputPath .\tmp\outlook-local-2026-10-01.json
```

The script is read-only. It selects the exact account's delivery store, scans direct Inbox and Sent Items, and optionally includes the explicitly bound `Inbox/Job Search` root and its eight approved children. Other subfolders, other accounts/PSTs, Deleted Items and routine Junk are excluded. Missing, renamed or expanded approved folders are coverage errors. Direction uses verified sender/recipient evidence and direct Inbox context; folder names cannot invent application outcomes. The full available plain-text body is evaluated locally, while the uploaded excerpt remains at most 1,500 characters and selects useful evidence even late in a long message. Generic job alerts remain local. It does not inspect attachments, send or modify mail, execute HTML or store Outlook credentials.

Use `-ValidateOnly` for COM/profile/folder availability without reading bodies or creating an export. Protected automation collects bounded slices of 500 physical candidates, using captured UTC bounds, widened DASL filters and exact UTC comparisons. Dense date windows split; final equal-timestamp groups use private locator manifests, not persisted Outlook collection indices. An interrupted scan replays its uncommitted window. A group exceeding 50,000 candidates or a snapshot exceeding the time budget fails visibly without advancing. `collection.complete` means enumeration finished; review gaps and Outlook cache synchronization remain separate. A manual export without protected resumable state is marked truncated when incomplete, and the dashboard/Worker reject it. `-IncludeAllMail` is an explicit troubleshooting privacy override. Use a new output filename or `-Force`.

## Import

Open the authenticated production dashboard, select **Import local Outlook JSON**, and choose the export. The browser limits files to 10 MB and sends at most 40 messages per authenticated, exact-origin request. The Worker validates format, identifiers, timestamps, folder, field lengths, historical floor, duplicate entries and a 256 KB request ceiling before an atomic upsert. It then queues the existing classifier/reconciliation Workflow.

Repeated exports are idempotent through the hashed account and stable message identifier. Internet Message-ID is preferred, then a normalized subject/time/conversation fingerprint, then the provider identifier. The import is additive: it does not infer that a missing local record was deleted or moved. Local evidence has no browser-safe Outlook web link, so the timeline shows the retained subject without an `Open Outlook evidence` link.

The Worker derives the canonical message-reference ID from Internet Message-ID when available and otherwise from fields shared by COM and the future Graph path. A later Graph release can upgrade the existing reference to Graph's immutable/account identifiers instead of creating duplicate evidence. When that feature is enabled and connected, the Worker rejects local imports so a stale bundle cannot undo authoritative folder-removal state.

After a successful import, securely remove the JSON file when it is no longer needed. Imported excerpts follow the same 30-day retention policy as Graph excerpts; durable evidence identifiers and owner decisions remain until the app's typed deletion control is used.

## Automated upload (Task Scheduler)

Owner decision, October 10, 2026: automate the classic-Outlook export and upload with a Windows Task Scheduler job on this PC. On the same date the owner explicitly approved this scheduled local import, its merge, the production deployment and live acceptance using the owner's real Outlook mail in production, which is the import's intended production use rather than test data. Live checks read only production D1 counts and run metadata, and the Outlook Object Model Guard is checked during acceptance because the job must run unattended without prompts. Unit and integration tests remain synthetic. Microsoft Graph stays disabled, and the server cron stays off (`SYNC_ENABLED=false`): the PC job queues the sync itself.

Components:

- `scripts/outlook-automation.ps1` (Windows PowerShell 5.1 compatible) collects bounded slices, persists encrypted uploads, queues processing and reports its observed status.
- `scripts/register-outlook-automation-task.ps1` registers task `JobSearchIntelligence-OutlookUpload` for the current user (interactive logon, limited rights, because Outlook COM needs the signed-in session). Triggers: daily 07:00 and at logon after 10 minutes. Settings: start when available, ignore a second instance, 30 minute limit, allowed on battery. It installs the uploader, collector, private runtime and cleanup classification helper together in `<state>\bin` so branch switches cannot change the job. The collector invokes the helper's pure classifier inside a cached private module; loading it performs no mailbox actions.
- State lives outside the repository in `%LOCALAPPDATA%\JobSearchIntelligence` (override with `-StateDirectory`): DPAPI credential, protected checkpoint/collection state, `upload-queue.dpapi`, protected approved-folder configuration, maintenance gate, logs, temporary protected output and installed scripts. Cleanup manifests/backups occupy the separate `mailbox-cleanup` tree. None is committed.

### Credential and Worker authorization

The job authenticates with a Cloudflare Access service token whose Access policy action is **Service Auth**. The Access application still requires the owner email for people; the service-token policy is separate. The Worker accepts the resulting JWT as the automation principal only when `AUTOMATION_CLIENT_ID` (a Worker secret, unset by default and in preview, so automation is disabled) equals the token's `common_name`, `sub` is empty, there is no `email` claim and `type` is `app`. Owners are now also required to present a non-empty `sub`.

The automation principal:

- must send no `Origin` header (an owner mutation without `Origin` is still rejected with 403 `origin_required`, and automation with any `Origin` gets 403);
- may call only `POST /local-outlook/import`, `POST /sync/run` and `GET /sync-runs` under `/api/job-intelligence`; everything else is 403 `automation_route_forbidden`;
- cannot resume imports: while `sync_paused` is true (after typed deletion) an automated import returns 409 `reconnect_sources_to_resume` and never clears the pause. Only an owner action reconnects;
- records `local_outlook_last_automated_import` (shown as "Last automatic upload" on Sources) and queues syncs with trigger `automation` (shown in Sync history).
- requires the current `X-Job-Data-Generation` on imports, obtained from the existing authorized sync-history response before discovery. Typed deletion rotates it atomically, and every import write is fenced by the generation and maintenance lease. Missing/stale generations fail closed. Queued Workflows carry the generation too; pre-deletion work cannot become current merely because sources reconnect. This does not extend authorization.

The service-token secret held on the PC is a deliberate, documented exception to keeping secrets in the Worker only. Its blast radius is limited by the Access policy plus the three-route Worker allowlist above, and it expires after one year.

### Setup (owner)

1. Create the service token in Zero Trust > Access > Service credentials and add a Service Auth policy that includes only that token to the production application. Do not change the owner-email policy. The secret is shown once.
2. Give the coordinator only the non-secret client ID so it can be set as Worker secret `AUTOMATION_CLIENT_ID` for production (see [deployment](deployment.md)).
3. Register the task (created disabled), then store the credential. `-SetupCredential` prompts for the client ID and secret as secure strings and saves a DPAPI-protected file readable only by this Windows user on this PC; neither value is echoed or logged:

```powershell
.\scripts\register-outlook-automation-task.ps1 -Mailbox <mailbox>
& "$env:LOCALAPPDATA\JobSearchIntelligence\bin\outlook-automation.ps1" -SetupCredential
```

4. Release the server generation contract and matching client together under the documented release approval. Registration first preserves the prior task definition/state and protected installed-file backups, disables the task, and waits for the shared mutex. It persists the durable maintenance gate before replacing the matching unit, then leaves the new task disabled. `-ShowMaintenanceStatus` reports its protected approval hash. Verify the shared gate, approved-folder IDs, protected state, real export/upload, terminal Workflow/backlog observation and unchanged replay before completing maintenance with that exact hash; `-CompleteMaintenance` clears the gate under the mutex, and only an explicitly authorized `-Enable` enables the task. Preserve a previously disabled state. `-RollbackMaintenance` restores protected prior files/task in disabled state with the gate retained; it does not roll back server generation enforcement or make an Inbox/Sent-only collector adequate after mail moves. `-Unregister` requires a disabled, idle task and leaves private state and logs.

### Behaviour

- Collection unions occurrence and modification overlaps (default three days), with a fixed floor of `2026-09-30T07:00:00Z`. First/new-scope collection and reconciliation at least every seven days scan from the floor. Revision state skips unchanged projections; scan progress commits only after its recoverable queue. `-FullBackfill` requests floor collection.
- A queue is bound to the server generation before touching Outlook. Atomic, user-only DPAPI state persists the queue, collection cursor and acknowledgements. The transient automation export is also encrypted. Only the mutex holder mutates state. A durable maintenance gate blocks manual/task runs and remains blocked if corrupt. Stale-generation queues are quarantined for owner review and never relabeled current; reconciliation resets. Pending payloads survive process kills.
- Upload preserves 40-message/~150,000-byte envelopes, TLS 1.2+, no redirects and no Origin. HTTP 413 persists child batches and acknowledgements; lost responses replay idempotently. Retry delays remain 30/60/120/240 seconds within a 25-minute run budget. Default uploader-state ceiling is 256 MiB (`-QueueMaxBytes`); retained cleanup backups have a separate explicit ceiling. Exceeding the ceiling stops discovery without deleting pending data/backups.
- HTTP 200 means accepted references; 202 means queued processing. `continued` and timeout persist **upload accepted; processing pending** with exit 0. Later runs retry/check processing without repeating acknowledged imports. Bounded history cannot prove a complete continuation chain: controlled acceptance also requires zero message/tracker backlog, zero running history/active leases and terminal Workflow inspection. A completed observed run is not an ongoing global drain guarantee.
- A 25-minute deadline bounds new collection/network work. The collector receives at most 20 minutes, reserving upload time; each request timeout and sync-poll deadline respects the remaining budget. Expiry retains pending data for a later run. A blocked Outlook COM call cannot be safely interrupted by this guard; prompts/provider hangs remain a separate unattended-acceptance limitation, and the process never kills Outlook.
- Logs retain only timestamps, counts, HTTP status/error codes and coverage/queue health. Routine/pending age warnings use 24 hours; reconciliation uses seven days. `-DryRun` exercises local collection without upload/progress acknowledgement, and `-SelfTest` plus committed synthetic COM/HTTP/filesystem harnesses exercise behavior in both PowerShell engines. Neither proves Outlook cache completeness or live provider acceptance.

### Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Completed, sync still pending, or another run already active |
| 1 | Unexpected error, export failure or missing credential |
| 2 | Collector reported a non-resumable truncated export; no progress accepted |
| 3 | Imports paused by the owner; pending state is retained and the owner must explicitly reconnect |
| 4 | Access rejected the credential (redirect, or 401/403 without the Worker JSON error shape) |
| 5 | Forbidden/client error, oversized item, missing/stale generation, invalid state/coverage contract or disk ceiling; inspect safe error code |
| 6 | Worker busy (`sync_running`) after retries |
| 7 | Server sync failed |
| 8 | Network or server error after retries |

Rotation and revocation: delete the token in Zero Trust (or remove its policy), unset the `AUTOMATION_CLIENT_ID` Worker secret, and rerun `-SetupCredential` with a new token. Run `register-outlook-automation-task.ps1 -Unregister` to stop the job.

## Mailbox maintenance utility

`scripts/outlook-mailbox-cleanup.ps1` separates read-only `Inventory` and static private `Review` from approved empty-folder `CreateTaxonomy`, and separately gated `Execute`/`Recover`. Version 2 inventories record complete physical enumeration separately from item-evidence completeness. Execute and Recover require complete, reconciled enumeration and complete evidence for every action row. Unavailable/protected bodies, unsupported items and unreadable metadata remain disclosed, ineligible Review rows; they do not authorize actions or block independently proven action rows. Empty taxonomy creation does not authorize mail actions and may proceed from an integrity-valid inventory with disclosed gaps.

Manifests, journals and encrypted Unicode MSG backups stay under the private cleanup run directory, outside Git. Hashes use ordinal canonical JSON and preserve strings exactly, including text that resembles a date. Backup validation compares full body, subject, received time, read/flag/category state and attachment byte hashes. Sent/draft state is recorded separately from the original MAPI flags. A restored copy must already preserve the proven sent/draft state before any timestamp repair. The utility never writes the read-only sent/draft flags after saving; it repairs only the delivery timestamp, then reopens the exact copy and checks fidelity. A provider refusal leaves maintenance paused. Existing originals are never modified to test this path.

`VerifySyntheticRestore` uses an isolated synthetic PST and never writes synthetic mail into the account. No accepted proof is produced unless restoration, attachment/state fidelity, exact PST detachment and fixture cleanup all pass. If Outlook retains a file handle after successful fidelity and detachment, an encrypted pending receipt remains unaccepted. After a graceful Outlook restart releases the handle, `FinalizeSyntheticRestore` validates that receipt and exact detached fixture path, removes only that fixture, then writes final proof. It cannot turn a failed fidelity run into acceptance. Current provider acceptance is recorded in [QA](qa.md).

Windows PowerShell's bundled Pester 3.4 measures commands in all five maintained runtime scripts through `scripts/measure-outlook-coverage.ps1`. Where available, `npm run check:powershell` enforces at least 85% per runtime file. This command metric supplements the unchanged four-metric npm suite gates; COM provider behavior and four-metric PowerShell coverage must not be inferred from it. Environments without the bundled measurement tool report coverage as unmeasured.

Manifest hashing uses a compiled local .NET serializer to avoid per-field PowerShell recursion on large inventories. Golden hashes and parity with a test-only reference serializer verify the existing canonical bytes. Its internal C# statement/branch coverage is unmeasured by Pester. A mandatory standalone harness runs the 17,000-row string-preserving JSON check and 17,155-row manifest hash check under both available engines, with a 60-second ceiling for each. These full-size fixtures run outside the coverage debugger; representative parser and hash cases still contribute to measured command coverage.

## Operational limits

- Windows and classic Outlook only; not suitable for Cloudflare scheduled execution.
- Classic Outlook must remain installed and have a synchronized local profile.
- Upload is manual unless the Task Scheduler job above is registered and enabled; the PC must be signed in with classic Outlook available. The server cron cannot discover local mail by itself and stays off.
- No attachment inspection and no email sending.
- Graph remains a possible unattended future path behind `MICROSOFT_GRAPH_ENABLED=false`; enabling it requires a separate review and live provider acceptance.

Microsoft documents that classic Outlook supports COM/Outlook Object Model while new Outlook does not: [feature comparison](https://support.microsoft.com/en-us/outlook/getstarted/feature-comparison-between-new-outlook-and-classic-outlook) and [new Outlook architecture](https://learn.microsoft.com/microsoft-365-apps/outlook/overview-new-outlook-windows).

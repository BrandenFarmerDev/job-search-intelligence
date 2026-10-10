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

The script is read-only. It opens the configured classic Outlook profile and scans MailItem records in Inbox and Sent Items from the selected UTC date. By default it exports only messages whose sender, subject, or body contains a bounded set of job-search terms or known recruiting-system domains. For those matches it writes subject, sender, short plain-text excerpt, timestamps, conversation/message identifiers, and deterministic hashed local identifiers. It does not read attachments, send or modify mail, change folders, or store Outlook credentials. The output contains private email content and belongs only in the ignored `tmp` directory or another private location.

Use `-ValidateOnly` to verify COM/profile/folder availability without reading message contents or creating a file. The default cap is 2,000 matched items per folder; an export reports scanned and matched counts and `truncated: true` if the matched cap is reached. The dashboard and Worker reject truncated exports so incomplete history cannot be mistaken for a complete import. Narrow `-Since` to a smaller date range and export again. `-IncludeAllMail` deliberately disables the privacy filter and should only be used for a reviewed troubleshooting export. Use a new output filename or explicitly pass `-Force` to replace a prior file.

## Import

Open the authenticated production dashboard, select **Import local Outlook JSON**, and choose the export. The browser limits files to 10 MB and sends at most 40 messages per authenticated, exact-origin request. The Worker validates format, identifiers, timestamps, folder, field lengths, historical floor, duplicate entries and a 256 KB request ceiling before an atomic upsert. It then queues the existing classifier/reconciliation Workflow.

Repeated exports are idempotent through the hashed account and stable message identifier. Internet Message-ID is preferred, then a normalized subject/time/conversation fingerprint, then the provider identifier. The import is additive: it does not infer that a missing local record was deleted or moved. Local evidence has no browser-safe Outlook web link, so the timeline shows the retained subject without an `Open Outlook evidence` link.

The Worker derives the canonical message-reference ID from Internet Message-ID when available and otherwise from fields shared by COM and the future Graph path. A later Graph release can upgrade the existing reference to Graph's immutable/account identifiers instead of creating duplicate evidence. When that feature is enabled and connected, the Worker rejects local imports so a stale bundle cannot undo authoritative folder-removal state.

After a successful import, securely remove the JSON file when it is no longer needed. Imported excerpts follow the same 30-day retention policy as Graph excerpts; durable evidence identifiers and owner decisions remain until the app's typed deletion control is used.

## Automated upload (Task Scheduler)

Owner decision, October 10, 2026: automate the classic-Outlook export and upload with a Windows Task Scheduler job on this PC. On the same date the owner explicitly approved this scheduled local import, its merge, the production deployment and live acceptance using the owner's real Outlook mail in production, which is the import's intended production use rather than test data. Live checks read only production D1 counts and run metadata, and the Outlook Object Model Guard is checked during acceptance because the job must run unattended without prompts. Unit and integration tests remain synthetic. Microsoft Graph stays disabled, and the server cron stays off (`SYNC_ENABLED=false`): the PC job queues the sync itself.

Components:

- `scripts/outlook-automation.ps1` (Windows PowerShell 5.1 compatible) runs the export, uploads, queues a sync and confirms it.
- `scripts/register-outlook-automation-task.ps1` registers task `JobSearchIntelligence-OutlookUpload` for the current user (interactive logon, limited rights, because Outlook COM needs the signed-in session). Triggers: daily 07:00 and at logon after 10 minutes. Settings: start when available, ignore a second instance, 30 minute limit, allowed on battery. It copies both scripts to `<state>\bin` so branch switches cannot change the job.
- State lives in `%LOCALAPPDATA%\JobSearchIntelligence` (override with `-StateDirectory`): `automation-credential.xml`, `state.json`, `logs`, `work` and `bin`. None of it is committed.

### Credential and Worker authorization

The job authenticates with a Cloudflare Access service token whose Access policy action is **Service Auth**. The Access application still requires the owner email for people; the service-token policy is separate. The Worker accepts the resulting JWT as the automation principal only when `AUTOMATION_CLIENT_ID` (a Worker secret, unset by default and in preview, so automation is disabled) equals the token's `common_name`, `sub` is empty, there is no `email` claim and `type` is `app`. Owners are now also required to present a non-empty `sub`.

The automation principal:

- must send no `Origin` header (an owner mutation without `Origin` is still rejected with 403 `origin_required`, and automation with any `Origin` gets 403);
- may call only `POST /local-outlook/import`, `POST /sync/run` and `GET /sync-runs` under `/api/job-intelligence`; everything else is 403 `automation_route_forbidden`;
- cannot resume imports: while `sync_paused` is true (after typed deletion) an automated import returns 409 `reconnect_sources_to_resume` and never clears the pause. Only an owner action reconnects;
- records `local_outlook_last_automated_import` (shown as "Last automatic upload" on Sources) and queues syncs with trigger `automation` (shown in Sync history).

The service-token secret held on the PC is a deliberate, documented exception to keeping secrets in the Worker only. Its blast radius is limited by the Access policy plus the three-route Worker allowlist above, and it expires after one year.

### Setup (owner)

1. Create the service token in Zero Trust > Access > Service credentials and add a Service Auth policy that includes only that token to the production application. Do not change the owner-email policy. The secret is shown once.
2. Give the coordinator only the non-secret client ID so it can be set as Worker secret `AUTOMATION_CLIENT_ID` for production (see [deployment](deployment.md)).
3. Register the task (created disabled), then store the credential. `-SetupCredential` prompts for the client ID and secret as secure strings and saves a DPAPI-protected file readable only by this Windows user on this PC; neither value is echoed or logged:

```powershell
.\scripts\register-outlook-automation-task.ps1 -Mailbox <mailbox>
& "$env:LOCALAPPDATA\JobSearchIntelligence\bin\outlook-automation.ps1" -SetupCredential
```

4. Live acceptance: run the installed script directly with the same arguments the task uses (`-Mailbox` plus `-StateDirectory`). Only after it passes, run `register-outlook-automation-task.ps1 -Mailbox ... -Enable`. Re-running the registration script updates the installed copy and keeps an already enabled task enabled. `-Unregister` removes the task and leaves state and logs.

### Behaviour

- Window: `since` is the last successful export time minus `-OverlapDays` (default 3), never earlier than the historical floor `2026-09-30T07:00:00Z` (also the first-run value). `-FullBackfill` ignores the saved state.
- Export: calls `outlook-com-export.ps1` with `-Force` into `<state>\work`; the export is deleted as soon as it has been read into memory, and only the run holding the single-instance lock clears leftover work files, at its start and end. A second run started while one is active exits 0 without touching them. The exporter and the uploader both dedupe by immutable ID and folder, keeping the newest.
- Upload: batches of at most 40 messages and about 150,000 UTF-8 bytes (HTTP 413 halves the batch), TLS 1.2+, no redirects, no `Origin`. HTTP 409 `sync_running`, 429 and 5xx/network errors retry after 30, 60, 120 and 240 seconds within a 25 minute budget. Zero messages skips the upload but still queues a sync.
- Sync: after `POST /sync/run` returns 202 with the workflow instance id (the same value as `sync_runs.id`), the job polls `GET /sync-runs` for up to 10 minutes. `completed` is success, `failed` exits 7, `skipped_overlap` waits and re-queues up to 3 times, and a run still going at the timeout is logged as pending (exit 0; the server keeps processing). `state.json` is saved right after every batch has uploaded, before the sync is queued, so a later sync problem never repeats the upload.
- Logs: `<state>\logs\yyyyMMdd.log`, kept 30 days. Short event lines hold only timestamps, counts, HTTP status codes and error codes; never subjects, senders or excerpts. Run `-DryRun` (export and local validation, no network, no state change; needs Outlook) or `-SelfTest` (pure helpers, no Outlook, no network) for checks.

### Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Completed, sync still pending, or another run already active |
| 1 | Unexpected error, export failure or missing credential |
| 2 | Export truncated (2,000 matches per folder reached). Run a narrower manual export and import it from the dashboard; the job does not split windows |
| 3 | Imports paused by the owner. The saved window is cleared on purpose so the first run after the owner reconnects backfills from the floor; the cost is that run re-uploads and re-processes all matching mail since 2026-09-30 (idempotent, but larger than a normal 3-day window) |
| 4 | Access rejected the credential (redirect, or 401/403 without the Worker JSON error shape) |
| 5 | Forbidden route or another client error, including one message too large |
| 6 | Worker busy (`sync_running`) after retries |
| 7 | Server sync failed |
| 8 | Network or server error after retries |

Rotation and revocation: delete the token in Zero Trust (or remove its policy), unset the `AUTOMATION_CLIENT_ID` Worker secret, and rerun `-SetupCredential` with a new token. Run `register-outlook-automation-task.ps1 -Unregister` to stop the job.

## Operational limits

- Windows and classic Outlook only; not suitable for Cloudflare scheduled execution.
- Classic Outlook must remain installed and have a synchronized local profile.
- Upload is manual unless the Task Scheduler job above is registered and enabled; the PC must be signed in with classic Outlook available. The server cron cannot discover local mail by itself and stays off.
- No attachment inspection and no email sending.
- Graph remains a possible unattended future path behind `MICROSOFT_GRAPH_ENABLED=false`; enabling it requires a separate review and live provider acceptance.

Microsoft documents that classic Outlook supports COM/Outlook Object Model while new Outlook does not: [feature comparison](https://support.microsoft.com/en-us/outlook/getstarted/feature-comparison-between-new-outlook-and-classic-outlook) and [new Outlook architecture](https://learn.microsoft.com/microsoft-365-apps/outlook/overview-new-outlook-windows).

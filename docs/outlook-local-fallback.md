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

## Operational limits

- Windows and classic Outlook only; not suitable for Cloudflare scheduled execution.
- Classic Outlook must remain installed and have a synchronized local profile.
- Manual export/upload is required. The daily server Workflow continues to process previously imported records but cannot discover new local mail by itself.
- No attachment inspection and no email sending.
- Graph remains a possible unattended future path behind `MICROSOFT_GRAPH_ENABLED=false`; enabling it requires a separate review and live provider acceptance.

Microsoft documents that classic Outlook supports COM/Outlook Object Model while new Outlook does not: [feature comparison](https://support.microsoft.com/en-us/outlook/getstarted/feature-comparison-between-new-outlook-and-classic-outlook) and [new Outlook architecture](https://learn.microsoft.com/microsoft-365-apps/outlook/overview-new-outlook-windows).

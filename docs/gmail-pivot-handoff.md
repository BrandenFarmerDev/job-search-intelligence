# Gmail pivot handoff

Updated October 11, 2026. Repository: `C:\GitHub\Apps\job-search-intelligence`.

Planning-session checkpoint, October 11: the unfinished Outlook changes and this original handoff were preserved in local commit `1d1eef2` on `bfarmer/outlook-cleanup-review-previews`. The separate `bfarmer/gmail-ingestion-pivot` branch starts from fetched `origin/main` at `bdbfb13cb4d848da0613c69e3645f711489e363f`; only this handoff was copied from the checkpoint. The three named recovery files were checked for existence without opening or changing them. Statements below that the Outlook work is uncommitted describe the incoming handoff state. The new [routing plan](gmail-routing-plan.md), [ingestion plan](gmail-ingestion-plan.md) and [independent review](gmail-plans-qa.md) are proposals, not implementation, configuration or provider acceptance.

## Owner direction

Decision update, October 11 planning session: owner approved `branden.farmer.dev+live-jobs@gmail.com` as the proposed redirect recipient, Gmail for future applications/replies, narrow initial routing, daily acceptance gap review then weekly review, historical gap-only transfer preserving existing records, and mailbox-wide read-only OAuth with application reads constrained to labeled job mail. See the reviewed [routing](gmail-routing-plan.md) and [ingestion](gmail-ingestion-plan.md) plans. Configuration, exact transfer manifests, real OAuth consent and release/provider acceptance remain pending.

Stop Outlook desktop automation and cleanup troubleshooting. Make **branden.farmer.dev@gmail.com the only mailbox the application reads**. Outlook/Live (`branden_farmer@live.com`) should only redirect relevant incoming job mail to Gmail through server-side rules. Retire COM, Windows scheduled uploads and any dual-provider ingestion fallback after Gmail acceptance. Preserve existing application data.

**Gmail integration, labels and Outlook forwarding are not configured yet.** This handoff records the pivot; it does not claim a completed migration.

## Completed releases and current state

| Work | Last verified result |
| --- | --- |
| [PR 13](https://github.com/BrandenFarmerDev/job-search-intelligence/pull/13) | Merged as `4e5278a`. Durable Outlook export, generation safeguards, cleanup protections and agent protocol improvements. Local quality, hosted checks and independent Sol 6.1 high QA passed; production deployment and migration 0004 succeeded. |
| [PR 14](https://github.com/BrandenFarmerDev/job-search-intelligence/pull/14) | Merged as `bdbfb13`. Fixed private installed-client path detection. Local quality, hosted checks and Sol 6.1 high QA passed. [Production deployment succeeded](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/38199182393). |
| Prior PRs and branches | PR 8 closed as incorporated. Completed branches removed; no open PR at the last inventory. Current unfinished branch remains below. |
| Production data | Last read-only verification: 492 messages, 179 applications, 192 events, 239 tracker rows; no pending messages/tracker rows, running syncs or active leases. Preserve these records during cutover. |
| Windows uploader | `JobSearchIntelligence-OutlookUpload` is **Disabled**; durable maintenance gate is **enabled**. Keep it paused. Encrypted registration backups remain available. |

Current checkout is **`bfarmer/outlook-cleanup-review-previews`**, based on main commit `bdbfb13cb4d848da0613c69e3645f711489e363f`. Uncommitted Outlook work remains in:

- `scripts/outlook-mailbox-cleanup.ps1`
- `scripts/test-outlook-cleanup.ps1`
- `scripts/test-outlook-cleanup-synthetic.ps1`
- New `scripts/test-outlook-cleanup-review-preview.ps1`
- `docs/outlook-local-fallback.md` and `docs/qa.md`

This work improves fixture isolation and optional private review previews. Independent Sol 6.1 high QA and focused tests passed. The final **`npm run quality` completed with exit 0**, including native PowerShell checks, coverage gates, builds, migrations and zero audit vulnerabilities. Log: `%TEMP%\job-search-preview-quality.log`. These changes are **not committed, pushed, in a PR or deployed**. Documentation result recording does not require repeating the behavior suites.

Preserve/checkpoint this unfinished work before creating a separate `bfarmer/gmail-ingestion-pivot` branch from verified main. Do not carry unfinished Outlook implementation into Gmail changes accidentally. This handoff is also a local, uncommitted file.

## Why Outlook stopped

Classic Outlook COM calls hung, and the synthetic restoration fixture could not preserve delivered versus draft state. Therefore no accepted provider restore proof exists, and **the real mailbox cleanup never ran**. Passing synthetic tests did not establish safe live deletion.

A fixture defect created 15 synthetic messages in default Drafts. Exact content, metadata and attachment checks identified all 15; guarded containment moved them into a private non-delivery PST and verified them. No pre-existing owner message was edited, moved or deleted; nothing was permanently purged.

Retain the PST and encrypted recovery records under:

`%LOCALAPPDATA%\JobSearchIntelligence\mailbox-cleanup\synthetic-a61e99073d4e4a778e935f3688c60290\`

Important files: `isolated-fixture.pst`, `owned-synthetic-drafts-verified.dpapi`, and `owned-synthetic-drafts-containment-journal.dpapi`. Other synthetic PSTs and temporary profile artifacts remain; do not broadly delete files or profiles.

The account-free Outlook experiment also hit a COM attachment hang. It is abandoned for this pivot. The **original Outlook profile was restored and verified**, with default registry settings unchanged and maintenance still enabled. Do not run the prepared PIM continuation. Older Outlook QA notes describing that experiment as the next step are superseded by this handoff.

## Gmail architecture and limits

Proposed flow: **Live selective redirect → Gmail labels → Gmail API → existing Worker/D1 processing → tracker**. No desktop dependency or second application mailbox reader.

1. **Selective forwarding:** configure Outlook.com under Settings → Mail → Rules, using job-related conditions and exceptions. Prefer **Redirect to**, which preserves the original sender, subject to live delivery tests. Keep source copies initially. Avoid forwarding all personal mail. Mailbox capacity can prevent forwarding, and matching rules can miss unexpected recruiters. [Microsoft rule documentation](https://support.microsoft.com/en-us/outlook/mail/use-rules-to-automatically-forward-messages).
2. **Organization:** use Gmail labels under `Job search`: Application receipts, Recruiter follow ups, Interviews, Offers, Rejections, Job alerts and Review. Job alerts/newsletters must be retained separately. Unknown messages go to Review. Gmail uses labels rather than exclusive folders. [Gmail labels](https://developers.google.com/workspace/gmail/api/guides/labels).
3. **Authentication:** personal Gmail requires owner-approved OAuth with offline access and a refresh token. Service-account impersonation requires Google Workspace domain-wide delegation and does not fit this personal Gmail account. Store credentials only in protected backend secrets. [Google service accounts](https://developers.google.com/identity/protocols/oauth2/service-account), [offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
4. **Permissions:** start with read-only ingestion and native Gmail filters. Label/query filtering limits application behavior, not OAuth access: `gmail.readonly` can read the mailbox. API-driven message labeling would need broader permissions such as `gmail.modify`. Do not request sending or permanent-deletion access for ingestion. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
5. **Token lifetime:** external OAuth apps left in Testing receive Gmail refresh tokens that expire after seven days. Resolve consent publishing and applicable verification requirements before unattended acceptance; handle revocation and reconnection. [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).
6. **API budget:** current new-project limits are 6,000 quota units/minute/user/project and 1,200,000/minute/project. Listing costs 5 units; fetching a message costs 20. Google documents an 80,000,000-unit daily billing threshold and planned billing changes. Verify the actual project's quotas and keep hard application caps, bounded retries and backoff within the $0 budget. Gmail quotas and Cloudflare execution/database limits are separate budgets. [Gmail quotas](https://developers.google.com/workspace/gmail/api/reference/quota).

Incoming rules do not migrate historical messages or capture replies sent from Live. Plan a separate, bounded historical migration and deduplicate against the 492 existing records. Use Gmail for future applications and replies if complete conversations should live there. Verify Spam/Junk coverage, sender/reply behavior, attachments and message identity rather than assuming forwarding preserves everything.

## Next session plan

Have Sol 6.1 high agents prepare two concrete plans: **mail routing and Gmail organization**, and **Gmail ingestion and cutover**. An independent Sol 6.1 high rubber duck should critique both. Resolve classification, historical migration, outbound identity and OAuth requirements before implementation.

Implementation should use a fast, capable model following those plans. Prefer bounded server-side polling initially, with pagination, durable checkpoints, replay safety, duplicate detection and recovery after token or quota errors. Retain the historical import floor of **September 30, 2026 midnight Pacific (`2026-09-30T07:00:00Z`)**; it is not permission to delete older mail.

Acceptance must demonstrate relevant and unrelated mail controls, delivery while the PC/Outlook are closed, correct labels, successful token refresh, bounded failure recovery, unchanged replay and preserved application data. Enable the accepted Gmail schedule only after release checks. Then retire legacy Outlook entry points/tasks and unused credentials without removing unrelated Google Sheets credentials or recovery evidence. The earlier Bitwarden service-token save is **unverified**; resolve separately without exposing the token.

## Planning testing and release rules

- Read [AGENTS.md](../AGENTS.md), [agent protocol](agent-protocol.md), [architecture](architecture.md), [deployment](deployment.md), [release checklist](release-checklist.md) and [QA](qa.md). This pivot supersedes the old Outlook plans.
- Use descriptive `bfarmer/*` branches. Plans and independent validating QA use **GPT-6.1 Sol high** by default, or **GPT-5.6 Sol high**, using the same chosen model for both roles. Implementation normally uses **GPT-6 Luna medium**. No AI coauthor lines.
- Keep React/Vite in `app/frontend`, Worker/D1 and private integrations in `app/backend`, serializable contracts in `packages/shared`. Preserve Cloudflare Access and independent owner authorization; changing the ingestion address must not silently change owner access.
- Keep secrets, real message bodies and recovery files out of Git/logs/frontend. Use isolated synthetic tests. Provider acceptance is separate from mocks, coverage and CI. No blanket deletion or unreviewed mailbox actions.
- Run targeted checks, independent QA, then freeze code and run one final `npm run quality`. All four coverage metrics remain at least 85% per suite; duplication below 3%; lint zero warnings; dependency audit zero vulnerabilities. Relevant native Windows command coverage remains at least 85% per runtime script while those scripts are supported.
- For repeated CI failures, capture the exact commit/job, runtime/platform and stack; diagnose with high-reasoning QA. No speculative patch/recheck loop or weakened gates. Verify hosted checks on the exact published commit; repeat only for new changes, failures or concrete unresolved concerns.
- Worker configuration changes require `npm run cf:types` and named preview/production dry-run builds. Merge/deploy require documented release authorization and acceptance. Earlier authorization covered the Outlook fixes; this handoff authorizes no new Gmail release. Keep scheduled imports and autonomous deployment disabled until accepted. Graph and application AI remain disabled; paid AI budget is $0.

## Prompt for the new session

> Read docs/gmail-pivot-handoff.md and the repository agreements. Preserve the uncommitted Outlook branch and private recovery artifacts. Pivot fully to personal Gmail as the sole ingestion source, using selective server-side Live redirect. Do not resume Outlook COM or live cleanup experiments. Prepare the two Gmail plans with Sol 6.1 high agents and independent Sol 6.1 high QA, then present the concrete decisions and acceptance criteria before implementation. Follow the bounded validation and release protocol; preserve production data and keep costs at $0.

# Implemented architecture

The implementation follows `Job_Intelligence_Architecture_and_Implementation_Plan.md`; section 21 tracks implementation separately from live provider acceptance.

## Boundaries

- `app/frontend`: private React/Vite dashboard, accessible charts, searchable applications, timelines, review/corrections/merges/exclusions, sync controls, follow-up recommendations, CSV and deletion.
- `app/backend`: Worker API, D1, durable JobSyncWorkflow, scheduled entry point, delegated Microsoft OAuth, read-only Sheets API, classification/reconciliation.
- `packages/shared`: serializable contracts and sixteen-event taxonomy. No credentials enter frontend artifacts.
- `scripts`: deployment isolation guard, dependency audit and unauthenticated Access checks.

Pages and API hosts require owner-email-only Cloudflare Access. The Worker independently verifies RS256 signature, issuer, environment audience, expiry and exact owner email. Every private route is protected; mutations require the exact frontend Origin. Preview/production have separate D1, Worker, Workflow, Access audience, AI Gateway and encryption key. workers.dev and version preview URLs are disabled.

## Frontend

Routes (react-router, all under one shell with a skip link, a collapsible icon-rail sidebar, a mobile Menu overlay and an icon-only Theme control):

| Route | Page |
| --- | --- |
| `/` | Overview: key figures, stage reach, weekly volume, status/reconciliation distributions, insights by source/company/role, follow-ups |
| `/applications` | Filterable, sortable, paginated list; detail drawer; add application; CSV export |
| `/review` | Uncertain source records with decision or exclusion |
| `/sources` | Local Outlook import, tracker connection, sync history, reprocess, typed deletion |
| `/about` | Capabilities and API status |

The shell owns one dashboard provider (`lib/dashboard-context.tsx`): `/dashboard` and `/review` load together, every owner action goes through its `perform`/`runAction`, and a success refreshes all views. Views with their own requests (`lib/use-api.ts`) reload on the provider's revision and abort on change or unmount. A route change moves focus to the page `h1`; the first load does not.

Applications state lives in the URL: `q`, `status`, `source`, `reconciliation`, `from`, `to`, `company`, `role`, `sort`, `page` (zero-based), `pageSize` (25 or 50) and `app` (open drawer). Changing a filter, sort or page size drops `page`; opening or closing the drawer only adds or removes `app`. The drawer loads `/applications/:id` itself, so a deep link works for any record, and closing it restores focus to the opener (or the `h1` for a deep link). Excluding an application uses an inline confirmation inside the drawer rather than a nested dialog. `ApplicationPicker` (merge target, review decisions) searches `/applications` independently of the list filters.

Components: `components/ui` holds the design primitives (Button, Field, SearchInput, StatusBadge, Panel, Kpi, Alert, EmptyState, Skeleton, Tabs, Drawer on native `<dialog>`, DataTable, Pagination, FilterChip). `components/charts` holds hand-written SVG BarChart, ColumnChart and StageReach; each has a Chart | Table switch, and the table lists every value. There are no chart dependencies and no inline styles, because Pages sends `style-src 'self'`.

Styling: semantic `--qe-*` tokens for light and dark in `styles/tokens.css`, ordered by CSS cascade layers in `styles/global.css`. The preference (System, Light, Dark) is stored in `localStorage` key `qe-theme`. `public/theme-init.js` is a same-origin script (inline scripts are blocked by the CSP) that sets `data-theme` on `<html>` before first paint; `lib/theme.ts` keeps it in sync and follows the system setting while System is selected. The same script restores the sidebar state (`data-sidebar` on `<html>`, key `qe-sidebar`), which `lib/sidebar.ts` keeps in sync.

API shapes added for this UI (`packages/shared`): `Dashboard` gained `outcomes` (applied, responses, screenings, interviews, offers, rejections and median response days per source/company/role), `weekly` (UTC Monday-start weekly counts), `medianFirstResponseDays` (nullable) and `lastSuccessfulSyncAt`. `GET /applications` accepts `pageSize` (25 or 50; 50 when absent), `sort` (`applied_desc`, `applied_asc`, `company`, `status`, `updated`; unknown values use `applied_desc`) and exact `company` and `role`, and returns `ApplicationListResponse`: `applications`, `page`, `pageSize`, `total` and `hasMore`.

## Ingestion and reliability

Microsoft OAuth uses PKCE, one-use owner-bound expiring state, a secure HTTP-only callback cookie, consumer authority and offline_access/User.Read/Mail.Read. Refresh tokens use AES-GCM with account-bound additional data and rotate. No Mail.Send permission or sending endpoint exists. Disconnect removes credentials/checkpoints and retains source evidence.

Inbox and Sent Items use immutable Graph identifiers and separate delta links. Source writes and page checkpoints commit atomically. Moves/removals update folder membership/availability without deleting evidence; expired cursors rebaseline their folder. Changed hashes enter a separate classification phase and unfinished records retry. A non-submission email cannot invent an application date: standalone responses require review; linked events retain the email timestamp. Confirmation/submission evidence provides a source-derived applied date, improved by the tracker or owner.

Until Microsoft app registration is available, a Windows-only fallback uses the installed classic Outlook Object Model through a read-only PowerShell collector. It exports bounded Inbox/Sent metadata and short plain-text excerpts to a private JSON bundle; the owner dashboard uploads batches of at most 40 messages through the same signed owner/origin boundary. Internet Message-ID produces the cross-provider canonical reference, so a later Graph import upgrades matching evidence instead of duplicating it. The fallback is additive and manual: it never sends or modifies mail and does not claim authoritative move/removal tracking. Graph remains the scheduled provider.

Sheets uses spreadsheets.readonly and one configured spreadsheet/range with values:batchGet. Explicit headers map to normalized rows. Natural keys survive reorder; hashes skip unchanged rows, versions retain old snapshots, removals become unavailable, duplicate identities/invalid calendar dates require review. Identity edits retain the old source and create a candidate rather than silently reassigning it. There is no write-back.

Workflow holds a conditional D1 lease, refreshes it, bounds work, and retries three times with exponential backoff and bounded Retry-After. Credentials are read within steps; outputs are sensitive and observability is disabled. Owner mutations share the maintenance lease. Run history retains counters and safe error codes, never raw provider bodies/tokens.

## Classification and canonical records

Explicit text rules run first. Ambiguous/unrecognized job context requires review. Extraction supports explicit field labels and ordinary application phrases. Optional Workers AI receives fixed vocabulary booleans, validates JSON, and always requires human review. Version/input cache and atomic daily reservations prevent repeated calls and excessive retries. AI is disabled with a zero daily cap until free-only execution is verified. No model calls have occurred.

Matching uses ID, requisition/organization, URL, conversation and compatible company/role/date. Multiple candidates, including conversations associated with multiple applications, require review. Current tracker and explicit email status disagreement creates a conflict. Passive confirmations/submissions/follow-ups do not replace current status; lifecycle rank prevents earlier requested stages replacing later scheduled/completed stages. Manual values/associations/exclusions are durable; explicit email status outranks tracker status. Tracker applied dates improve source-derived dates unless manually overridden. Snapshots, decisions, event evidence and owner audit records preserve lineage. Superseded/unreviewed classifications stay in the timeline but do not contribute to analytics.

Analytics exclude excluded applications. Timing averages omit unknown tracker event dates and display a separate unknown bucket. Timelines label observed dates. Computed follow-ups recommend reviewing active applications without a response after seven days; they never send messages. Persisted customizable task scheduling is optional and inactive.

## Privacy and acceptance

Excerpts expire after 30 days, finished runs after 90 days, and expired OAuth state is removed. IDs, subjects, sender references, sheet versions/snapshots, decisions and overrides remain until deletion. CSV formula-leading cells are escaped. Typed deletion removes records/credentials under the lease and durably pauses imports; queued/scheduled runs cannot recreate data until explicit reconnect. Service-account Worker secrets are not removed by record deletion; revoke/rotate external keys separately when retiring access.

Live Microsoft Graph consent/delta acceptance remains pending. Google production read and repeated unchanged-sync acceptance are complete.

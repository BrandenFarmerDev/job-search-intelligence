# Build QA — October 3, 2026

Branch `bfarmer/scaffold-foundation`; publication and a reviewed PR are authorized.

## Automated verification

Final `npm run quality` passes after the local Outlook fallback and COM-to-Graph transition corrections. Clean `npm ci` also passed. Zero lint warnings, fresh Worker types, strict TypeScript, frontend/backend builds, local D1 migrations, actionlint and named Worker dry runs pass. jscpd reports 0 clones / 0% duplication. Dependency audit reports zero vulnerabilities at every severity.

| Suite | Tests | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| Backend | 97 | 99.24% | 96.75% | 100% | 100% |
| Frontend | 196 | 99.24% | 94.36% | 98.74% | 99.46% |
| Shared | 12 | 100% | 100% | 100% | 100% |
| Deployment guard | 18 | 100% | 100% | 100% | 100% |

323 tests total; every suite independently enforces all four 85% floors. Coverage excludes declarations, bootstrap/test utilities and thin CLI wrappers, not maintained runtime modules. The Outlook exporter helper passed a PowerShell parser/runtime smoke check for present and missing MAPI values. A local credential-pattern scan of source candidates found no private-key, Google API-key or GitHub-token patterns.

Meaningful DB/provider/UI regressions cover signed JWT validation, exact-origin authorization, bounded responses, PKCE and encrypted rotation, leases and checkpoint atomicity, delta rebaseline/membership, Sheets identities/date validation/versioning, full-body parser boundaries, conservative matching, lifecycle status precedence, ambiguous conversations, manual overrides/exclusions, deletion pause, CSV formulas and unknown-date analytics.

## Independent QA

Separate `gpt-6-luna` rubber duck conducted read-only reviews and focused tests. Findings concerning timing, ordinary replies, expired-cursor membership, AI minimization, deletion/reimport, merge status, mutation races, exclusions, invented application dates, body fallback, lifecycle regression, arbitrary conversation context, local/Graph identity transition, Graph authority and local-export privacy scope were fixed and rechecked.

The final fallback review passed 25 backend and 10 frontend focused tests with no actionable finding. It specifically verified no-ID COM-to-Graph upgrade, Graph tombstones, rejection of stale local bundles after Graph connects, default job-search filtering and bounded browser chunking. The reviewer did not access mailbox data.

Before publication, separate cost-effective code and security reviewers examined the complete tree. They identified the still-exposed version-one Graph controls, missing Pages security headers, silently accepted truncated Outlook exports, a stale local-import marker after data deletion, and outdated release documentation. The fixes gate Graph routes/Workflow/UI, add static CSP and browser-hardening headers, reject truncated exports in both browser and Worker, clear the marker during deletion, and align the release plan. Both reviewers rechecked the corrected tree before commit.

The final production-readiness review fixed canonical-association loss after an owner application-date correction. A meaningful DB regression failed before the fix and passed afterward. A fresh independent GPT-6 Luna review passed the final code. The review contract permits an independent reviewer from the same model family when available routing offers no other family; this review used that disclosed exception. Separate operational GPT-6 Luna QA found no release-blocking code issue and accepted carrying the consent-pending live deletion check as an explicit limit.

## Quiet Enterprise UI

Automated checks (jsdom, synthetic data only) cover: every route and the not-found page; sidebar `aria-current`; mobile Menu toggle state and Escape; theme control writing `data-theme` and the stored preference; focus moving to the `h1` after a route change but not on first load; Overview figures including an unavailable median, chart/table toggles, insight links to exact filters and follow-up links; Applications URL-to-API filters, chips, page reset, sorting, pagination, debounced search, deep-linked drawer, timeline labels, correction, merge, inline exclusion, add and empty/failed lists; Review decisions, exclusion and the 100-record note; Sources chunked import, truncated/invalid export rejection, tracker, sync, reprocess, three-failure alert and typed deletion; the independent application picker; provider/hook unmount safety; and axe checks (color-contrast disabled, because jsdom cannot compute it).

Local browser audit (October 2, 2026; built frontend served with its production CSP headers and a synthetic mock API; no owner data): Overview, Applications (filters, chips, sort, drawer tabs, inline exclusion cancel), Review (Resolve form), Sources (delete dialog cancelled), About and not-found were inspected at 1440x900 in light, dark and system themes, plus about 410px wide in dark with the mobile Menu. Dark surfaces are not pure black; skip link is the first Tab stop with a visible focus ring; statuses carry text and icons; numeric cells are right-aligned. Fixes from that audit: oversized search icon, per-route document titles, explicit delete Cancel with disabled confirm until the phrase matches, duplicate freshness/count text, sync duration column and clearer review KPI context. Sheet review items still show "Tracker row" because stored snapshots are unkeyed cell arrays.

The October 2 inspection did not establish computed contrast of every status/hover state, all breakpoint widths, the full drawer keyboard walkthrough or reduced motion. The October 3 deployed checks below supplement that inspection.

## Deployed checks

Migrations 0001–0003 applied remotely to both D1 databases. October 3 verification found schema version 3, one normalization trigger, zero legacy `submitted` statuses, unchanged application counts (preview 1, production 16), and no pending migrations in either environment. Previous Workers and Pages deployments succeeded; version/rollback inventory is in plan section 21. Custom domains have active SSL. Unique environment encryption keys; owner Access and independent JWT validation; exact-origin credentialed CORS; workers.dev and version preview URLs disabled. The first live Sheets call exposed that Workers rejects `redirect:"error"`; the provider wrapper now uses `manual` and rejects redirect statuses before parsing or following them. The regression test covers that fail-closed behavior.

Real test D1/Workflow processing of two synthetic messages creates one application and two events. Unchanged repeat processes zero and preserves counts; no lock remains. The production classic-Outlook fallback imported 76 bounded messages from the selected historical floor, processed all 76 in one completed Workflow, created two canonical applications and retained uncertain records for review. Review exposed overly broad body-keyword matches, so the prospective default filter was tightened; a private rerun matched 65 messages and its JSON was immediately removed. The original uncertain records were kept for explicit owner review. The production tracker read changed 15 rows; the immediate replay changed 0 and reported 15 unchanged.

Unauthenticated custom frontends/APIs, preview/default Pages aliases and both current hash deployment URLs all return 302 to their exact configured Access application. Authenticated About routes on both environments report API connected after sending the owner session cookie. Owner browser Run sync/reprocess succeeded across exact-origin CORS.

Chrome checks: desktop and 390x844 mobile, emulated system light/dark, no horizontal page overflow; keyboard skip link focuses main; source filter yields empty results; synthetic evidence timeline and safe Outlook links; unknown direct route and return-home; production empty state. No app-origin warnings/errors in inspected dashboard flows; Cloudflare login pages produced unrelated IdP warnings. Browser select/fill automation did not reliably emit React change events; ordinary keyboard selection verified the source filter.

October 3: final reviewed code deployed to preview Worker `21a3a561-f2d6-4eb4-839b-4fd312adb6ae` and Pages `34363a79` using existing local Wrangler OAuth. Authenticated About reports API connected; inspected application console has no warnings/errors. Native Chrome 200% zoom was visibly confirmed, with a 768px viewport and no horizontal overflow; light and dark were inspected and zoom restored. Synthetic live date filtering, owner correction, review resolution, application merge with matching offer metrics, and authenticated CSV export passed. The permanent preview deletion action remains pending action-time user consent; deletion/pause regression tests pass. The preview DB backup and CSV are ignored local evidence. Production data was not altered by these tests.

Ignored local evidence: quality/deployment logs and `tmp/qa` browser screenshots, including the production Outlook import proof. Do not publish private evidence or ignored artifacts.

## Security and acceptance limits

GitHub secret scanning/push protection are enabled and the active main ruleset matches the portfolio: PRs, current branches, required quality and CodeQL checks, and no force push, deletion or bypass. Hosted quality and CodeQL pass on PR #1. CodeQL and Dependabot vulnerability alert queries report zero open findings; automatic security updates remain disabled to match the portfolio.

Microsoft Entra/Graph is outside version one. Its future implementation remains covered by tests, while `MICROSOFT_GRAPH_ENABLED=false` blocks its API routes, Workflow reads and frontend controls in all checked-in environments. The manual owner-only classic-Outlook path is operational. Google is complete: tracker-only Viewer access, production-only Worker secret, successful initial read and unchanged replay, with no local credential copy retained.

October 3 release authorization permits merge and production deployment. GitHub verification succeeded and ENABLE_DEPLOYMENTS=true was saved. AI_ENABLED=false, AI_DAILY_CALL_LIMIT=0, SYNC_ENABLED=false and MICROSOFT_GRAPH_ENABLED=false remain binding. No paid AI or model calls. Free-only AI activation and future Graph provider acceptance require separate verification. The dedicated token was subsequently proven by successful GitHub preview and production workflows; see the verified release below.

## Verified release — October 3, 2026

PR #1 and the reviewed deployment fix in PR #3 are merged. [Production workflow](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/37138746361) and [preview workflow](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/37138507982) passed quality, resource/origin guards, the additive migration check (none pending), Worker deployment, Pages upload and anonymous Access verification using the dedicated GitHub token. The first production attempt stopped before mutations; the regular environment-bound job fixes its secret-resolution failure.

Production Worker `f143dd81-7865-45a2-81ff-9f44cb79d46a`, Pages `e04e088b`; preview Worker `d0af18d5-1947-42a7-9db5-816dc10cdc35`, Pages `1ceadd05`. Compatible pre-release rollback: production Worker `4ef1a952-c717-4c40-8bb7-4b346135cc15` / Pages `445f4028`; preview Worker `21a3a561-f2d6-4eb4-839b-4fd312adb6ae` / Pages `34363a79`.

Authenticated production About reports API connected and the final dashboard loads 16 applications; read-only D1 count remained 16 before/after deployment. Inspected application console has no warnings/errors. Logs confirm SYNC_ENABLED=false, AI_ENABLED=false, AI_DAILY_CALL_LIMIT=0 and MICROSOFT_GRAPH_ENABLED=false. Preview environment requires owner approval with administrator bypass disabled; its waiting job was released only after checking reviewed commit `db60be7`. The token still has account-wide resource-type permissions, so every future preview approval must review the exact ref/commit.

Limits: live permanent preview deletion remains consent-pending; its automated regressions pass. Production uncertainty review is owner work. Future Graph and optional free-only AI activation require separate acceptance; no paid AI or email sending is enabled.

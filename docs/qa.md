# Build QA — October 2, 2026

Branch `bfarmer/scaffold-foundation`; publication and a reviewed PR are authorized.

## Automated verification

Final `npm run quality` passes after the local Outlook fallback and COM-to-Graph transition corrections. Clean `npm ci` also passed. Zero lint warnings, fresh Worker types, strict TypeScript, frontend/backend builds, local D1 migrations, actionlint and named Worker dry runs pass. jscpd reports 0 clones / 0% duplication. Dependency audit reports zero vulnerabilities at every severity.

| Suite | Tests | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| Backend | 82 | 99.17% | 96.55% | 100% | 100% |
| Frontend | 24 | 96.80% | 88.97% | 100% | 100% |
| Shared | 11 | 100% | 100% | 100% | 100% |
| Deployment guard | 18 | 100% | 100% | 100% | 100% |

135 tests total; every suite independently enforces all four 85% floors. Coverage excludes declarations, bootstrap/test utilities and thin CLI wrappers, not maintained runtime modules. A local credential-pattern scan of tracked/untracked source candidates found no private-key, Google API-key or GitHub-token patterns; this is a limited scan, not a hosted CodeQL result.

Meaningful DB/provider/UI regressions cover signed JWT validation, exact-origin authorization, bounded responses, PKCE and encrypted rotation, leases and checkpoint atomicity, delta rebaseline/membership, Sheets identities/date validation/versioning, full-body parser boundaries, conservative matching, lifecycle status precedence, ambiguous conversations, manual overrides/exclusions, deletion pause, CSV formulas and unknown-date analytics.

## Independent QA

Separate `gpt-6-luna` rubber duck conducted read-only reviews and focused tests. Findings concerning timing, ordinary replies, expired-cursor membership, AI minimization, deletion/reimport, merge status, mutation races, exclusions, invented application dates, body fallback, lifecycle regression, arbitrary conversation context, local/Graph identity transition, Graph authority and local-export privacy scope were fixed and rechecked.

The final fallback review passed 25 backend and 10 frontend focused tests with no actionable finding. It specifically verified no-ID COM-to-Graph upgrade, Graph tombstones, rejection of stale local bundles after Graph connects, default job-search filtering and bounded browser chunking. The reviewer did not access mailbox data.

Before publication, separate cost-effective code and security reviewers examined the complete tree. They identified the still-exposed version-one Graph controls, missing Pages security headers, silently accepted truncated Outlook exports, a stale local-import marker after data deletion, and outdated release documentation. The fixes gate Graph routes/Workflow/UI, add static CSP and browser-hardening headers, reject truncated exports in both browser and Worker, clear the marker during deletion, and align the release plan. Both reviewers rechecked the corrected tree before commit.

## Deployed checks

Both migrations applied remotely. Final Workers and Pages deployed successfully; version/rollback inventory is in plan section 21. Custom domains have active SSL. Unique environment encryption keys; owner Access and independent JWT validation; exact-origin credentialed CORS; workers.dev and version preview URLs disabled. The first live Sheets call exposed that Workers rejects `redirect:"error"`; the provider wrapper now uses `manual` and rejects redirect statuses before parsing or following them. The regression test covers that fail-closed behavior.

Real test D1/Workflow processing of two synthetic messages creates one application and two events. Unchanged repeat processes zero and preserves counts; no lock remains. The production classic-Outlook fallback imported 76 bounded messages from the selected historical floor, processed all 76 in one completed Workflow, created two canonical applications and retained uncertain records for review. Review exposed overly broad body-keyword matches, so the prospective default filter was tightened; a private rerun matched 65 messages and its JSON was immediately removed. The original uncertain records were kept for explicit owner review. The production tracker read changed 15 rows; the immediate replay changed 0 and reported 15 unchanged.

Unauthenticated custom frontends/APIs, preview/default Pages aliases and both current hash deployment URLs all return 302 to their exact configured Access application. Authenticated About routes on both environments report API connected after sending the owner session cookie. Owner browser Run sync/reprocess succeeded across exact-origin CORS.

Chrome checks: desktop and 390x844 mobile, emulated system light/dark, no horizontal page overflow; keyboard skip link focuses main; source filter yields empty results; synthetic evidence timeline and safe Outlook links; unknown direct route and return-home; production empty state. No app-origin warnings/errors in inspected dashboard flows; Cloudflare login pages produced unrelated IdP warnings. Browser select/fill automation did not reliably emit React change events; ordinary keyboard selection verified the source filter.

Browser **200% zoom remains unverified**: the attempted shortcut did not change pixel ratio/viewport, so no pass is claimed. Exhaustive live date/review/correction/merge/export/deletion checks remain release items, although automated tests pass.

Ignored local evidence: quality/deployment logs and `tmp/qa` browser screenshots, including the production Outlook import proof. Do not publish private evidence or ignored artifacts.

## Security and acceptance limits

GitHub secret scanning/push protection are enabled and the active main ruleset matches the portfolio: PRs, current branches, required quality and CodeQL checks, and no force push, deletion or bypass. Hosted quality and CodeQL pass on PR #1. CodeQL and Dependabot vulnerability alert queries report zero open findings; automatic security updates remain disabled to match the portfolio.

Microsoft Entra/Graph is outside version one. Its future implementation remains covered by tests, while `MICROSOFT_GRAPH_ENABLED=false` blocks its API routes, Workflow reads and frontend controls in all checked-in environments. The manual owner-only classic-Outlook path is operational. Google is complete: tracker-only Viewer access, production-only Worker secret, successful initial read and unchanged replay, with no local credential copy retained.

AI_ENABLED=false, AI_DAILY_CALL_LIMIT=0, SYNC_ENABLED=false and ENABLE_DEPLOYMENTS=false. No paid AI or model calls. Free-only AI activation still requires verification. See the canonical plan tracker and release checklist; first release remains incomplete.

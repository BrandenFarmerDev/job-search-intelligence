# Release checklist

Implementation is in PR #1 and provider acceptance is incomplete. Section 21 of the architecture plan is the canonical todo list. Check each item only with evidence for the release being reviewed.

## Automated and security gates

- [x] Clean npm ci on Node 24/npm 11; locked dependencies audit clean.
- [x] Local full quality: zero lint warnings; all four coverage metrics >=85% in every suite; duplication below 3%; fresh generated bindings, strict TypeScript, builds/migrations and dependency audit.
- [x] Pinned Actions validated by local actionlint; isolated environment Worker dry runs.
- [x] Secret scanning/push protection enabled; local secrets/private files/builds/reports ignored.
- [x] GitHub CI/CodeQL pass on PR #1; CodeQL and dependency alert queries report zero open findings.
- [x] Dependabot vulnerability alerts enabled with no open alerts; automatic security updates remain disabled to match the portfolio repository.
- [x] Dedicated 90-day deployment token provisioned in both protected GitHub environment secrets; deployments remain disabled.

## Private deployment and browser

- [x] Dedicated test/production D1/Worker/Workflow/Access/Gateway resources and unique encryption keys.
- [x] Migrations 0001–0003 applied remotely to both D1 databases; workers.dev/version preview routes disabled. Schema version 3, trigger presence, zero legacy statuses and unchanged application counts verified October 3.
- [x] SSL custom frontend domains configured; proxied test CNAME points to preview branch.
- [x] Unauthenticated test API returns expected owner Access challenge; backend verifies signed JWT independently.
- [x] Latest frontend/Worker versions deployed and authenticated owner browser smoke recorded; protected About health works in both environments.
- [x] Desktop/mobile/system light/dark, keyboard skip link, synthetic timeline/source filter, empty production and application console checks.
- [ ] Browser 200% zoom and exhaustive date/review/correction/merge/export/deletion actions. Automated UI/route regressions pass; live action checks remain.
- [x] Exact-origin credentialed CORS and protected Pages/default/preview/current hash aliases checked live.
- [x] Previous Worker/Pages versions recorded for rollback in plan section 21.

## Provider and data acceptance

- [x] Version-one Outlook path uses the bounded local export/import; Microsoft Graph UI, routes and Workflow reads are disabled with `MICROSOFT_GRAPH_ENABLED=false`.
- [x] Historical local import from 2026-09-30T07:00:00Z completed; future Graph delta acceptance is tracked outside version one.
- [x] Google JSON key/tracker-only Viewer grant approved/provisioned; production read changed 15 rows and immediate replay reported 15 unchanged.
- [x] Synthetic D1 Workflow replay proved no duplicate processing/applications/events.
- [x] DB-backed regression tests cover checkpoint atomicity, durable manual exclusions, mutation/sync lease, deletion pause, unknown dates, conservative matching and source precedence.
- [x] Rules taxonomy, bounded parser-based Graph body fallback, private evidence/minimal AI input and zero paid usage defaults.
- [x] Classic Outlook fallback uses a default job-search filter, bounded authenticated import, shared Graph identity, and stops accepting local bundles after Graph connects.
- [ ] Remaining first-release acceptance items recorded as passed with live evidence; synthetic tests are not provider acceptance.

## Publication and operation

- [x] Owner authorized GitHub source publication and a brief reviewed PR. Do not add Codex/Copilot coauthors.
- [ ] Full release accepted before ENABLE_DEPLOYMENTS or scheduled sync are enabled.
- [ ] If optional AI is activated, verify free-only account behavior and hard quotas first; paid limit remains $0.
- [x] Separate cost-effective GPT-6 Luna QA review is complete on final behavior; concrete findings fixed and rechecked.

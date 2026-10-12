# Release checklist

October 11 Gmail pivot: historical checked boxes below are evidence for their named earlier releases only. They do not accept Gmail or authorize its release. The [routing plan](gmail-routing-plan.md), [ingestion/cutover plan](gmail-ingestion-plan.md) and [independent planning review](gmail-plans-qa.md) define the proposed new gates. Gmail/Live routing remain unconfigured; Windows uploads stay disabled with maintenance enabled. Graph, AI and server scheduling remain disabled. Gmail merge/deployment and schedule activation require separate release authorization and acceptance.

Implementation is in PR #1. Version one uses local Outlook import and the verified Sheets reader; future Graph and optional AI acceptance are separate. Section 21 of the architecture plan is the canonical todo list. Check each item only with evidence for the release being reviewed.

## Automated and security gates

- [x] Clean npm ci on Node 24/npm 11; locked dependencies audit clean.
- [x] Local full quality: zero lint warnings; all four coverage metrics >=85% in every suite; duplication below 3%; fresh generated bindings, strict TypeScript, builds/migrations and dependency audit.
- [x] Pinned Actions validated by local actionlint; isolated environment Worker dry runs.
- [x] Secret scanning/push protection enabled; local secrets/private files/builds/reports ignored.
- [x] GitHub CI/CodeQL pass on PR #1; CodeQL and dependency alert queries report zero open findings.
- [x] Dependabot vulnerability alerts enabled with no open alerts; automatic security updates remain disabled to match the portfolio repository.
- [x] Dedicated 90-day deployment token provisioned in both protected GitHub environment secrets; deployment enabled October 3 under owner release authorization; token execution verified in preview and production GitHub runs.

## Private deployment and browser

- [x] Dedicated test/production D1/Worker/Workflow/Access/Gateway resources and unique encryption keys.
- [x] Migrations 0001–0003 applied remotely to both D1 databases; workers.dev/version preview routes disabled. Schema version 3, trigger presence, zero legacy statuses and unchanged application counts verified October 3.
- [x] SSL custom frontend domains configured; proxied test CNAME points to preview branch.
- [x] Unauthenticated test API returns expected owner Access challenge; backend verifies signed JWT independently.
- [x] Final reviewed preview and production Worker/Pages deployed through GitHub; authenticated About health passed October 3 in both environments.
- [x] Desktop/mobile/system light/dark, keyboard skip link, synthetic timeline/source filter, empty production and application console checks.
- [x] October 3 final preview: native Chrome 200% zoom without overflow, light/dark, date filter, correction, review resolution, merge with matching offer metrics and CSV export.
- [ ] Live permanent preview deletion/pause check: pending action-time user consent; automated regressions pass.
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
- [x] Version-one local Outlook import and production Sheets read/replay have live evidence. Production records needing review remain owner work; future Graph acceptance is outside version one.
- [x] October 10 local Outlook automation: service-token boundaries and Bitwarden verified; PRs #10/#11 deployed; bounded message/Sheets continuations completed; both stale runs closed; unchanged replay and on-demand Task Scheduler run passed with result 0. Daily 07:00 Pacific and delayed logon task enabled; server cron, Graph and AI remain disabled. See QA for evidence and future trigger limitations.

## Publication and operation

The owner authorized the guarded Outlook release and subsequent safe live cleanup on October 11. Record this release's actual results separately from the historical version-one checks below. Required acceptance includes supported restore fidelity, current eligible-action inventory, complete generation-bound capture, exact private action review, verified backups, post-action reconciliation and restoration of the prior scheduled-task state. Merge and deployment authorization is now present; failed or missing provider checks still block mailbox actions.

- [x] Owner authorized GitHub source publication and a brief reviewed PR. Do not add Codex/Copilot coauthors.
- [x] Owner authorized merge/deployment; ENABLE_DEPLOYMENTS=true saved after GitHub verification.
- [x] [Production workflow](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/37138746361) succeeded; authenticated About/Overview passed and 16 applications remained intact. SYNC_ENABLED remains false.
- [x] Preview owner deployment approval required and administrator bypass disabled; exact reviewed commit checked before approval.
- [ ] Future optional AI activation: verify free-only account behavior and hard quotas first; AI remains disabled with $0 paid limit.
- [x] Historical version-one GPT-6 Luna QA review completed, with concrete findings fixed and rechecked. Subsequent planning and validating QA follow the Sol high model requirements in [AGENTS.md](../AGENTS.md) and the [agent protocol](agent-protocol.md); this historical check is not acceptance of later changes.

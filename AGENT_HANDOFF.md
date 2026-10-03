# Agent handoff — October 2, 2026

Resume in `C:\GitHub\Apps\job-search-intelligence`, branch `bfarmer/scaffold-foundation`. Environment cwd may still point to portfolio; always set workdir.

## Authorization and decisions

The owner authorized GitHub/Cloudflare deployment authentication, a commit and push on the current `bfarmer/*` branch, and a brief PR. Never add Codex/Copilot coauthors. Microsoft Entra/Graph is outside version one and remains disabled at runtime. Paid AI budget $0; start September 30, 2026 midnight Pacific (`2026-09-30T07:00:00Z`). No email sending or tracker write-back. Separate QA agents must be cost-effective.

Section 21 of `Job_Intelligence_Architecture_and_Implementation_Plan.md` is the canonical todo/acceptance tracker. Read AGENTS.md, docs/architecture.md, docs/deployment.md, docs/qa.md and docs/release-checklist.md before changes.

## Completed and validated

Private dashboard, owner JWT/origin enforcement, classic-Outlook COM import, Sheets reader, rules/optional capped AI, reconciliation/manual audit, durable Workflow, analytics/follow-ups and privacy controls are implemented and deployed. The future delegated read-only OAuth/Graph path remains implemented and tested but is gated off in the API, workflow and UI for version one. Both remote migrations applied. Isolated resources and owner Access/custom SSL domains configured.

Final full quality passes: 322 tests (96 backend/196 frontend/12 shared/18 guard), all four coverage metrics above 85%, 0% duplication, zero lint warnings/dependency audit findings. The current PR review findings have fixes for Outlook export syntax, status defaults, merge event history, configured AI model use, skipped-run finish times, and stale documentation. An obsolete untracked test targeting the removed dashboard page was preserved under ignored `tmp/`. First production fallback import processed all 76 bounded messages and produced two canonical applications. The broad first pass was tightened to 65 prospective matches; existing uncertain records remain for owner review. Google initial sync changed 15 tracker rows and the immediate replay reported all 15 unchanged. Private exports and the downloaded Google credential were removed.

Current deployments, resource IDs, browser evidence and rollback versions are recorded in plan section 21/docs/qa.md. Latest Pages: test 3025be04, production 445f4028; Workers test 84e345d6-3fd0-4186-8864-925df379e6a0 / production 4ef1a952-c717-4c40-8bb7-4b346135cc15.

PR #1 is open from `bfarmer/scaffold-foundation`. Hosted quality and CodeQL pass with zero open CodeQL or Dependabot alerts. The dedicated 90-day Cloudflare deployment token is stored in both protected GitHub environments; `ENABLE_DEPLOYMENTS=false` keeps deployment jobs disabled.

## Remaining work and blockers

1. Microsoft Entra/Graph is deferred beyond version one. Do not make directory access or Graph consent a version-one release dependency. The local Outlook path is operational; future Graph code remains limited to read-only User.Read/Mail.Read/offline_access and is gated by `MICROSOFT_GRAPH_ENABLED=false`.
2. Google is complete. The production-only secret belongs to the unprivileged reader with Viewer access only to the identified tracker; no downloaded credential remains. Initial read changed 15 rows and immediate replay reported 15 unchanged. Preview has no production tracker access.
3. Production has 65 local-email reconciliation records, most requiring owner review; two canonical applications were created before the tracker import. Browser 200% zoom and exhaustive date/review/correction/merge/export/deletion actions remain open.
4. Migration `0003_normalize_application_status.sql` passed locally but still needs application to preview and production D1 during a separately authorized deployment.

Keep SYNC_ENABLED=false, AI_ENABLED=false, AI_DAILY_CALL_LIMIT=0 and ENABLE_DEPLOYMENTS=false until their relevant acceptance/authorization conditions are met.

## Resuming browser work

Use the computer-use skill; after summary call `cua.rewriteDocumentation`. Reuse Chrome browser ID 3. Google setup is complete. Tab IDs can become stale; recover only in the selected browser. Re-mark pending tabs as handoffs before ending a new turn.

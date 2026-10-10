# Job search intelligence

Private owner dashboard for Outlook job-search evidence and a read-only Google Sheets application tracker. Cloudflare Pages, Workers, Workflows and D1 provide separate test/production environments. The npm workspaces follow the portfolio architecture: React/Vite frontend, Worker/D1 backend and serializable shared contracts.

Version one includes owner authorization, the local classic-Outlook export/import path, read-only tracker sync, rules-first classification, auditable reconciliation/corrections, analytics/timelines, follow-up recommendations, durable ETL and privacy controls. The local Outlook path and Google tracker reader completed their first production imports. Microsoft Graph remains implemented and tested behind `MICROSOFT_GRAPH_ENABLED=false` for a later unattended Outlook release; its routes, workflow reads and UI controls are unavailable in version one. Scheduled imports and AI are paused; paid AI budget is $0.

Development occurs on `bfarmer/scaffold-foundation`. GitHub Actions run the same quality gates and CodeQL before any merge, while Cloudflare environment protection keeps deployments disabled until release acceptance.

## Local commands

Use Node 24.19+ (below 25) and npm 11.

```sh
npm ci
npm run db:migrate:local
npm run dev
npm run quality
```

Local private routes fail closed until real Access is configured; there is no development owner bypass. Integration tests use synthetic fixtures and SQLite-backed D1 semantics. `npm run build` builds frontend assets and dry-runs the Worker without publishing. Never copy production credentials/data into local or preview.

Quality gates require zero lint warnings, a PowerShell parse check and self-test of the Windows scripts, at least 85% statements/branches/functions/lines in each suite, duplication below 3%, fresh Worker types, strict TypeScript, builds/migrations and zero reported dependency audit vulnerabilities. Local audit cannot prove the absence of every security defect. GitHub CodeQL must run on published source before release.

Read [the execution tracker](Job_Intelligence_Architecture_and_Implementation_Plan.md), [architecture](docs/architecture.md), [local Outlook fallback](docs/outlook-local-fallback.md), [deployment](docs/deployment.md), [QA evidence](docs/qa.md), [release checklist](docs/release-checklist.md), and [handoff](AGENT_HANDOFF.md).

# Job search intelligence

Private owner dashboard for Gmail job-search evidence and a read-only Google Sheets application tracker. Cloudflare Pages, Workers, Workflows and D1 provide separate test/production environments. The npm workspaces follow the portfolio architecture: React/Vite frontend, Worker/D1 backend and serializable shared contracts.

The Gmail pivot adds personal OAuth with the exact `gmail.readonly` scope, label-restricted discovery, durable bounded checkpoints, replay-safe canonical aliases and conservative Review handling. Outlook.com supplies only selective server-side redirects; the application has one future mailbox reader. Existing Outlook evidence stays preserved during cutover, while Microsoft Graph, application AI and scheduled imports remain disabled. Paid AI budget is $0.

Current Gmail work occurs on `bfarmer/gmail-ingestion-pivot`. GitHub Actions run the same quality gates and CodeQL before merge. Provider acceptance and schedule activation remain separate from source checks.

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

Read [the execution tracker](Job_Intelligence_Architecture_and_Implementation_Plan.md), [architecture](docs/architecture.md), [Gmail cutover record](docs/gmail-cutover.md), [Gmail routing plan](docs/gmail-routing-plan.md), [Gmail ingestion plan](docs/gmail-ingestion-plan.md), [deployment](docs/deployment.md), [QA evidence](docs/qa.md), and [release checklist](docs/release-checklist.md).

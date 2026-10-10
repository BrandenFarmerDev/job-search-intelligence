# Deployment and provider setup

PR #1 and deployment fix PR #3 are merged into main. The owner authorized merge and production deployment on October 3; GitHub verification succeeded and `ENABLE_DEPLOYMENTS=true` is saved. Scheduled sync, AI and Graph remain disabled. Preview and production now run final reviewed code; both GitHub deployments and authenticated production health passed.

## Resource inventory

Cloudflare account: `712adbcc6c4efdf86433da200b135398`. All resources are dedicated to this project.

| Environment | Frontend | API | D1 | Workflow |
| --- | --- | --- | --- | --- |
| Test | https://jobs-test.brandenfarmer.com | https://jobs-api-test.brandenfarmer.com | `98748289-ff68-43b3-8cbe-5bf30d0e04bf` | `job-intelligence-sync-preview` |
| Production | https://jobs.brandenfarmer.com | https://jobs-api.brandenfarmer.com | `9edee823-6086-4f4c-b544-cbf35bb03f3d` | `job-intelligence-sync-production` |

Worker names: `job-search-intelligence-api-preview` / `job-search-intelligence-api`. Migrations 0001–0003 are applied remotely to both isolated databases. On October 3, both reported schema version 3, the normalization trigger, and zero legacy `submitted` statuses; application counts were unchanged. Encryption keys are unique 256-bit Worker secrets. Scheduled imports remain disabled (`SYNC_ENABLED=false`) despite the configured 14:00 UTC cron.

Direct Upload Pages project: `job-search-intelligence`, production branch `main`; no Git integration. The test domain has a **proxied** CNAME to `preview.job-search-intelligence.pages.dev`, production to `job-search-intelligence.pages.dev`. Do not accidentally point test to production. [Cloudflare branch-domain instructions](https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/).

Access team: `cold-union-464d.cloudflareaccess.com`. Test app `edb7d94d-dac3-4b2f-ae5d-6e2f06c78b90`, production app `243a269b-a9da-4adb-926d-6a783bd58a5e`. Both reuse owner-email-only policy `2f08f97a-f619-47d4-abd1-dbe6ca15a943`. Test and production audiences are distinct and checked in backend config. CORS allows only the corresponding frontend origin with credentials and the required methods/Content-Type. Secure HTTP-only Access cookies and eager redirects support API sign-in across the two hosts. Both Pages default/wildcard hostnames are also protected. workers.dev/version preview URLs are disabled.

AI Gateways: `job-intelligence-preview` / `job-intelligence-production`, authenticated, logs/cache off and zero-data retention. AI is disabled with a zero daily cap. Do not activate paid usage, upgrade a billing plan, or infer a shared free quota remains available without checking.

## Google: production reader complete

Owner accepted first-use terms. Google project `premium-fuze-510400-n4` exists and Sheets API is enabled. Production identity:
`job-tracker-production-reader@premium-fuze-510400-n4.iam.gserviceaccount.com`.
It has no project IAM roles. Its JSON key was provisioned only as production Worker secret `GOOGLE_SERVICE_ACCOUNT_JSON`; the downloaded copy was deleted. The identity has Viewer access only to tracker `1klnHRC-edPKrC5FYGfHj2_NnH2aHNW0H2bqq9B_BQqk`.

Production range is `'Branden Farmer Job Application Tracker'!A1:O1000`, mapping all 15 inspected headers. The first authenticated run changed 15 rows; immediate replay changed 0 and reported 15 unchanged. Test must never receive this production identity or tracker access. Use synthetic fixtures or a separate synthetic sheet and separate credentials. Pausing/deleting app records does not revoke the external key; rotate or revoke it in Google Cloud when retiring access.

A chat connector grant cannot be used as unattended Worker credentials. Pausing/deleting app records does not revoke this external service-account key.

## Microsoft Graph: deferred after version one

Version one uses the owner-run classic Outlook export and does not require Microsoft Entra, Azure or Graph. `MICROSOFT_GRAPH_ENABLED=false` in every checked-in environment removes the connection routes from the version-one API, skips Graph reads in the Workflow and hides Graph controls in the frontend. Keep the client ID empty and do not provision `MICROSOFT_CLIENT_SECRET` for this release.

The future Graph path remains implemented and tested so it can be activated through a separately reviewed release. Do not silently switch mailboxes, create a paid subscription, or request Mail.Send.

Once the owner supplies a usable directory:

1. Register an application supporting personal Microsoft accounts; the implemented authority is `consumers`. Prefer isolated test/production registrations.
2. Add Web redirect URLs matching each API's `/api/job-intelligence/connections/microsoft/callback`.
3. Use only delegated `User.Read` and `Mail.Read` plus OAuth `offline_access`; no application mailbox-wide permission or Mail.Send.
4. Put client ID in that environment's vars, client secret only in Worker secret `MICROSOFT_CLIENT_SECRET`. Existing per-environment `TOKEN_ENCRYPTION_KEY` protects refresh tokens; do not regenerate a key after credentials are stored without a migration/rotation plan.
5. Historical start is September 30, 2026 midnight Pacific: `2026-09-30T07:00:00Z`. Connect via the owner UI and verify backfill, repeated delta, move/removal, refresh/disconnect and retention against controlled examples.
6. Enable scheduled sync only after both provider acceptance and release checks pass.

## Outlook upload automation (production only)

Owner decision, October 10, 2026 (details in [local Outlook fallback](outlook-local-fallback.md)). Preview stays without automation: leave `AUTOMATION_CLIENT_ID` unset there. No client ID, token or secret belongs in the repository, workflows or these docs.

1. The owner creates an Access service token (1 year) in Zero Trust > Access > Service credentials and adds a **Service Auth** policy that includes only that token to the production Access application. The owner-email policy is not changed. The token secret is typed only into `outlook-automation.ps1 -SetupCredential` on the PC.
2. After the code is deployed, set the non-secret client ID as a Worker secret: `wrangler secret put AUTOMATION_CLIENT_ID --env production`. It is declared in `env.d.ts`, not in `wrangler.jsonc`, so `npm run cf:types` output is unchanged. While it is unset, every service-token request is rejected (fail closed).
3. Accept live, in order: no headers gives the Access login redirect; the token on `GET /dashboard` gives 403 `automation_route_forbidden`; the token with an `Origin` header gives 403; a wrong secret is rejected by Access; the installed script run directly queues a sync (202) and the latest `sync_runs` row has `trigger='automation'` and `status='completed'`; an immediate re-run leaves message counts stable and the application count does not drop (read-only D1 counts and run metadata only). Paused behaviour is verified by unit tests only; production is not paused for the test. Then enable the task with `register-outlook-automation-task.ps1 -Enable`.
4. `SYNC_ENABLED` stays `false`, so the server cron does not run; `AI_ENABLED=false`, `AI_DAILY_CALL_LIMIT=0` and `MICROSOFT_GRAPH_ENABLED=false` are unchanged.
5. Revocation: delete the token (or its policy) in Zero Trust, unset the Worker secret, and unregister the task.

## GitHub administration

Repository: `BrandenFarmerDev/job-search-intelligence`. Main ruleset `24341809` was copied from portfolio `24193519`: PR required, updated branch, required `Quality gates` and `Analyze JavaScript and TypeScript`, no force push/deletion or bypass.

Preview/production environments limit branches to `bfarmer/*` / `main`. Preview additionally requires owner `BrandenFarmerDev` approval before secrets become available, with administrator bypass disabled. The sole owner may approve their own deliberately reviewed run; approval must follow code/security review because the token permissions cover account resources. Exact environment variables and account-ID secrets are configured:

| Entry | Type |
| --- | --- |
| CLOUDFLARE_API_TOKEN | Dedicated deployment secret in each protected environment |
| CLOUDFLARE_ACCOUNT_ID | Secret; configured |
| CLOUDFLARE_PAGES_PROJECT | Variable; job-search-intelligence |
| VITE_API_BASE_URL | Variable; exact environment API origin |
| SITE_ORIGIN | Variable; exact environment frontend origin |

The dedicated deployment token has Workers Scripts/D1/Pages write permission and expires December 31, 2026. It is stored only as `CLOUDFLARE_API_TOKEN` in the protected preview and production environments. These scopes cover those resource types account-wide. Do not reuse portfolio credentials. Existing configured custom domains should not need route changes during a code-only deployment; adding/changing connections requires additional zone permission. [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/).

Secret scanning and push protection are enabled; Actions defaults to read-only and cannot approve PRs. Dependabot vulnerability alerts are enabled with no open alerts, while automatic security updates remain disabled to match the portfolio repository. Local CI/CodeQL workflow files are pinned and actionlint-clean. Hosted quality and CodeQL pass on PR #1 with no open findings.

## Deploy and recover

Run `npm ci`, `npm run quality`, named dry runs and release checklist before deploying. Apply additive D1 migrations, deploy Worker, build frontend with the exact API origin, and upload Pages with `--branch preview` or `--branch main`. Preview can be deployed directly without pushing local source to GitHub.

GitHub workflow checks isolated database IDs/exact origins/dedicated project, deploys Worker before Pages, then verifies **unauthenticated Access login challenges** on the custom site/API. It does not falsely treat an Access redirect as a passing application health response. Authenticated browser/application smoke remains a release requirement.

No destructive DB rollback is automated. Record prior Worker/Pages versions, roll back compatible code via Cloudflare deployment controls, and use D1 Time Travel/manual recovery only under an explicit reviewed recovery plan. Preserve backwards-compatible contracts during Worker-before-Pages deployment.

## October 3 deployment follow-up

PR #1 merged as `bcbf6b0` after hosted quality/CodeQL passed. Production run [37137725830](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/37137725830) stopped before any Cloudflare change: deployment guard received empty secret values despite both secrets being present in the protected production environment. Follow-up branch `bfarmer/deployment-secret-wiring` binds deployment directly to its protected environment as a regular CI job, avoiding the observed reusable-workflow secret-resolution failure. Deployment steps, branch restrictions, permissions and the fail-closed guard remain in place; no broad secret inheritance is introduced. Both GitHub deployments subsequently passed; verified versions and workflow evidence follow.

## Verified release — October 3, 2026

PR #1 and the reviewed deployment fix in PR #3 are merged. [Production workflow](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/37138746361) and [preview workflow](https://github.com/BrandenFarmerDev/job-search-intelligence/actions/runs/37138507982) passed quality, resource/origin guards, the additive migration check (none pending), Worker deployment, Pages upload and anonymous Access verification using the dedicated GitHub token. The first production attempt stopped before mutations; the regular environment-bound job fixes its secret-resolution failure.

Production Worker `f143dd81-7865-45a2-81ff-9f44cb79d46a`, Pages `e04e088b`; preview Worker `d0af18d5-1947-42a7-9db5-816dc10cdc35`, Pages `1ceadd05`. Compatible pre-release rollback: production Worker `4ef1a952-c717-4c40-8bb7-4b346135cc15` / Pages `445f4028`; preview Worker `21a3a561-f2d6-4eb4-839b-4fd312adb6ae` / Pages `34363a79`.

Authenticated production About reports API connected and the final dashboard loads 16 applications; read-only D1 count remained 16 before/after deployment. Inspected application console has no warnings/errors. Logs confirm SYNC_ENABLED=false, AI_ENABLED=false, AI_DAILY_CALL_LIMIT=0 and MICROSOFT_GRAPH_ENABLED=false. Preview environment requires owner approval with administrator bypass disabled; its waiting job was released only after checking reviewed commit `db60be7`. The token still has account-wide resource-type permissions, so every future preview approval must review the exact ref/commit.

Limits: live permanent preview deletion remains consent-pending; its automated regressions pass. Production uncertainty review is owner work. Future Graph and optional free-only AI activation require separate acceptance; no paid AI or email sending is enabled.

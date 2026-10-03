# Project working agreement

- Work on a descriptive `bfarmer/*` branch. Pushes to the current development branch and updates to PR #1 are authorized. Merge and deployment require separate release authorization.
- Follow the existing npm workspace boundaries: React/Vite in `app/frontend`, Worker/D1 in `app/backend`, serializable contracts in `packages/shared`. Keep secrets and private integration logic in the backend.
- Keep this owner application private behind Access and server-side owner authorization. Test data must be synthetic and isolated from production and portfolio data. Provider acceptance is separate from implemented/tested code.
- Owner decisions: source publication on the current `bfarmer/*` branch, a brief PR, and GitHub/Cloudflare deployment authentication are authorized. Microsoft Entra/Graph is outside version one and must remain disabled at runtime; preserve it only as a documented future path. Historical start is September 30, 2026 midnight Pacific; paid AI budget is $0. Scheduled imports, AI, and automatic deployment stay disabled until their release checks are accepted.
- Run `npm run quality` before handoff. Keep all four coverage metrics at least 85% in each suite, duplication below 3%, lint without warnings, and dependency audit free of reported vulnerabilities. Do not waive or shrink gates to make checks pass.
- After Worker configuration changes, regenerate `npm run cf:types` and validate named environment dry-run builds. Actual deployment needs the documented setup and release checklist.
- When a QA rubber duck agent is requested, use a cost-effective model and identify concrete findings. Do not create tests that merely mirror low-impact edits.
- Do not list Codex or Copilot as a commit or PR coauthor.
- Keep architecture/setup/release documentation aligned with implemented behavior and report checks that remain unverified.

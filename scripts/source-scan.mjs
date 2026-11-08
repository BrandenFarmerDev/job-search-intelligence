import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertCleanSarif(report) {
  if (!report || report.version !== "2.1.0" || !Array.isArray(report.runs) || report.runs.length === 0) {
    throw new Error("CodeQL did not produce a valid SARIF run.");
  }
  for (const run of report.runs) {
    if (run.tool?.driver?.name !== "CodeQL" || !Array.isArray(run.results) || !Array.isArray(run.invocations) || run.invocations.length === 0
      || run.invocations.some((invocation) => invocation.executionSuccessful !== true)) {
      throw new Error("CodeQL analysis was incomplete.");
    }
    if (run.results.length > 0) throw new Error(`CodeQL reported ${run.results.length} unresolved source findings. Review the SARIF report.`);
  }
}

export function scanSource(binary = process.env.CODEQL_BINARY || "codeql") {
  mkdirSync("reports", { recursive: true });
  // A fresh database prevents stale analysis from passing a changed candidate.
  const directory = mkdtempSync(resolve("reports", "codeql-"));
  const database = resolve(directory, "database");
  const report = resolve(directory, "source.sarif");
  const run = (args) => {
    const result = spawnSync(binary, args, { stdio: "inherit", shell: false });
    if (result.error) throw new Error(`Cannot execute CodeQL: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`CodeQL failed (exit ${result.status}). Source security is UNVERIFIED.`);
  };
  console.info(`CodeQL evidence: ${directory}`);
  run(["database", "create", database, "--language=javascript-typescript", "--build-mode=none",
    `--source-root=${process.cwd()}`, "--codescanning-config=.github/codeql-config.yml"]);
  run(["database", "analyze", database, "codeql/javascript-queries@2.4.7:codeql-suites/javascript-security-extended.qls",
    "--download", "--format=sarifv2.1.0", `--output=${report}`, "--threads=2"]);
  assertCleanSarif(JSON.parse(readFileSync(report, "utf8")));
  console.info("CodeQL: zero unresolved source findings.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { scanSource(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

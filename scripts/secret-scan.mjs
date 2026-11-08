import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertCleanSecrets(report) {
  if (!Array.isArray(report)) throw new Error("Gitleaks omitted its findings report.");
  if (report.length) throw new Error(`Gitleaks reported ${report.length} unresolved findings.`);
}
export function scanSecrets(paths, binary = process.env.GITLEAKS_BINARY || "gitleaks") {
  if (!paths.length) throw new Error("At least one scan path is required.");
  for (const path of paths) { if (!statSync(path).isDirectory() && !statSync(path).isFile()) throw new Error("Scan target is not a file or directory."); }
  mkdirSync("reports/security", { recursive: true });
  paths.forEach((path, index) => {
    const report = resolve(`reports/security/secrets-${index}.json`);
    rmSync(report, {force:true});
    const result = spawnSync(binary, ["dir", "--config", ".gitleaks.toml", "--redact", "--no-banner", "--no-color", "--report-format", "json", "--report-path", report, path], {stdio:"inherit",shell:false});
    if (result.error || result.status !== 0) throw new Error("Gitleaks failed. Secret security is UNVERIFIED or has unresolved findings; inspect the redacted report.");
    assertCleanSecrets(JSON.parse(readFileSync(report,"utf8")));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { scanSecrets(process.argv.slice(2)); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}

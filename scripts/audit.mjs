import { spawnSync } from "node:child_process";

// npm's audit-level setting has no "none" option. Fail on every reported severity.
const result = spawnSync(process.execPath, [process.env.npm_execpath, "audit", "--json"], { encoding: "utf8" });
if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
if (report.error || !report.metadata?.vulnerabilities) throw new Error("Dependency audit did not return a valid report.");
const vulnerabilities = report.metadata.vulnerabilities;
console.log("Dependency vulnerabilities:", vulnerabilities);
if (result.status !== 0 || vulnerabilities.total !== 0) process.exitCode = 1;

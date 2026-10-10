import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

// Parse-checks every scripts/*.ps1 and runs the automation script's -SelfTest with each PowerShell engine found
// (pwsh on CI, plus Windows PowerShell 5.1 locally, which is the engine the scheduled job uses).
const directory = resolve("scripts");
const files = readdirSync(directory).filter((name) => name.endsWith(".ps1")).sort().map((name) => join(directory, name));
const engines = ["pwsh", "powershell.exe"].filter((name) => spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);
if (!engines.length) {
  // CI runners ship pwsh, so a missing engine there is a broken gate, not a reason to skip.
  console.log(`PowerShell check ${process.env.CI ? "failed" : "skipped"}: neither pwsh nor powershell.exe is available.`);
  process.exit(process.env.CI ? 1 : 0);
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const parse = `$bad = 0; foreach ($file in @(${files.map(quote).join(",")})) { $tokens = $null; $errors = $null; [void][Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors); foreach ($e in $errors) { $bad++; [Console]::Error.WriteLine(("{0}:{1}: {2}" -f $file, $e.Extent.StartLineNumber, $e.Message)) } }; if ($bad) { exit 1 }`;
let failed = false;
for (const engine of engines) {
  const base = ["-NoProfile", "-NonInteractive"];
  const policy = process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : [];
  const steps = [["parse", [...base, "-Command", parse]], ["self-test", [...base, ...policy, "-File", join(directory, "outlook-automation.ps1"), "-SelfTest"]]];
  for (const [label, args] of steps) {
    const result = spawnSync(engine, args, { encoding: "utf8" });
    const ok = result.status === 0;
    console.log(`${engine} ${label}: ${ok ? "ok" : `failed (exit ${result.status})`}${ok ? "" : `\n${result.stdout}${result.stderr}`}`);
    if (!ok) failed = true;
  }
}
console.log(`PowerShell scripts checked: ${files.map((file) => file.slice(directory.length + 1)).join(", ")}`);
if (failed) process.exitCode = 1;

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkPowerShell({ spawn = spawnSync, log = console.log, environment = process.env, platform = process.platform } = {}) {
  // Parse-checks scripts and modules and runs synthetic behavior checks with each PowerShell engine found
  // (pwsh on CI, plus Windows PowerShell 5.1 locally, which is the engine the scheduled job uses).
  const directory = resolve("scripts");
  const files = readdirSync(directory).filter((name) => /\.ps(m)?1$/.test(name)).sort().map((name) => join(directory, name));
  // An intermediate Node process inherits PS7 module paths. Let Windows PowerShell
  // construct its own paths so it cannot autoload incompatible PS7 system modules.
  const engineEnvironment = (engine) => Object.fromEntries(Object.entries(environment).filter(([key]) => engine !== "powershell.exe" || key.toUpperCase() !== "PSMODULEPATH"));
  const engines = ["pwsh", "powershell.exe"].filter((name) => spawn(name, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", env: engineEnvironment(name) }).status === 0);
  if (!engines.length) {
    log("PowerShell check failed: neither pwsh nor powershell.exe is available; mandatory checks cannot run.");
    return 1;
  }
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const parse = `$bad = 0; foreach ($file in @(${files.map(quote).join(",")})) { $tokens = $null; $errors = $null; [void][Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors); foreach ($e in $errors) { $bad++; [Console]::Error.WriteLine(("{0}:{1}: {2}" -f $file, $e.Extent.StartLineNumber, $e.Message)) } }; if ($bad) { exit 1 }`;
  let failed = false;
  for (const engine of engines) {
    const base = ["-NoProfile", "-NonInteractive"];
    const policy = platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : [];
    const steps = [["parse", [...base, "-Command", parse]], ["self-test", [...base, ...policy, "-File", join(directory, "outlook-automation.ps1"), "-SelfTest"]]];
    for (const name of ["test-api-rate-workload.ps1", "test-outlook-behavior.ps1", "test-outlook-run-lifecycle.ps1", "test-outlook-cleanup.ps1", "test-outlook-collector.ps1", "test-outlook-registration.ps1", "test-outlook-restore-state.ps1", "test-outlook-performance.ps1"]) {
      steps.push([name, [...base, ...policy, "-File", join(directory, name)]]);
    }
    if (engine === "powershell.exe") {
      steps.push(["command coverage", [...base, ...policy, "-File", join(directory, "measure-outlook-coverage.ps1")]]);
    }
    for (const [label, args] of steps) {
      const result = spawn(engine, args, { encoding: "utf8", env: engineEnvironment(engine) });
      const ok = result.status === 0;
      log(`${engine} ${label}: ${ok ? "ok" : `failed (exit ${result.status})`}${ok && label !== "command coverage" ? "" : `\n${result.stdout}${result.stderr}`}`);
      if (!ok) failed = true;
    }
  }
  if (!engines.includes("powershell.exe")) {
    log("PowerShell command coverage unmeasured: Windows PowerShell with bundled Pester 3.4.0 is unavailable.");
  }
  log(`PowerShell scripts checked: ${files.map((file) => file.slice(directory.length + 1)).join(", ")}`);
  return failed ? 1 : 0;

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = checkPowerShell();
}

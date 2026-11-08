import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validatePushState(updates, currentHead, worktreeIsClean) {
  if (updates.some(({localRef,localSha,remoteRef,remoteSha}) => !/^refs\/heads\/bfarmer\/[A-Za-z0-9._/-]+$/.test(localRef) || !/^refs\/heads\/bfarmer\/[A-Za-z0-9._/-]+$/.test(remoteRef) || !/^[a-f0-9]{40}$/.test(localSha) || !/^[a-f0-9]{40}$/.test(remoteSha))) return "Malformed or unauthorized branch ref.";
  if (updates.length === 0) return "No refs were supplied for validation.";
  if (!worktreeIsClean) return "The worktree must be clean before a push can be validated.";
  if (updates.some(({ localSha }) => localSha === "0".repeat(40))) {
    return "Deleting remote refs is not supported by the quality gate.";
  }
  if (updates.some(({ localSha }) => localSha !== currentHead)) {
    return "Every ref in one push must point to the tested HEAD commit.";
  }
  return undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function main() {
  const updates = readFileSync(0, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(/\s+/);
    if (fields.length !== 4) throw new Error("Malformed publication ref record.");
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    return { localRef, localSha, remoteRef, remoteSha };
  });
  const head = run("git", ["rev-parse", "HEAD"]);
  if (head.status !== 0) throw new Error("Could not resolve HEAD.");
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error("Could not inspect the worktree.");

  const failure = validatePushState(updates, head.stdout.trim(), status.stdout.trim() === "");
  if (failure) {
    process.stderr.write(`Pre-push quality gate: ${failure}\n`);
    process.exitCode = 1;
    return;
  }

  const quality = spawnSync("npm run quality", { shell: true, stdio: "inherit" });
  if (quality.error) throw quality.error;
  const finalHead = run("git", ["rev-parse", "HEAD"]);
  const finalStatus = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (finalHead.status !== 0 || finalStatus.status !== 0 || finalHead.stdout !== head.stdout || finalStatus.stdout.trim()) throw new Error("HEAD or worktree changed during validation.");
  for (const {localRef,localSha} of updates) {
    const target = run("git", ["rev-parse", localRef]);
    if (target.status !== 0 || target.stdout.trim() !== localSha) throw new Error("Publication ref changed during validation.");
  }
  process.exitCode = quality.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

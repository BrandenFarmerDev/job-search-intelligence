import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
chmodSync(".githooks/pre-push", 0o755);
const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {stdio:"inherit"});
if (result.error || result.status !== 0) throw new Error("Cannot install the required pre-push hook.");

import { readFileSync } from "node:fs";

const headers = readFileSync(new URL("../dist/_headers", import.meta.url), "utf8");
for (const required of [
  "Content-Security-Policy:",
  "Cross-Origin-Opener-Policy: same-origin",
  "Permissions-Policy:",
  "Referrer-Policy: no-referrer",
  "Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
]) {
  if (!headers.includes(required)) throw new Error(`Built Pages headers are missing ${required}`);
}

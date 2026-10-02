import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("app/backend/wrangler.jsonc", "utf8"));
const settings = config.env[process.env.DEPLOY_ENVIRONMENT];
for (const target of [process.env.SITE_ORIGIN, `${process.env.VITE_API_BASE_URL}/api/job-intelligence/dashboard`]) {
  const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(20000) });
  const location = new URL(response.headers.get("location") || "https://invalid.example");
  if (response.status !== 302 || location.protocol !== "https:" || location.hostname !== settings.vars.ACCESS_TEAM_DOMAIN
    || !location.pathname.startsWith("/cdn-cgi/access/login/") || location.searchParams.get("kid") !== settings.vars.ACCESS_AUD) {
    throw new Error("Private deployment did not present its expected Access login challenge.");
  }
}
console.log("Site and API require the configured owner Access application.");

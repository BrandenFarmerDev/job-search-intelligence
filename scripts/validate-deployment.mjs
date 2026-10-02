import { readFileSync } from "node:fs";
import { validateDeployment } from "./deployment-config.ts";

// wrangler.jsonc intentionally uses JSON syntax so the guard needs no parser dependency.
const config = JSON.parse(readFileSync("app/backend/wrangler.jsonc", "utf8"));
validateDeployment(config, process.argv[2], process.env);
console.log("Deployment configuration is ready.");

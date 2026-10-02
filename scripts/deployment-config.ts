export interface DeploymentConfig {
  env: Record<string, {
    vars: { ALLOWED_ORIGIN: string };
    d1_databases: { database_id: string }[];
  }>;
}

export function validateDeployment(config: DeploymentConfig, environment: string, variables: Record<string, string | undefined>) {
  if (!["preview", "production"].includes(environment)) throw new Error("Invalid deployment environment.");
  const settings = config.env[environment];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const databaseId = settings.d1_databases[0].database_id;
  if (!uuid.test(databaseId) || databaseId.startsWith("00000000-")) throw new Error("Set the environment's real D1 database ID.");
  const otherEnvironment = environment === "preview" ? "production" : "preview";
  if (databaseId === config.env[otherEnvironment].d1_databases[0].database_id) throw new Error("Preview and production must use different D1 databases.");
  const site = new URL(settings.vars.ALLOWED_ORIGIN);
  if (!variables.VITE_API_BASE_URL) throw new Error("Missing VITE_API_BASE_URL.");
  const api = new URL(variables.VITE_API_BASE_URL);
  if (site.protocol !== "https:" || site.origin !== settings.vars.ALLOWED_ORIGIN
    || api.protocol !== "https:" || api.origin !== variables.VITE_API_BASE_URL) {
    throw new Error("Site and API configuration must contain exact HTTPS origins without paths.");
  }
  if (variables.SITE_ORIGIN !== site.origin) throw new Error("SITE_ORIGIN must match the Worker's allowed origin.");
  if (variables.CLOUDFLARE_PAGES_PROJECT !== "job-search-intelligence") throw new Error("Use this application's dedicated Pages project.");
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (!variables[name]?.trim()) throw new Error(`Missing deployment secret ${name}.`);
  }
}

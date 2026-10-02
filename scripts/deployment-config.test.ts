import { describe, expect, it } from "vitest";
import { validateDeployment } from "./deployment-config";

const database = (database_id: string) => ({ database_id });
function configuration() {
  return { env: {
    preview: { vars: { ALLOWED_ORIGIN: "https://preview.example.com" }, d1_databases: [database("11111111-1111-4111-8111-111111111111")] },
    production: { vars: { ALLOWED_ORIGIN: "https://example.com" }, d1_databases: [database("22222222-2222-4222-8222-222222222222")] },
  } };
}
const variables = { VITE_API_BASE_URL: "https://api.example.com", SITE_ORIGIN: "https://preview.example.com", CLOUDFLARE_PAGES_PROJECT: "job-search-intelligence", CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token" };

describe("deployment readiness guard", () => {
  it.each(["preview", "production"])("accepts independent configured %s resources", (environment) => {
    expect(() => validateDeployment(configuration(), environment, { ...variables, SITE_ORIGIN: configuration().env[environment as "preview" | "production"].vars.ALLOWED_ORIGIN })).not.toThrow();
  });
  it("rejects invalid environments", () => expect(() => validateDeployment(configuration(), "other", variables)).toThrow("environment"));
  it.each(["REPLACE_WITH_PREVIEW_D1_ID", "00000000-0000-0000-0000-000000000001"])("rejects placeholder database %s", (id) => {
    const config = configuration();
    config.env.preview.d1_databases[0].database_id = id;
    expect(() => validateDeployment(config, "preview", variables)).toThrow("real D1");
  });
  it("rejects shared preview and production databases", () => {
    const config = configuration();
    config.env.preview.d1_databases = config.env.production.d1_databases;
    expect(() => validateDeployment(config, "preview", variables)).toThrow("different D1");
  });
  it.each(["http://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com/"])("rejects site origin %s", (origin) => {
    const config = configuration();
    config.env.preview.vars.ALLOWED_ORIGIN = origin;
    expect(() => validateDeployment(config, "preview", variables)).toThrow("HTTPS origins");
  });
  it.each(["http://api.example.com", "https://api.example.com/path", "https://api.example.com/"])("rejects API origin %s", (origin) => {
    expect(() => validateDeployment(configuration(), "preview", { ...variables, VITE_API_BASE_URL: origin })).toThrow("HTTPS origins");
  });
  it("rejects the portfolio Pages project", () => {
    expect(() => validateDeployment(configuration(), "preview", { ...variables, CLOUDFLARE_PAGES_PROJECT: "branden-farmer-portfolio" })).toThrow("dedicated Pages");
  });
  it("rejects a site origin that differs from Worker CORS", () => {
    expect(() => validateDeployment(configuration(), "preview", { ...variables, SITE_ORIGIN: "https://wrong.example.com" })).toThrow("must match");
  });
  it("requires an API origin", () => {
    expect(() => validateDeployment(configuration(), "preview", { ...variables, VITE_API_BASE_URL: undefined })).toThrow("Missing VITE_API_BASE_URL");
  });
  it.each(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"])("requires %s", (name) => {
    expect(() => validateDeployment(configuration(), "preview", { ...variables, [name]: "" })).toThrow(name);
  });
});

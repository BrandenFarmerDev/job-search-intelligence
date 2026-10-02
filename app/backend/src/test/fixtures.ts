import { vi } from "vitest";
import { createTestD1 } from "./sqlite-d1";
export function fixture() {
  const database = createTestD1();
  const env: Env = { JOB_SEARCH_DB: database.db, ALLOWED_ORIGIN: "https://jobs-test.example.com", ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com", ACCESS_AUD: "owner-aud", OWNER_EMAIL: "owner@example.com",
    MICROSOFT_GRAPH_ENABLED: "true", MICROSOFT_CLIENT_ID: "client", MICROSOFT_CLIENT_SECRET: "secret", MICROSOFT_REDIRECT_URI: "https://api-test.example.com/api/job-intelligence/connections/microsoft/callback",
    TOKEN_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"), HISTORICAL_START_DATE: "2026-01-01", GOOGLE_SERVICE_ACCOUNT_JSON: "", GOOGLE_SPREADSHEET_ID: "tracker", GOOGLE_SHEET_RANGE: "Tracker!A1:O10001",
    AI_ENABLED: "false", AI_DAILY_CALL_LIMIT: "0", AI_MODEL: "test-model", AI_GATEWAY_ID: "test-gateway", SYNC_ENABLED: "false",
    AI: {run:vi.fn()} as unknown as Ai, JOB_SYNC: {create:vi.fn().mockResolvedValue({id:"test-run"})} as unknown as Workflow };
  return {env,db:database.db,close:database.close};
}
export const sheetHeaders = ["Company", "Job Title", "Requisition / Job ID", "Application URL", "Date Applied", "Application Status"];
export const sheetData = [sheetHeaders,["ExampleCo", "Engineer", "req1", "https://jobs.example.com/req1", "2026-09-01", "Applied"]];

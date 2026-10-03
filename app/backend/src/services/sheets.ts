import { importPKCS8, SignJWT } from "jose";
import type { SourceRecord, EventType } from "@job-search/shared";
import { digest, Problem, providerJson, safeLink, text } from "./security";

export interface SheetRow { key: string; hash: string; snapshot: string; record: SourceRecord; ambiguous: boolean }
export function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
export function dateValue(value: string): string {
  const iso=value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us=value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!iso && !us) return "";
  const [year,month,day]=iso ? iso.slice(1).map(Number) : [Number(us![3]),Number(us![1]),Number(us![2])];
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year && date.getUTCMonth()===month-1 && date.getUTCDate()===day ? date.toISOString().slice(0,10) : "";
}
function sheetStatus(value: string): EventType {
  const status = normalize(value);
  if (status.includes("reject")) return "rejection";
  if (status.includes("offer")) return "offer";
  if (status.includes("interview")) return "interview_scheduled";
  if (status.includes("screen")) return "screening";
  if (status.includes("withdraw")) return "withdrawal";
  return "application_submitted";
}
export async function parseRows(values: unknown[][]): Promise<SheetRow[]> {
  if (values.length > 10001) throw new Problem(502, "sheet_row_limit");
  if (!values.length) return [];
  const headers = values[0].map((value) => normalize(text(value)));
  const get = (row: unknown[], ...names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header)); return index < 0 ? "" : text(row[index], 2000);
  };
  if (!headers.includes("company") || !headers.includes("job title") || !headers.includes("date applied")) throw new Problem(502, "sheet_headers_changed");
  const rows: SheetRow[] = [];
  for (const row of values.slice(1)) {
    if (row.every((cell) => !text(cell))) continue;
    const company = get(row, "company"); const role = get(row, "job title");
    const requisitionId = get(row, "requisition job id"); const url = safeLink(get(row, "application url"));
    const appliedAt = dateValue(get(row, "date applied")); const applicationId = get(row, "application id");
    const identity = applicationId || (requisitionId && company ? `${normalize(company)}:req:${normalize(requisitionId)}` : url || `${normalize(company)}:${normalize(role)}:${appliedAt}`);
    // A stable natural key survives reorder. Identity edits become retained tombstone + new row.
    const key = await digest(identity); const snapshot = JSON.stringify(row.map((cell) => text(cell, 2000)));
    rows.push({ key, hash: await digest(snapshot), snapshot, ambiguous: !company || !role || !appliedAt,
      record: { id: key, company, role, requisitionId, url, appliedAt, conversationId: "", applicationId, source: "sheet", status: sheetStatus(get(row, "application status")) } });
  }
  const counts = new Map<string, number>(); rows.forEach((row) => counts.set(row.key, (counts.get(row.key) || 0) + 1));
  return rows.map((row) => ({ ...row, ambiguous: row.ambiguous || counts.get(row.key)! > 1 }));
}
export async function fetchSheet(env: Env): Promise<SheetRow[]> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_SPREADSHEET_ID || !env.GOOGLE_SHEET_RANGE) throw new Problem(503, "sheets_setup_required");
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/spreadsheets.readonly" })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(account.client_email).setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt().setExpirationTime("1h").sign(await importPKCS8(account.private_key, "RS256"));
  const token = await providerJson<{ access_token: string }>("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!token.access_token) throw new Problem(502, "invalid_google_token");
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SPREADSHEET_ID)}/values:batchGet`);
  url.search = new URLSearchParams({ ranges: env.GOOGLE_SHEET_RANGE, valueRenderOption: "FORMATTED_VALUE" }).toString();
  const result = await providerJson<{ valueRanges?: { values?: unknown[][] }[] }>(url.href, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const values = result.valueRanges?.[0]?.values;
  if (!values) throw new Problem(502, "empty_sheet_response");
  return parseRows(values);
}

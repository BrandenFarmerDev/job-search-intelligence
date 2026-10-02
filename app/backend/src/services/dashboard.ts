import type { ApplicationRecord, Dashboard, SyncRun } from "@job-search/shared";
const isResponse = (type:string) => !["application_submitted", "application_confirmation", "follow_up_sent", "other_job_related"].includes(type);
export function analytics(applications: ApplicationRecord[], events: { application_id: string; type: string; occurred_at: string; date_known?: number }[], now = Date.now()) {
  const metrics: Record<string, number> = { total: applications.length, thisWeek: 0, thisMonth: 0, active: 0, responses: 0, rejections: 0, screenings: 0, interviews: 0, offers: 0, noResponse7: 0, noResponse14: 0, noResponse30: 0, followUps: 0, review: 0, firstResponseDays: 0, firstInterviewDays: 0 };
  const groups: Dashboard["groups"] = { status: {}, source: {}, company: {}, role: {}, reconciliation: {}, month: {}, responseDays: {} };
  let responseDays = 0; let interviewDays = 0; let knownResponses = 0; let knownInterviews = 0;
  for (const app of applications) {
    const age = Math.max(0, (now - Date.parse(app.applied_at)) / 86400000);
    const appEvents = events.filter((event) => event.application_id === app.id).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const response = appEvents.find((event) => isResponse(event.type));
    const interview = appEvents.find((event) => event.type.startsWith("interview_"));
    if (age <= 7) metrics.thisWeek++;
    if (new Date(app.applied_at).toISOString().slice(0, 7) === new Date(now).toISOString().slice(0, 7)) metrics.thisMonth++;
    if (!["rejection", "withdrawal", "position_closed", "offer"].includes(app.status)) metrics.active++;
    if (response) { metrics.responses++; if (response.date_known !== 0) { knownResponses++; responseDays += Math.max(0, (Date.parse(response.occurred_at) - Date.parse(app.applied_at)) / 86400000); } }
    if (interview) { metrics.interviews++; if (interview.date_known !== 0) { knownInterviews++; interviewDays += Math.max(0, (Date.parse(interview.occurred_at) - Date.parse(app.applied_at)) / 86400000); } }
    if (appEvents.some((event) => event.type === "screening")) metrics.screenings++;
    if (appEvents.some((event) => event.type === "offer")) metrics.offers++;
    if (appEvents.some((event) => event.type === "rejection")) metrics.rejections++;
    if (app.reconciliation === "needs_review" || app.reconciliation === "conflict") metrics.review++;
    if (!response && metrics.active && !["rejection", "withdrawal", "position_closed", "offer"].includes(app.status)) {
      for (const threshold of [7, 14, 30]) if (age >= threshold) metrics[`noResponse${threshold}`]++;
      if (age >= 7) metrics.followUps++;
    }
    const labels = { status: app.status, source: app.source, company: app.company, role: app.role, reconciliation: app.reconciliation,
      month: app.applied_at.slice(0, 7), responseDays: response ? response.date_known === 0 ? "Date unknown" : `${Math.floor(Math.max(0, (Date.parse(response.occurred_at) - Date.parse(app.applied_at)) / 86400000) / 7) * 7}–${Math.floor(Math.max(0, (Date.parse(response.occurred_at) - Date.parse(app.applied_at)) / 86400000) / 7) * 7 + 6} days` : "No response" };
    for (const [group, label] of Object.entries(labels)) groups[group][label] = (groups[group][label] || 0) + 1;
  }
  metrics.firstResponseDays = knownResponses ? responseDays / knownResponses : 0;
  metrics.firstInterviewDays = knownInterviews ? interviewDays / knownInterviews : 0;
  metrics.unknownResponseDates = metrics.responses - knownResponses;
  for (const field of ["responses", "rejections", "screenings", "interviews", "offers"]) metrics[`${field}Rate`] = metrics.total ? metrics[field] / metrics.total : 0;
  return { metrics, groups };
}
export async function dashboard(env: Env): Promise<Dashboard> {
  const applications = (await env.JOB_SEARCH_DB.prepare("SELECT * FROM applications WHERE excluded=0 ORDER BY applied_at DESC").all<ApplicationRecord>()).results;
  const events = (await env.JOB_SEARCH_DB.prepare("SELECT e.application_id,e.type,e.occurred_at,COALESCE(json_extract(e.evidence,'$.dateKnown'),1) AS date_known FROM application_events e LEFT JOIN reconciliation_matches r ON r.source=e.source AND r.source_id=e.source_id WHERE COALESCE(json_extract(e.evidence,'$.superseded'),0)=0 AND json_extract(e.evidence,'$.method')<>'review_required' AND COALESCE(r.state,'')<>'excluded'").all<{ application_id: string; type: string; occurred_at: string;date_known:number }>()).results;
  const microsoft = env.MICROSOFT_GRAPH_ENABLED === "true" && Boolean(await env.JOB_SEARCH_DB.prepare("SELECT provider FROM connections WHERE provider='microsoft'").first());
  const localOutlook = Boolean(await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='local_outlook_last_import'").first());
  const sheetsPaused = await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sheets_paused'").first<{ value: string }>();
  const runs = (await env.JOB_SEARCH_DB.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20").all<SyncRun>()).results;
  const followUps = applications.filter(app => !["rejection","withdrawal","position_closed","offer"].includes(app.status) && Date.now()-Date.parse(app.applied_at)>=7*86400000 && !events.some(event=>event.application_id===app.id && isResponse(event.type)))
    .map(app=>({application_id:app.id,company:app.company,role:app.role,due_at:new Date(Date.parse(app.applied_at)+7*86400000).toISOString()}));
  return { applications: applications.slice(0, 100), total: applications.length, ...analytics(applications, events), connections: { microsoft, localOutlook, sheets: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON) && sheetsPaused?.value !== "true" }, runs, followUps };
}
export function csv(applications: ApplicationRecord[]): string {
  const cell = (value: string | null) => {
    const text = value || ""; const safe = /^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [["ID", "Company", "Role", "Requisition", "Applied", "Status", "Reconciliation"], ...applications.map((app) => [app.id, app.company, app.role, app.requisition_id, app.applied_at, app.status, app.reconciliation])].map((row) => row.map(cell).join(",")).join("\r\n");
}

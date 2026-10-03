import type { ApplicationRecord, Dashboard, OutcomeCounts, SyncRun } from "@job-search/shared";
const DAY = 86400000; const WEEKS = 26; const OUTCOME_LIMIT = 50;
const isResponse = (type:string) => !["application_submitted", "application_confirmation", "follow_up_sent", "other_job_related"].includes(type);
interface AnalyticsEvent { application_id: string; type: string; occurred_at: string; date_known?: number }
interface Tally { applied: number; responses: number; screenings: number; interviews: number; offers: number; rejections: number; days: number[] }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const monday = (time: number) => { const day = Math.floor(time / DAY) * DAY; return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY; };
export function weeklyCounts(applications: ApplicationRecord[], now: number): Dashboard["weekly"] {
  const current = monday(now); const counts = new Array<number>(WEEKS).fill(0);
  for (const app of applications) { const index = (current - monday(Date.parse(app.applied_at))) / (7 * DAY); if (index >= 0 && index < WEEKS) counts[WEEKS - 1 - index]++; }
  return counts.map((count, position) => ({ weekStart: new Date(current - (WEEKS - 1 - position) * 7 * DAY).toISOString().slice(0, 10), count }));
}
// Maps plus fromEntries keep keys such as "__proto__" as ordinary data properties.
function outcomeCounts(tallies: Map<string, Tally>, limit = Infinity): Record<string, OutcomeCounts> {
  const ranked = [...tallies].sort(([first, a], [second, b]) => b.applied - a.applied || (first < second ? -1 : first > second ? 1 : 0)).slice(0, limit);
  return Object.fromEntries(ranked.map(([name, { days, ...counts }]) => [name, { ...counts, medianResponseDays: median(days) }]));
}
export function analytics(applications: ApplicationRecord[], events: AnalyticsEvent[], now = Date.now()) {
  const metrics: Record<string, number> = { total: applications.length, thisWeek: 0, thisMonth: 0, active: 0, responses: 0, rejections: 0, screenings: 0, interviews: 0, offers: 0, noResponse7: 0, noResponse14: 0, noResponse30: 0, followUps: 0, review: 0, firstResponseDays: 0, firstInterviewDays: 0 };
  const groups = new Map((["status", "source", "company", "role", "reconciliation", "month", "responseDays"] as const).map((name) => [name, new Map<string, number>()]));
  const tallies = { source: new Map<string, Tally>(), company: new Map<string, Tally>(), role: new Map<string, Tally>() };
  const byApplication = new Map<string, AnalyticsEvent[]>();
  for (const event of events) { const list = byApplication.get(event.application_id); if (list) list.push(event); else byApplication.set(event.application_id, [event]); }
  for (const list of byApplication.values()) list.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  let responseDays = 0; let interviewDays = 0; let knownResponses = 0; let knownInterviews = 0; const knownResponseDays: number[] = [];
  const thisMonth = new Date(now).toISOString().slice(0, 7);
  for (const app of applications) {
    const age = Math.max(0, (now - Date.parse(app.applied_at)) / DAY);
    const appEvents = byApplication.get(app.id) ?? [];
    const response = appEvents.find((event) => isResponse(event.type));
    const interview = appEvents.find((event) => event.type.startsWith("interview_"));
    const has = (type: string) => appEvents.some((event) => event.type === type);
    const elapsed = (event: AnalyticsEvent) => Math.max(0, (Date.parse(event.occurred_at) - Date.parse(app.applied_at)) / DAY);
    const closed = ["rejection", "withdrawal", "position_closed", "offer"].includes(app.status);
    const days = response && response.date_known !== 0 ? elapsed(response) : null;
    if (age <= 7) metrics.thisWeek++;
    if (new Date(app.applied_at).toISOString().slice(0, 7) === thisMonth) metrics.thisMonth++;
    if (!closed) metrics.active++;
    if (response) { metrics.responses++; if (days !== null) { knownResponses++; responseDays += days; knownResponseDays.push(days); } }
    if (interview) { metrics.interviews++; if (interview.date_known !== 0) { knownInterviews++; interviewDays += elapsed(interview); } }
    if (has("screening")) metrics.screenings++;
    if (has("offer")) metrics.offers++;
    if (has("rejection")) metrics.rejections++;
    if (app.reconciliation === "needs_review" || app.reconciliation === "conflict") metrics.review++;
    if (!response && metrics.active && !closed) {
      for (const threshold of [7, 14, 30]) if (age >= threshold) metrics[`noResponse${threshold}`]++;
      if (age >= 7) metrics.followUps++;
    }
    const labels = { status: app.status, source: app.source, company: app.company, role: app.role, reconciliation: app.reconciliation,
      month: app.applied_at.slice(0, 7), responseDays: response ? days === null ? "Date unknown" : `${Math.floor(days / 7) * 7}–${Math.floor(days / 7) * 7 + 6} days` : "No response" };
    for (const [group, label] of Object.entries(labels)) { const counts = groups.get(group as keyof typeof labels)!; counts.set(label, (counts.get(label) ?? 0) + 1); }
    for (const [dimension, map] of Object.entries(tallies)) {
      const name = labels[dimension as keyof typeof tallies];
      const tally = map.get(name) ?? { applied: 0, responses: 0, screenings: 0, interviews: 0, offers: 0, rejections: 0, days: [] };
      tally.applied++; if (response) tally.responses++; if (has("screening")) tally.screenings++; if (interview) tally.interviews++; if (has("offer")) tally.offers++; if (has("rejection")) tally.rejections++;
      if (days !== null) tally.days.push(days);
      map.set(name, tally);
    }
  }
  metrics.firstResponseDays = knownResponses ? responseDays / knownResponses : 0;
  metrics.firstInterviewDays = knownInterviews ? interviewDays / knownInterviews : 0;
  metrics.unknownResponseDates = metrics.responses - knownResponses;
  for (const field of ["responses", "rejections", "screenings", "interviews", "offers"]) metrics[`${field}Rate`] = metrics.total ? metrics[field] / metrics.total : 0;
  return {
    metrics, groups: Object.fromEntries([...groups].map(([name, counts]) => [name, Object.fromEntries(counts)])),
    outcomes: { source: outcomeCounts(tallies.source), company: outcomeCounts(tallies.company, OUTCOME_LIMIT), role: outcomeCounts(tallies.role, OUTCOME_LIMIT) },
    weekly: weeklyCounts(applications, now), medianFirstResponseDays: median(knownResponseDays),
  };
}
export async function dashboard(env: Env): Promise<Dashboard> {
  const applications = (await env.JOB_SEARCH_DB.prepare("SELECT * FROM applications WHERE excluded=0 ORDER BY applied_at DESC").all<ApplicationRecord>()).results;
  const events = (await env.JOB_SEARCH_DB.prepare("SELECT e.application_id,e.type,e.occurred_at,COALESCE(json_extract(e.evidence,'$.dateKnown'),1) AS date_known FROM application_events e LEFT JOIN reconciliation_matches r ON r.source=e.source AND r.source_id=e.source_id WHERE COALESCE(json_extract(e.evidence,'$.superseded'),0)=0 AND json_extract(e.evidence,'$.method')<>'review_required' AND COALESCE(r.state,'')<>'excluded'").all<{ application_id: string; type: string; occurred_at: string;date_known:number }>()).results;
  const microsoft = env.MICROSOFT_GRAPH_ENABLED === "true" && Boolean(await env.JOB_SEARCH_DB.prepare("SELECT provider FROM connections WHERE provider='microsoft'").first());
  const localOutlook = Boolean(await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='local_outlook_last_import'").first());
  const sheetsPaused = await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sheets_paused'").first<{ value: string }>();
  const runs = (await env.JOB_SEARCH_DB.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20").all<SyncRun>()).results;
  const lastSync = await env.JOB_SEARCH_DB.prepare("SELECT finished_at FROM sync_runs WHERE status='completed' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").first<{ finished_at: string }>();
  const responded = new Set(events.filter(event => isResponse(event.type)).map(event => event.application_id));
  const followUps = applications.filter(app => !["rejection","withdrawal","position_closed","offer"].includes(app.status) && Date.now()-Date.parse(app.applied_at)>=7*DAY && !responded.has(app.id))
    .map(app=>({application_id:app.id,company:app.company,role:app.role,due_at:new Date(Date.parse(app.applied_at)+7*86400000).toISOString()}));
  return { applications: applications.slice(0, 100), total: applications.length, ...analytics(applications, events), lastSuccessfulSyncAt: lastSync?.finished_at ?? null, connections: { microsoft, localOutlook, sheets: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON) && sheetsPaused?.value !== "true" }, runs, followUps };
}
export function csv(applications: ApplicationRecord[]): string {
  const cell = (value: string | null) => {
    const text = value || ""; const safe = /^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [["ID", "Company", "Role", "Requisition", "Applied", "Status", "Reconciliation"], ...applications.map((app) => [app.id, app.company, app.role, app.requisition_id, app.applied_at, app.status, app.reconciliation])].map((row) => row.map(cell).join(",")).join("\r\n");
}

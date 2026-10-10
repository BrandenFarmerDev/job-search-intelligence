import type { ApplicationRecord, Dashboard, OutcomeCounts } from "@job-search/shared";
import type { ApplicationDetail, ReviewItem } from "../lib/applications";

// Synthetic data only.
export const app: ApplicationRecord = { id: "app1", company: "ExampleCo", role: "Engineer", requisition_id: "req1", application_url: null, applied_at: "2026-09-30", status: "application_submitted", source: "sheet", reconciliation: "sheet_only", excluded: 0, updated_at: "2026-10-01" };
export const app2: ApplicationRecord = { ...app, id: "app2", company: "AnotherCo", role: "Analyst", reconciliation: "matched" };
const counts = (applied: number, responses: number, median: number | null): OutcomeCounts => ({ applied, responses, screenings: 0, interviews: 1, offers: 0, rejections: 1, medianResponseDays: median });

export const makeDashboard = (): Dashboard => ({
  applications: [app, app2], total: 4,
  metrics: { total: 4, thisWeek: 2, responses: 2, responsesRate: 0.5, interviews: 1, interviewsRate: 0.25, screenings: 1, offers: 0, review: 2 },
  groups: { status: { application_submitted: 3, rejection: 1 }, source: { sheet: 3, email: 1 }, month: { "2026-09": 3, "2026-08": 1 }, company: { ExampleCo: 4 }, role: { Engineer: 4 }, reconciliation: { sheet_only: 3, matched: 1 }, responseDays: {} },
  outcomes: { source: { sheet: counts(3, 1, null), email: counts(1, 1, 2.5) }, company: { ExampleCo: counts(3, 2, 4), AnotherCo: counts(1, 0, null) }, role: { Engineer: counts(4, 2, 4) } },
  weekly: [{ weekStart: "2026-09-21", count: 1 }, { weekStart: "2026-09-28", count: 3 }],
  medianFirstResponseDays: 3.5, lastSuccessfulSyncAt: "2026-10-01T18:30:00Z",
  connections: { microsoft: false, localOutlook: false, sheets: true },
  runs: [1, 2, 3].map((id) => ({ id: String(id), status: "failed", trigger: "manual", started_at: "2026-10-01T10:00:00Z", finished_at: "2026-10-01T10:00:12Z", error_code: "provider_request_failed", counters: "{}" })),
  followUps: [{ application_id: "app1", company: "ExampleCo", role: "Engineer", due_at: "2026-10-07T00:00:00Z" }],
});
export const makeReviews = (): ReviewItem[] => [{ id: "review1", source: "email", source_id: "source1", state: "needs_review", reason: "Ambiguous", subject: "Recruiter update", available: 0 }];
export const makeDetail = (): ApplicationDetail => ({
  application: app,
  events: [
    { id: "event1", type: "application_confirmation", occurred_at: "2026-09-30", source: "email", web_link: "https://outlook.live.com/id/1", available: 0, subject: "Evidence subject" },
    { id: "event2", type: "screening", occurred_at: "2026-10-01", source: "sheet", web_link: null, available: 1, subject: null },
  ],
  overrides: [{ field: "status", created_at: "2026-10-01" }],
});

export interface ApiState { dashboard: Dashboard; reviews: ReviewItem[]; detail: ApplicationDetail; total: number }
export const makeState = (): ApiState => ({ dashboard: makeDashboard(), reviews: makeReviews(), detail: makeDetail(), total: 63 });

// Default responses for every endpoint the app calls; tests override single paths on top.
export function apiImplementation(state: ApiState) {
  return async (path: string): Promise<unknown> => {
    if (path === "/dashboard") return state.dashboard;
    if (path === "/review") return state.reviews;
    if (path.startsWith("/applications?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      const page = Number(query.get("page") ?? 0); const pageSize = Number(query.get("pageSize") ?? 25);
      return { applications: [app, app2], page, pageSize, total: state.total, hasMore: (page + 1) * pageSize < state.total };
    }
    if (path === "/applications/app1") return state.detail;
    if (path === "/local-outlook/import") return { imported: 1 };
    return { saved: true };
  };
}

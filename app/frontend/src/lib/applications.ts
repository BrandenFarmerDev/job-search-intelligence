import { applicationSorts, eventTypes, type ApplicationRecord, type ApplicationSort, type EventType } from "@job-search/shared";
import { daysAgo } from "./format";

const stageOrder = ["Applied", "Outreach and screening", "Assessment", "Interview", "Outcome", "Other"] as const;
// A Record forces every event type in the shared taxonomy to belong to a stage.
const stageOf: Record<EventType, typeof stageOrder[number]> = {
  application_submitted: "Applied", application_confirmation: "Applied", recruiter_outreach: "Outreach and screening", screening: "Outreach and screening",
  assessment_requested: "Assessment", assessment_completed: "Assessment", interview_requested: "Interview", interview_scheduled: "Interview", interview_completed: "Interview",
  offer: "Outcome", rejection: "Outcome", withdrawal: "Outcome", position_closed: "Outcome", follow_up_sent: "Other", follow_up_received: "Other", other_job_related: "Other",
};
export const statusGroups = stageOrder.map((label) => ({ label, types: eventTypes.filter((type) => stageOf[type] === label) }));

export const sourceOptions = ["email", "sheet", "manual"] as const;
export const reconciliationOptions = ["matched", "email_only", "sheet_only", "conflict", "needs_review"] as const;
export const pageSizes = [25, 50] as const;
export type PageSize = typeof pageSizes[number];

export const filterKeys = ["q", "status", "source", "reconciliation", "from", "to", "company", "role"] as const;
export type FilterKey = typeof filterKeys[number];
export type ApplicationFilters = Record<FilterKey, string>;
export const defaultSort: ApplicationSort = "applied_desc";
export const sortLabels: Record<ApplicationSort, { option: string; summary: string }> = {
  applied_desc: { option: "Applied (newest)", summary: "applied date (newest)" },
  applied_asc: { option: "Applied (oldest)", summary: "applied date (oldest)" },
  company: { option: "Company (A to Z)", summary: "company (A to Z)" },
  status: { option: "Status", summary: "status" },
  updated: { option: "Recently updated", summary: "most recently updated" },
};

export interface ListView { filters: ApplicationFilters; sort: ApplicationSort; page: number; pageSize: PageSize }
export function readView(params: URLSearchParams): ListView {
  const filters = Object.fromEntries(filterKeys.map((key) => [key, params.get(key) ?? ""])) as ApplicationFilters;
  const page = Math.max(0, Math.min(1000, Math.floor(Number(params.get("page"))) || 0));
  return {
    filters, page,
    sort: applicationSorts.find((sort) => sort === params.get("sort")) ?? defaultSort,
    pageSize: params.get("pageSize") === "50" ? 50 : 25,
  };
}

// Empty values are omitted so the request only names the filters that are active.
export function buildApplicationsQuery(filters: Partial<ApplicationFilters>, options: { sort?: ApplicationSort; page?: number; pageSize?: number } = {}): string {
  const query = new URLSearchParams();
  for (const key of filterKeys) if (filters[key]) query.set(key, filters[key]);
  if (options.sort) query.set("sort", options.sort);
  if (options.page !== undefined) query.set("page", String(options.page));
  if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
  return query.toString();
}

export type DatePreset = "any" | "7" | "30" | "90" | "custom";
export const datePresets: { value: DatePreset; label: string }[] = [
  { value: "any", label: "Any time" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }, { value: "custom", label: "Custom range" },
];
export function presetOf({ from, to }: Pick<ApplicationFilters, "from" | "to">, now = new Date()): DatePreset {
  if (!from && !to) return "any";
  return to ? "custom" : (["7", "30", "90"] as const).find((days) => from === daysAgo(Number(days), now)) ?? "custom";
}

export interface ReviewItem { id: string; source: string; source_id: string; state: string; reason: string; subject: string | null; available: number }
export interface TimelineEvent {
  id: string; type: string; occurred_at: string; source: string; web_link: string | null; available: number; subject: string | null;
  date_known?: number; superseded?: number;
}
export interface ApplicationDetail { application: ApplicationRecord; events: TimelineEvent[]; overrides: { field: string; created_at: string }[] }
export interface ApplicationBody { company: string; role: string; applied_at: string; status: string }

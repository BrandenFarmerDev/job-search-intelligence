export const eventTypes = ["application_submitted", "application_confirmation", "recruiter_outreach", "screening",
  "assessment_requested", "assessment_completed", "interview_requested", "interview_scheduled", "interview_completed",
  "follow_up_sent", "follow_up_received", "rejection", "offer", "withdrawal", "position_closed", "other_job_related"] as const;
export type EventType = typeof eventTypes[number];
export type ReconciliationState = "matched" | "email_only" | "sheet_only" | "conflict" | "needs_review" | "excluded";
export interface ApplicationRecord {
  id: string; company: string; role: string; requisition_id: string | null; application_url: string | null;
  applied_at: string; status: string; source: string; reconciliation: ReconciliationState; excluded: number; updated_at: string;
}
export interface SourceRecord {
  id: string; company: string; role: string; requisitionId: string; url: string; appliedAt: string;
  conversationId: string; applicationId: string; source: "email" | "sheet"; status: EventType; eventAt?: string;
}
export interface Decision { type: EventType | null; confidence: number; reason: string; needsReview: boolean }
export interface Dashboard {
  applications: ApplicationRecord[]; total: number;
  metrics: Record<string, number>; groups: Record<string, Record<string, number>>;
  connections: { microsoft: boolean; sheets: boolean; localOutlook: boolean }; runs: SyncRun[];
  followUps?: {application_id:string;company:string;role:string;due_at:string}[];
}
export interface SyncRun { id: string; status: string; started_at: string; finished_at: string | null; error_code: string | null; counters: string }
export function isEventType(value: unknown): value is EventType { return typeof value === "string" && eventTypes.some((type) => type === value); }

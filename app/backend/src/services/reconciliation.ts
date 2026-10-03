import type { ApplicationRecord, SourceRecord } from "@job-search/shared";
import { normalize } from "./sheets";
import { safeLink } from "./security";
const passiveEvents=["application_confirmation","application_submitted","recruiter_outreach","follow_up_sent","follow_up_received","other_job_related"];
const lifecycle=(type:string) => type.startsWith("interview_") ? "interview" : type.startsWith("assessment_") ? "assessment" : type === "application_confirmation" ? "application_submitted" : type;
const progression:Record<string,number>={interview_requested:1,interview_scheduled:2,interview_completed:3,assessment_requested:1,assessment_completed:2};

export function matchRecord(record: SourceRecord, applications: ApplicationRecord[], conversationApplications: string[] = []) {
  const company = normalize(record.company); const role = normalize(record.role);
  const levels = [
    applications.filter((app) => record.applicationId && app.id === record.applicationId),
    applications.filter((app) => record.requisitionId && company && normalize(app.company) === company && normalize(app.requisition_id || "") === normalize(record.requisitionId)),
    applications.filter((app) => record.url && safeLink(app.application_url || "") === safeLink(record.url)),
    applications.filter((app) => conversationApplications.includes(app.id)),
    applications.filter((app) => company && role && normalize(app.company) === company && normalize(app.role) === role
      && Math.abs(Date.parse(app.applied_at) - Date.parse(record.appliedAt)) <= 30 * 86400000),
  ];
  for (let index = 0; index < levels.length; index++) {
    const candidates = levels[index];
    if (candidates.length > 1) return { application: null, state: "needs_review" as const, reason: "Ambiguous match" };
    if (candidates.length === 1) {
      const application = candidates[0];
      const conflict = (company && normalize(application.company) !== company) || (role && normalize(application.role) !== role);
      return { application, state: conflict ? "conflict" as const : "matched" as const, reason: `Match hierarchy ${index + 1}` };
    }
  }
  return { application: null, state: record.company && record.role && record.appliedAt ? record.source === "email" ? "email_only" as const : "sheet_only" as const : "needs_review" as const, reason: "No reliable match" };
}
export async function reconcile(db: D1Database, record: SourceRecord, confidence: number, needsReview: boolean) {
  const previous = await db.prepare("SELECT application_id,state,manual FROM reconciliation_matches WHERE source=? AND source_id=?").bind(record.source, record.id).first<{ application_id: string | null; state: string; manual: number }>();
  // Manual association/exclusion is durable across every resync.
  if (previous?.state === "excluded") return;
  if (previous?.application_id && (await db.prepare("SELECT excluded FROM applications WHERE id=?").bind(previous.application_id).first<{excluded:number}>())?.excluded) return;
  const all = (await db.prepare("SELECT * FROM applications WHERE excluded=0").all<ApplicationRecord>()).results;
  const conversations = record.conversationId ? (await db.prepare("SELECT DISTINCT e.application_id FROM application_events e JOIN message_references m ON e.source_id=m.id WHERE m.conversation_id=? AND e.source='email'")
    .bind(record.conversationId).all<{ application_id: string }>()).results.map((row) => row.application_id) : [];
  // An established source keeps its application when the owner later corrects fields used by heuristic matching.
  // Unreviewed candidates can still be rematched as new evidence arrives.
  const established = previous?.state !== "needs_review" && previous?.application_id
    ? all.find((application) => application.id === previous.application_id) : undefined;
  const match = matchRecord(established ? { ...record, applicationId: established.id } : record, all, conversations);
  const manuallyLinked = previous?.manual && previous.application_id;
  let applicationId = manuallyLinked ? previous!.application_id : match.application?.id;
  let state = needsReview ? "needs_review" : match.state;
  let reason = match.reason;
  // Compare current tracker status to the latest explicit email, not to older mail in its timeline.
  if (applicationId && !manuallyLinked) {
    const email = await db.prepare("SELECT type FROM application_events WHERE application_id=? AND source='email' AND confidence>=0.9 AND COALESCE(json_extract(evidence,'$.superseded'),0)=0 AND json_extract(evidence,'$.method')='explicit_email' AND type NOT IN ('application_confirmation','application_submitted','recruiter_outreach','follow_up_sent','follow_up_received','other_job_related') ORDER BY occurred_at DESC LIMIT 1").bind(applicationId).first<{type:string}>();
    const sheet = await db.prepare("SELECT type FROM application_events WHERE application_id=? AND source='sheet' AND COALESCE(json_extract(evidence,'$.superseded'),0)=0 ORDER BY occurred_at DESC LIMIT 1").bind(applicationId).first<{type:string}>();
    const emailStatus = record.source === "email" && !needsReview && confidence >= 0.9 && !passiveEvents.includes(record.status) ? record.status : email?.type;
    const sheetStatus = record.source === "sheet" ? record.status : sheet?.type;
    if (emailStatus && sheetStatus && lifecycle(emailStatus) !== lifecycle(sheetStatus)) { state = "conflict"; reason = "Tracker and explicit email disagree on lifecycle status"; }
    else if (state === "matched" && !(await db.prepare("SELECT source FROM reconciliation_matches WHERE application_id=? AND source<>? AND state<>'excluded' LIMIT 1").bind(applicationId,record.source).first())) state = record.source === "email" ? "email_only" : "sheet_only";
  }
  if (manuallyLinked) state = "matched";
  const current=all.find(app=>app.id===applicationId);
  const regresses=current && lifecycle(current.status)===lifecycle(record.status) && (progression[record.status] || 0)<(progression[current.status] || 0);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (!applicationId && state !== "needs_review") {
    applicationId = crypto.randomUUID(); const organizationId = await envlessOrganization(db, record.company);
    statements.push(db.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?,?,?,?,?,0,?)")
      .bind(applicationId, organizationId, record.company, record.role, record.requisitionId || null, record.url || null, record.appliedAt, record.status === "application_confirmation" ? "application_submitted" : record.status, record.source, state, now));
  }
  statements.push(db.prepare("INSERT INTO reconciliation_matches(id,source,source_id,application_id,state,reason) VALUES(?,?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET application_id=excluded.application_id,state=excluded.state,reason=excluded.reason WHERE reconciliation_matches.manual=0")
    .bind(crypto.randomUUID(), record.source, record.id, applicationId || null, state, reason));
  if (applicationId) {
    if (record.source === "sheet" && record.appliedAt && !needsReview) statements.push(db.prepare("UPDATE applications SET applied_at=?,updated_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM manual_overrides WHERE application_id=? AND field='applied_at')").bind(record.appliedAt,now,applicationId,applicationId));
    statements.push(db.prepare("UPDATE application_events SET evidence=json_set(evidence,'$.superseded',1) WHERE source=? AND source_id=? AND type<>? AND json_extract(evidence,'$.method')<>'manual'").bind(record.source,record.id,record.status));
    statements.push(db.prepare("INSERT INTO application_events VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id,type) DO UPDATE SET application_id=excluded.application_id,confidence=excluded.confidence,evidence=excluded.evidence")
      .bind(crypto.randomUUID(), applicationId, record.status, record.source === "sheet" && record.status !== "application_submitted" ? now : record.eventAt || record.appliedAt, record.source, record.id, confidence, JSON.stringify({ method: needsReview ? "review_required" : record.source === "sheet" ? "sheet" : "explicit_email", company: record.company, role: record.role, dateKnown:record.source !== "sheet" || record.status === "application_submitted", appliedDateBasis:record.source === "sheet" ? "tracker" : record.appliedAt ? "submission_evidence" : "unknown" })));
    if (!needsReview && !regresses && (record.source === "sheet" || !passiveEvents.includes(record.status)) && (state !== "conflict" || record.source === "email")) statements.push(db.prepare("UPDATE applications SET status=?,reconciliation=?,updated_at=? WHERE id=? AND excluded=0 AND NOT EXISTS(SELECT 1 FROM manual_overrides WHERE application_id=? AND field='status') AND (?='email' OR NOT EXISTS(SELECT 1 FROM application_events WHERE application_id=? AND source='email' AND confidence>=0.9 AND type NOT IN ('application_confirmation','application_submitted','recruiter_outreach','follow_up_sent','follow_up_received','other_job_related'))) AND NOT EXISTS(SELECT 1 FROM application_events WHERE application_id=? AND occurred_at>? AND source='email' AND type NOT IN ('application_confirmation','application_submitted','recruiter_outreach','follow_up_sent','follow_up_received','other_job_related'))")
      .bind(record.status, state, now, applicationId, applicationId, record.source, applicationId, applicationId, record.eventAt || record.appliedAt));
    if (["matched","conflict","needs_review","email_only","sheet_only"].includes(state)) statements.push(db.prepare("UPDATE applications SET reconciliation=?,updated_at=? WHERE id=? AND excluded=0").bind(state,now,applicationId));
  }
  await db.batch(statements);
}
async function envlessOrganization(db: D1Database, company: string): Promise<string> {
  const name = normalize(company); const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO organizations VALUES(?,?,?)").bind(id, company, name).run();
  return (await db.prepare("SELECT id FROM organizations WHERE normalized_name=?").bind(name).first<{ id: string }>())!.id;
}

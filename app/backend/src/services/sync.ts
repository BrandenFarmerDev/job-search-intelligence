import type { SourceRecord } from "@job-search/shared";
import { classify, decide, extractFields } from "./classification";
import { graphBody, graphPage, initialDelta, microsoftToken, projectMessage } from "./microsoft";
import { reconcile } from "./reconciliation";
import { fetchSheet } from "./sheets";
import { digest, Problem } from "./security";
import { emailReferenceId } from "./email-identity";

export async function acquireLease(db: D1Database, owner: string, maintenance = false): Promise<boolean> {
  const row = await db.prepare("INSERT INTO sync_locks SELECT 'daily',?,? WHERE ?=1 OR NOT EXISTS(SELECT 1 FROM app_metadata WHERE key='sync_paused' AND value='true') ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE expires_at<? OR owner=? RETURNING owner")
    .bind(owner, Date.now() + 3600000, Number(maintenance), Date.now(), owner).first();
  return Boolean(row);
}
export async function heartbeat(db: D1Database, owner: string) {
  const row = await db.prepare("UPDATE sync_locks SET expires_at=? WHERE name='daily' AND owner=? AND expires_at>? RETURNING owner").bind(Date.now() + 3600000, owner, Date.now()).first();
  if (!row) throw new Problem(409, "sync_lease_lost");
}
export async function ingestGraphPage(env: Env, folder: string, owner: string): Promise<{ done: boolean; count: number }> {
  await heartbeat(env.JOB_SEARCH_DB, owner);
  const connection = await microsoftToken(env); if (!connection) return { done: true, count: 0 };
  const checkpoint = await env.JOB_SEARCH_DB.prepare("SELECT cursor FROM sync_state WHERE provider='microsoft' AND scope=?").bind(folder).first<{ cursor: string }>();
  let page; let rebaseline = false;
  try { page = await graphPage(checkpoint?.cursor || initialDelta(folder, env.HISTORICAL_START_DATE), folder, connection.token); }
  catch (error) {
    if (!(error instanceof Problem) || error.status !== 410) throw error;
    page = await graphPage(initialDelta(folder, env.HISTORICAL_START_DATE), folder, connection.token);
    rebaseline = true;
    // Rebaseline membership atomically with the first replacement checkpoint below.
  }
  const now = new Date().toISOString(); const statements: D1PreparedStatement[] = [];
  if (rebaseline) {
    statements.push(env.JOB_SEARCH_DB.prepare("DELETE FROM message_folders WHERE folder=?").bind(folder));
    statements.push(env.JOB_SEARCH_DB.prepare("UPDATE message_references SET available=EXISTS(SELECT 1 FROM message_folders WHERE message_id=message_references.id)"));
  }
  for (const message of page.value) {
    if (message["@removed"]) {
      statements.push(env.JOB_SEARCH_DB.prepare("DELETE FROM message_folders WHERE message_id=(SELECT id FROM message_references WHERE account_id=? AND immutable_id=?) AND folder=?").bind(connection.account, message.id, folder));
      statements.push(env.JOB_SEARCH_DB.prepare("UPDATE message_references SET available=EXISTS(SELECT 1 FROM message_folders WHERE message_id=message_references.id),updated_at=? WHERE account_id=? AND immutable_id=?").bind(now, connection.account, message.id));
      continue;
    }
    const projected = projectMessage(message, folder); const hash = await digest(JSON.stringify(projected));
    const id = await emailReferenceId(connection.account,message.id,projected.internetId,projected);
    statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO message_references VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,NULL) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,immutable_id=excluded.immutable_id,conversation_id=excluded.conversation_id,internet_message_id=excluded.internet_message_id,subject=excluded.subject,sender=excluded.sender,occurred_at=excluded.occurred_at,web_link=excluded.web_link,excerpt=excluded.excerpt,content_hash=excluded.content_hash,available=1,updated_at=excluded.updated_at")
      .bind(id, connection.account, message.id, projected.conversationId, projected.internetId, projected.subject, projected.sender, projected.occurredAt, projected.webLink, projected.excerpt, hash, now));
    statements.push(env.JOB_SEARCH_DB.prepare("INSERT OR IGNORE INTO message_folders VALUES(?,?)").bind(id, folder));
  }
  const cursor = page["@odata.nextLink"] || page["@odata.deltaLink"];
  if (!cursor) throw new Problem(502, "missing_graph_checkpoint");
  statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO sync_state VALUES('microsoft',?,?,?) ON CONFLICT(provider,scope) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at").bind(folder, cursor, now));
  await env.JOB_SEARCH_DB.batch(statements); // Source writes and cursor advance commit together.
  return { done: !page["@odata.nextLink"], count: page.value.length };
}
interface PendingMessage { id: string; immutable_id:string; subject: string; excerpt: string; conversation_id: string; occurred_at: string; content_hash: string; sent: number }
export async function processMessages(env: Env, owner: string): Promise<number> {
  await heartbeat(env.JOB_SEARCH_DB, owner);
  const messages = (await env.JOB_SEARCH_DB.prepare("SELECT m.*,EXISTS(SELECT 1 FROM message_folders f WHERE f.message_id=m.id AND f.folder='sentitems') AS sent FROM message_references m WHERE available=1 AND (processed_hash IS NULL OR processed_hash<>content_hash) ORDER BY occurred_at LIMIT 100").all<PendingMessage>()).results;
  let connection:Awaited<ReturnType<typeof microsoftToken>>|undefined;
  for (const message of messages) {
    const candidates = message.conversation_id ? (await env.JOB_SEARCH_DB.prepare("SELECT DISTINCT a.id,a.company,a.role,a.requisition_id FROM applications a JOIN application_events e ON e.application_id=a.id JOIN message_references m ON e.source_id=m.id AND e.source='email' WHERE m.conversation_id=? AND a.excluded=0 LIMIT 2")
      .bind(message.conversation_id).all<{id:string;company:string;role:string;requisition_id:string|null}>()).results : [];
    const context=candidates.length === 1 ? candidates[0] : null;
    let excerpt=message.excerpt || "";
    let extracted=extractFields(message.subject,excerpt);
    if (env.MICROSOFT_GRAPH_ENABLED === "true" && !context && classify(message.subject,excerpt,Boolean(message.sent)).type && (!extracted.company || !extracted.role)) {
      if(connection === undefined)connection=await microsoftToken(env);
      if(connection) { excerpt=await graphBody(message.immutable_id,connection.token);extracted=extractFields(message.subject,excerpt); }
    }
    const decision = await decide(env, message.id, message.subject, context ? `Job application conversation. ${excerpt}` : excerpt, Boolean(message.sent));
    if (decision.type) {
      const submission = ["application_submitted","application_confirmation"].includes(decision.type);
      const record: SourceRecord = { id: message.id, company:extracted.company || context?.company || "",role:extracted.role || context?.role || "",requisitionId:extracted.requisitionId || context?.requisition_id || "", url: "", appliedAt: submission ? message.occurred_at : "", eventAt:message.occurred_at, conversationId: message.conversation_id, applicationId: "", source: "email", status: decision.type };
      await reconcile(env.JOB_SEARCH_DB, record, decision.confidence, decision.needsReview);
    }
    await env.JOB_SEARCH_DB.prepare("UPDATE message_references SET processed_hash=? WHERE id=? AND content_hash=?").bind(message.content_hash, message.id, message.content_hash).run();
  }
  return messages.length;
}
export async function syncSheets(env: Env, owner: string): Promise<{ changed: number; unchanged: number; missing: number }> {
  await heartbeat(env.JOB_SEARCH_DB, owner);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return { changed: 0, unchanged: 0, missing: 0 };
  const maintenance = await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>();
  if (maintenance?.value === "true") return {changed:0,unchanged:0,missing:0};
  const paused = await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sheets_paused'").first<{value: string}>();
  if (paused?.value === "true") return { changed: 0, unchanged: 0, missing: 0 };
  const rows = await fetchSheet(env); const now = new Date().toISOString();
  const existing = (await env.JOB_SEARCH_DB.prepare("SELECT id,row_key,row_hash,processed_hash FROM sheet_rows WHERE spreadsheet_id=? AND available=1").bind(env.GOOGLE_SPREADSHEET_ID).all<{ id: string; row_key: string; row_hash: string; processed_hash: string | null }>()).results;
  let changed = 0; let unchanged = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    await heartbeat(env.JOB_SEARCH_DB, owner);
    // Duplicate natural identities are quarantined individually; they never overwrite one another.
    const key = row.ambiguous ? `${row.key}:${row.hash}` : row.key; seen.add(key);
    const id = await digest(`${env.GOOGLE_SPREADSHEET_ID}:${key}`); const previous = existing.find((item) => item.row_key === key);
    if (previous?.row_hash === row.hash && previous.processed_hash === row.hash) { unchanged++; continue; }
    await env.JOB_SEARCH_DB.batch([
      env.JOB_SEARCH_DB.prepare("INSERT INTO sheet_rows VALUES(?,?,?,?,?,1,?,NULL) ON CONFLICT(spreadsheet_id,row_key) DO UPDATE SET row_hash=excluded.row_hash,snapshot=excluded.snapshot,available=1,updated_at=excluded.updated_at").bind(id, env.GOOGLE_SPREADSHEET_ID, key, row.hash, row.snapshot, now),
      env.JOB_SEARCH_DB.prepare("INSERT OR IGNORE INTO sheet_versions VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), id, row.hash, row.snapshot, now),
    ]);
    await reconcile(env.JOB_SEARCH_DB, { ...row.record, id }, 1, row.ambiguous);
    await env.JOB_SEARCH_DB.prepare("UPDATE sheet_rows SET processed_hash=? WHERE id=? AND row_hash=?").bind(row.hash, id, row.hash).run();
    changed++;
  }
  const missing = existing.filter((item) => !seen.has(item.row_key));
  if (missing.length) await env.JOB_SEARCH_DB.batch(missing.map((item) => env.JOB_SEARCH_DB.prepare("UPDATE sheet_rows SET available=0,updated_at=? WHERE id=?").bind(now, item.id)));
  await env.JOB_SEARCH_DB.prepare("INSERT INTO sync_state VALUES('sheets','tracker',NULL,?) ON CONFLICT(provider,scope) DO UPDATE SET updated_at=excluded.updated_at").bind(now).run();
  return { changed, unchanged, missing: missing.length };
}
export async function retain(db: D1Database) {
  const excerptCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const runCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  await db.batch([
    db.prepare("UPDATE message_references SET excerpt=NULL WHERE occurred_at<?").bind(excerptCutoff),
    db.prepare("DELETE FROM sync_runs WHERE finished_at<?").bind(runCutoff),
    db.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(Date.now()),
  ]);
}

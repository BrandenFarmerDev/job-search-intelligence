import { digest, Problem, text } from "./security";
import { emailReferenceId } from "./email-identity";

const format = "job-search-intelligence.outlook-com.v1";
const folders = new Set(["inbox", "sentitems"]);
export interface LocalOutlookMessage {
  immutableId: string;
  folder: "inbox" | "sentitems";
  subject: string;
  sender: string;
  excerpt: string;
  occurredAt: string;
  conversationId: string;
  internetMessageId: string;
  revision: string;
}
export interface LocalOutlookBatch {
  format: typeof format;
  accountId: string;
  exportedAt: string;
  since: string;
  summary: { truncated: false };
  messages: LocalOutlookMessage[];
}

function limited(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Problem(400, "invalid_local_outlook_bundle");
  return text(value, limit);
}
function timestamp(value: unknown): string {
  const result = limited(value, 40);
  if (!result || !Number.isFinite(Date.parse(result))) throw new Problem(400, "invalid_local_outlook_bundle");
  return new Date(result).toISOString();
}
export function parseLocalOutlookBatch(value: Record<string, unknown>, historicalStart: string): LocalOutlookBatch {
  const summary = value.summary;
  if (value.format !== format || !/^[a-f0-9]{64}$/.test(String(value.accountId || "")) || !Array.isArray(value.messages) || value.messages.length > 40
    || !summary || typeof summary !== "object" || Array.isArray(summary)) throw new Problem(400, "invalid_local_outlook_bundle");
  if ((summary as Record<string, unknown>).truncated === true) throw new Problem(409, "local_outlook_export_truncated");
  if ((summary as Record<string, unknown>).truncated !== false) throw new Problem(400, "invalid_local_outlook_bundle");
  const since = timestamp(value.since); const exportedAt = timestamp(value.exportedAt); const floor = Date.parse(historicalStart);
  if (!Number.isFinite(floor) || Date.parse(since) < floor) throw new Problem(400, "invalid_local_outlook_bundle");
  const seen = new Set<string>();
  const messages = value.messages.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Problem(400, "invalid_local_outlook_bundle");
    const item = candidate as Record<string, unknown>; const immutableId = limited(item.immutableId, 64);
    const folder = limited(item.folder, 20); const occurredAt = timestamp(item.occurredAt);
    if (!/^[a-f0-9]{64}$/.test(immutableId) || !folders.has(folder) || Date.parse(occurredAt) < Date.parse(since)) throw new Problem(400, "invalid_local_outlook_bundle");
    const key = `${immutableId}:${folder}`; if (seen.has(key)) throw new Problem(400, "invalid_local_outlook_bundle"); seen.add(key);
    return { immutableId, folder: folder as LocalOutlookMessage["folder"], occurredAt,
      subject: limited(item.subject, 500), sender: limited(item.sender, 320), excerpt: limited(item.excerpt, 1500),
      conversationId: limited(item.conversationId, 1000), internetMessageId: limited(item.internetMessageId, 1000), revision: limited(item.revision, 100) };
  });
  return { format, accountId: String(value.accountId), exportedAt, since, summary: { truncated: false }, messages };
}
export async function ingestLocalOutlookBatch(env: Env, value: Record<string, unknown>, automated = false): Promise<{imported:number}> {
  const batch = parseLocalOutlookBatch(value, env.HISTORICAL_START_DATE); const now = new Date().toISOString();
  const graph = await env.JOB_SEARCH_DB.prepare("SELECT 1 AS connected FROM connections WHERE provider='microsoft'").first();
  if (env.MICROSOFT_GRAPH_ENABLED === "true" && graph) throw new Problem(409, "graph_is_authoritative");
  // Automation never reconnects: after typed deletion only an owner action may resume imports.
  if (automated && (await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>())?.value === "true") throw new Problem(409, "reconnect_sources_to_resume");
  const account = `outlook-local:${batch.accountId}`; const statements: D1PreparedStatement[] = [];
  for (const message of batch.messages) {
    const id = await emailReferenceId(account,message.immutableId,message.internetMessageId,message);
    const projected = { subject:message.subject,sender:message.sender,excerpt:message.excerpt,occurredAt:message.occurredAt,
      conversationId:message.conversationId,internetMessageId:message.internetMessageId,revision:message.revision };
    const hash = await digest(JSON.stringify(projected));
    statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO message_references VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,NULL) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,internet_message_id=excluded.internet_message_id,subject=excluded.subject,sender=excluded.sender,occurred_at=excluded.occurred_at,web_link=NULL,excerpt=excluded.excerpt,content_hash=excluded.content_hash,available=1,updated_at=excluded.updated_at")
      .bind(id,account,message.immutableId,message.conversationId,message.internetMessageId,message.subject,message.sender,message.occurredAt,null,message.excerpt,hash,now));
    statements.push(env.JOB_SEARCH_DB.prepare("INSERT OR IGNORE INTO message_folders VALUES(?,?)").bind(id,message.folder));
  }
  statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata VALUES('local_outlook_last_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(batch.exportedAt));
  if (automated) statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata VALUES('local_outlook_last_automated_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(batch.exportedAt));
  else statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata VALUES('sync_paused','false') ON CONFLICT(key) DO UPDATE SET value='false'"));
  statements.push(env.JOB_SEARCH_DB.prepare("INSERT INTO sync_state VALUES('outlook_local',?,?,?) ON CONFLICT(provider,scope) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at").bind(batch.accountId,batch.exportedAt,now));
  await env.JOB_SEARCH_DB.batch(statements);
  return { imported: batch.messages.length };
}

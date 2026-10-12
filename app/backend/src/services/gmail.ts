import { Parser } from "htmlparser2";
import { base64url, boundedText, decrypt, digest, encrypt, Problem, randomToken } from "./security";
import { reserveExternal } from "./execution-budget";
import { ExecutionBudgetExceeded } from "./execution-budget";

const scope = "https://www.googleapis.com/auth/gmail.readonly";
const productionMailbox = "branden.farmer.dev@gmail.com";
const labels = ["Job search", "Application receipts", "Recruiter follow ups", "Interviews", "Offers", "Rejections", "Job alerts", "Review"];
interface OAuthTokens { access_token?: string; refresh_token?: string; scope?: string; error?: string; expires_in?: number }
interface StoredConnection { id: string; mailbox: string; encrypted_refresh_token: string; generation: string; status: string; granted_scopes: string }
const accessTokenCache=new WeakMap<Env,{token:string;connection:StoredConnection;expiresAt:number}>();
export interface GmailMessage { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart; snippet?: string }
interface GmailList { messages?: {id:string;threadId:string}[]; nextPageToken?:string }
interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }
const configured = (env: Env) => Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REDIRECT_URI && env.TOKEN_ENCRYPTION_KEY && env.GMAIL_MAILBOX);
function parseCookie(request: Request) { return request.headers.get("Cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith("job_gmail_oauth="))?.slice(16) || ""; }
export function gmailMailbox(env: Env) { return (env.GMAIL_MAILBOX || "").trim().toLowerCase(); }
function assertConfigured(env: Env) {
  const address=gmailMailbox(env);
  const production=env.ENVIRONMENT_NAME==="production";
  if(!configured(env)||!address||!/^[-a-z0-9._+]+@gmail\.com$/.test(address))throw new Problem(503,"gmail_setup_required");
  if(production&&address!==productionMailbox)throw new Problem(503,"gmail_mailbox_binding_invalid");
  if(!production&&(!env.GMAIL_SYNTHETIC_MAILBOX||address!==env.GMAIL_SYNTHETIC_MAILBOX.trim().toLowerCase()||address===productionMailbox))throw new Problem(503,"gmail_synthetic_mailbox_required");
}
export async function beginGmail(env: Env, owner: string): Promise<Response> {
  assertConfigured(env);
  const state = randomToken(); const verifier = randomToken();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const [epoch, connection] = await Promise.all([
    env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='job_data_generation'").first<{value:string}>(),
    env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='gmail_connection_generation'").first<{value:string}>(),
  ]);
  if (!epoch?.value || !connection?.value) throw new Problem(503, "data_generation_unavailable");
  const now = Date.now(); const targetEnv = env.ENVIRONMENT_NAME || "production";
  await env.JOB_SEARCH_DB.batch([
    env.JOB_SEARCH_DB.prepare("DELETE FROM gmail_oauth_states WHERE expires_at<?").bind(now),
    env.JOB_SEARCH_DB.prepare("INSERT INTO gmail_oauth_states VALUES(?,?,?,?,?,?,?,?)").bind(await digest(state), owner, verifier, targetEnv, "connect", epoch.value, connection.value, now + 600000),
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID!, redirect_uri: env.GMAIL_REDIRECT_URI!, response_type: "code", scope,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
    code_challenge: challenge, code_challenge_method: "S256", login_hint: gmailMailbox(env) }).toString();
  return Response.json({ authorizationUrl: url.href }, { headers: { "Cache-Control": "no-store", "Set-Cookie": `job_gmail_oauth=${state}; Path=/api/job-intelligence/connections/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
}
async function oauthPost(env: Env, form: URLSearchParams): Promise<OAuthTokens> {
  reserveExternal(env);
  const response = await fetch("https://oauth2.googleapis.com/token", { method:"POST", body:form, redirect:"manual", signal:AbortSignal.timeout(15000) });
  const body = await boundedText(response,16384);
  let parsed: OAuthTokens = {};
  try { if (body.length < 16384) parsed = JSON.parse(body) as OAuthTokens; } catch { /* provider diagnostics are discarded */ }
  if (!response.ok) throw new Problem(response.status === 400 && parsed.error === "invalid_grant" ? 401 : 502, response.status === 400 && parsed.error === "invalid_grant" ? "gmail_reconnect_required" : "gmail_oauth_failed");
  return parsed;
}
export async function completeGmail(request: Request, env: Env, owner: string): Promise<Response> {
  assertConfigured(env);
  const params = new URL(request.url).searchParams; const state = params.get("state") || ""; const code = params.get("code") || "";
  if (!state || !code || state !== parseCookie(request) || state.length > 100 || code.length > 4096 || params.has("error")) throw new Problem(400, "invalid_gmail_oauth_state");
  const row = await env.JOB_SEARCH_DB.prepare("DELETE FROM gmail_oauth_states WHERE state_hash=? AND owner=? AND environment=? AND intent='connect' AND expires_at>? RETURNING verifier,data_generation,connection_generation")
    .bind(await digest(state), owner, env.ENVIRONMENT_NAME || "production", Date.now()).first<{verifier:string;data_generation:string;connection_generation:string}>();
  if (!row) throw new Problem(400, "expired_gmail_oauth_state");
  const tokens = await oauthPost(env, new URLSearchParams({ client_id:env.GMAIL_CLIENT_ID!, client_secret:env.GMAIL_CLIENT_SECRET!, code,
    code_verifier:row.verifier, grant_type:"authorization_code", redirect_uri:env.GMAIL_REDIRECT_URI! }));
  const access = tokens.access_token;
  const granted=tokens.scope?.trim().split(/\s+/).filter(Boolean).sort()||[];
  if (!access || !tokens.refresh_token || granted.length!==1 || granted[0]!==scope) throw new Problem(403,"gmail_scope_invalid");
  const profile = await gmailJson<{emailAddress?:string}>("https://gmail.googleapis.com/gmail/v1/users/me/profile", access);
  if ((profile.emailAddress || "").trim().toLowerCase() !== gmailMailbox(env)) throw new Problem(403,"gmail_mailbox_mismatch");
  const id = crypto.randomUUID(); const generation = crypto.randomUUID(); const now = new Date().toISOString();
  const encrypted = await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY!, `gmail:${gmailMailbox(env)}:${env.ENVIRONMENT_NAME || "production"}:${id}`);
  const [epoch, connection] = await Promise.all([
    env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='job_data_generation'").first<{value:string}>(),
    env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='gmail_connection_generation'").first<{value:string}>(),
  ]);
  if (epoch?.value !== row.data_generation || connection?.value !== row.connection_generation) throw new Problem(409,"stale_gmail_oauth_state");
  await env.JOB_SEARCH_DB.batch([
    env.JOB_SEARCH_DB.prepare("UPDATE app_metadata SET value=? WHERE key='gmail_connection_generation' AND value=? AND EXISTS(SELECT 1 FROM app_metadata WHERE key='job_data_generation' AND value=?)").bind(generation,row.connection_generation,row.data_generation),
    env.JOB_SEARCH_DB.prepare("INSERT INTO gmail_connections SELECT ?,?,?,?,?,?,'connected',? WHERE EXISTS(SELECT 1 FROM app_metadata WHERE key='gmail_connection_generation' AND value=?) ON CONFLICT(id) DO NOTHING").bind(id,gmailMailbox(env),encrypted,now,now,generation,scope,generation),
    env.JOB_SEARCH_DB.prepare("UPDATE gmail_connections SET status='disconnected',updated_at=? WHERE id<>? AND status='connected' AND EXISTS(SELECT 1 FROM app_metadata WHERE key='gmail_connection_generation' AND value=?)").bind(now,id,generation),
  ]);
  const committed=await env.JOB_SEARCH_DB.prepare("SELECT id FROM gmail_connections WHERE id=? AND generation=? AND status='connected'").bind(id,generation).first();
  if(!committed)throw new Problem(409,"stale_gmail_oauth_state");
  return new Response(null,{status:303,headers:{Location:`${env.ALLOWED_ORIGIN}?gmail=connected`,"Cache-Control":"no-store","Set-Cookie":"job_gmail_oauth=; Path=/api/job-intelligence/connections/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=0"}});
}
export async function gmailToken(env: Env): Promise<{token:string;connection:StoredConnection}|null> {
  const cached=accessTokenCache.get(env);if(cached&&cached.expiresAt>Date.now())return {token:cached.token,connection:cached.connection};
  const connection = await env.JOB_SEARCH_DB.prepare("SELECT id,mailbox,encrypted_refresh_token,generation,status,granted_scopes FROM gmail_connections WHERE status IN ('connected','reconnect_required') ORDER BY connected_at DESC LIMIT 1").first<StoredConnection>();
  if (!connection) return null;
  if(connection.status==="reconnect_required")throw new Problem(403,"gmail_reconnect_required");
  assertConfigured(env);
  if (connection.mailbox !== gmailMailbox(env) || connection.granted_scopes !== scope) throw new Problem(403,"gmail_connection_invalid");
  if(cached&&(cached.connection.id!==connection.id||cached.connection.generation!==connection.generation))accessTokenCache.delete(env);
  const refresh = await decrypt(connection.encrypted_refresh_token,env.TOKEN_ENCRYPTION_KEY!,`gmail:${gmailMailbox(env)}:${env.ENVIRONMENT_NAME || "production"}:${connection.id}`);
  let tokens:OAuthTokens;
  try{tokens=await oauthPost(env,new URLSearchParams({client_id:env.GMAIL_CLIENT_ID!,client_secret:env.GMAIL_CLIENT_SECRET!,refresh_token:refresh,grant_type:"refresh_token"}));}
  catch(error){if(error instanceof Problem&&error.code==="gmail_reconnect_required")await env.JOB_SEARCH_DB.prepare("UPDATE gmail_connections SET status='reconnect_required',updated_at=? WHERE id=? AND generation=?").bind(new Date().toISOString(),connection.id,connection.generation).run();throw error;}
  if (!tokens.access_token) throw new Problem(502,"gmail_oauth_failed");
  if (tokens.refresh_token) {
    const encrypted = await encrypt(tokens.refresh_token,env.TOKEN_ENCRYPTION_KEY!,`gmail:${gmailMailbox(env)}:${env.ENVIRONMENT_NAME || "production"}:${connection.id}`);
    await env.JOB_SEARCH_DB.prepare("UPDATE gmail_connections SET encrypted_refresh_token=?,updated_at=? WHERE id=? AND generation=? AND status='connected'").bind(encrypted,new Date().toISOString(),connection.id,connection.generation).run();
  }
  accessTokenCache.set(env,{token:tokens.access_token,connection,expiresAt:Date.now()+Math.min(3300,Math.max(60,Number(tokens.expires_in)||3600))*1000});
  return {token:tokens.access_token,connection};
}
async function reserveGmailCall(env:Env,units:number,rows:number,attempts=1):Promise<void>{
  const db=env.JOB_SEARCH_DB;const day=new Date().toISOString().slice(0,10);const minute=new Date().toISOString().slice(0,16);
  const reserved=await db.prepare("INSERT INTO gmail_budget(day,units,calls,instances,rows_written) VALUES(?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET units=units+excluded.units,calls=calls+excluded.calls,instances=instances+excluded.instances,rows_written=rows_written+excluded.rows_written WHERE units+excluded.units<=20000 AND calls+excluded.calls<=600 AND instances+excluded.instances<=500 AND rows_written+excluded.rows_written<=50000 RETURNING day").bind(day,units*attempts,attempts,rows*attempts,rows*attempts).first();
  if(!reserved)throw new Problem(429,"gmail_daily_budget_exhausted",3600);
  const minuteResult=await db.prepare("INSERT INTO gmail_minute_budget(minute,units,calls) VALUES(?,?,?) ON CONFLICT(minute) DO UPDATE SET units=units+excluded.units,calls=calls+excluded.calls WHERE units+excluded.units<=500 AND calls+excluded.calls<=100 RETURNING minute").bind(minute,units*attempts,attempts).first();
  if(!minuteResult)throw new Problem(429,"gmail_minute_budget_exhausted",60);
}
/** Reserve a durable application-side cap for each Gmail Workflow phase (including Sheets/classification). */
export async function reserveGmailWorkflowStep(env:Env):Promise<void>{
  const day=new Date().toISOString().slice(0,10);const reserved=await env.JOB_SEARCH_DB.prepare("INSERT INTO gmail_budget(day,steps) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET steps=steps+1 WHERE steps+1<=200 RETURNING day").bind(day).first();
  if(!reserved)throw new Problem(429,"gmail_daily_step_budget_exhausted",3600);
}
export async function assertGmailDrained(env:Env):Promise<void>{
  const pending=await env.JOB_SEARCH_DB.prepare("SELECT COUNT(*) AS count FROM gmail_candidates WHERE mailbox=? AND stage<>'done'").bind(gmailMailbox(env)).first<{count:number}>();
  const cooldown=await env.JOB_SEARCH_DB.prepare("SELECT until_at FROM gmail_cooldowns WHERE mailbox=?").bind(gmailMailbox(env)).first<{until_at:number}>();
  if(Number(pending?.count||0)>0||Boolean(cooldown&&cooldown.until_at>Date.now()))throw new Problem(409,"gmail_backlog_pending");
}
async function leaseAndEpoch(env:Env,owner:string,epoch:string,connectionGeneration:string):Promise<void>{
  const result=await env.JOB_SEARCH_DB.prepare("UPDATE sync_locks SET expires_at=? WHERE name='daily' AND owner=? AND expires_at>? RETURNING owner").bind(Date.now()+3600000,owner,Date.now()).first();
  if(!result)throw new Problem(409,"sync_lease_lost");
  const state=(await env.JOB_SEARCH_DB.prepare("SELECT key,value FROM app_metadata WHERE key IN ('job_data_generation','gmail_connection_generation','mail_source','gmail_sync_paused')").all<{key:string;value:string}>()).results;
  const value=(key:string)=>state.find(row=>row.key===key)?.value;
  if(value("job_data_generation")!==epoch)throw new Problem(409,"stale_data_generation");if(value("gmail_connection_generation")!==connectionGeneration)throw new Problem(409,"stale_gmail_connection");if(value("mail_source")!=="gmail"||value("gmail_sync_paused")!=="false")throw new Problem(409,"gmail_sync_paused");
  if(env.MAIL_SOURCE!=="gmail"||env.GMAIL_ENABLED!=="true"||env.GMAIL_SYNC_ENABLED!=="true")throw new Problem(409,"gmail_sync_not_accepted");
}
async function fencedBatch(env:Env,owner:string,epoch:string,connectionGeneration:string,statements:D1PreparedStatement[]):Promise<void>{
  const db=env.JOB_SEARCH_DB;const fence=crypto.randomUUID();const now=Date.now();
  const valid="EXISTS(SELECT 1 FROM app_metadata WHERE key='job_data_generation' AND value=?) AND EXISTS(SELECT 1 FROM app_metadata WHERE key='gmail_connection_generation' AND value=?) AND EXISTS(SELECT 1 FROM app_metadata WHERE key='mail_source' AND value='gmail') AND EXISTS(SELECT 1 FROM app_metadata WHERE key='gmail_sync_paused' AND value='false') AND EXISTS(SELECT 1 FROM gmail_connections WHERE generation=? AND status='connected') AND EXISTS(SELECT 1 FROM sync_locks WHERE name='daily' AND owner=? AND expires_at>?)";
  await db.batch([db.prepare(`INSERT INTO gmail_write_fences(id,valid) VALUES(?,CASE WHEN ${valid} THEN 1 ELSE 0 END)`).bind(fence,epoch,connectionGeneration,connectionGeneration,owner,now),...statements,db.prepare("DELETE FROM gmail_write_fences WHERE id=?").bind(fence)]);
}
export const fencedGmailBatch=fencedBatch;
async function markPermissionReconnect(env:Env,owner:string,epoch:string,connectionGeneration:string):Promise<void>{
  await fencedBatch(env,owner,epoch,connectionGeneration,[env.JOB_SEARCH_DB.prepare("UPDATE gmail_connections SET status='reconnect_required',updated_at=? WHERE mailbox=? AND status='connected'").bind(new Date().toISOString(),gmailMailbox(env))]);
}
async function noteCandidateFailure(env:Env,owner:string,epoch:string,connectionGeneration:string,mailId:string,stage:"metadata"|"sweep"|"body"|"process",error:unknown):Promise<void>{
  const account=gmailMailbox(env);const db=env.JOB_SEARCH_DB;const row=await db.prepare("SELECT metadata_attempts,body_attempts,process_attempts FROM gmail_candidates WHERE mailbox=? AND gmail_id=?").bind(account,mailId).first<{metadata_attempts:number;body_attempts:number;process_attempts:number}>();if(!row)return;
  const column=stage==="metadata"||stage==="sweep"?"metadata_attempts":stage==="body"?"body_attempts":"process_attempts";const attempts=Number(row[column])+1;
  const problem=error instanceof Problem?error:new Problem(503,"gmail_provider_failed");
  if(problem.status===403&&problem.code==="gmail_permission_required"){
    await fencedBatch(env,owner,epoch,connectionGeneration,[db.prepare("UPDATE gmail_connections SET status='reconnect_required',updated_at=? WHERE mailbox=? AND status='connected'").bind(new Date().toISOString(),account)]);
    return;
  }
  if(problem.status===401||problem.status===429||problem.code.includes("budget")||problem.code.includes("quota")){
    const until=Date.now()+Math.max(60,Math.min(3600,problem.retryAfter))*1000;const writes=[db.prepare("INSERT INTO gmail_cooldowns(mailbox,until_at,reason) VALUES(?,?,?) ON CONFLICT(mailbox) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),reason=excluded.reason").bind(account,until,problem.code.slice(0,80))];
    if(problem.status===401)writes.push(db.prepare("UPDATE gmail_connections SET status='reconnect_required',updated_at=? WHERE mailbox=? AND status='connected'").bind(new Date().toISOString(),account));
    await fencedBatch(env,owner,epoch,connectionGeneration,writes);
    return;
  }
  const terminal=attempts>=3||[404,413,422].includes(problem.status);
  const next=Date.now()+(terminal?0:Math.max(30,Math.min(900,problem.retryAfter))*1000);const reason=problem.code.slice(0,80);const retryStage=stage==="sweep"?"sweep":stage;
  await fencedBatch(env,owner,epoch,connectionGeneration,[db.prepare(`UPDATE gmail_candidates SET ${column}=?,attempts=attempts+1,next_attempt_at=?,stage=?,reason=?,updated_at=? WHERE mailbox=? AND gmail_id=?`).bind(attempts,next,terminal?"done":retryStage,terminal?`${reason}; review_required`:reason,new Date().toISOString(),account,mailId)]);
  if(terminal&&stage==="body"){
    const instance=await db.prepare("SELECT id,thread_id,internal_date,internet_message_id,sender,subject FROM gmail_message_instances WHERE mailbox=? AND gmail_id=?").bind(account,mailId).first<{id:string;thread_id:string;internal_date:string;internet_message_id:string|null;sender:string;subject:string}>();
    if(instance&&problem.status!==404){const canonical=await digest(`gmail-review:${account}:${mailId}`);const hash=await digest(`${mailId}:${reason}`);const stamp=new Date().toISOString();await fencedBatch(env,owner,epoch,connectionGeneration,[
      db.prepare("INSERT OR IGNORE INTO message_references(id,account_id,immutable_id,conversation_id,internet_message_id,subject,sender,occurred_at,excerpt,content_hash,available,updated_at,processed_hash) VALUES(?,?,?,?,?,?,?,?,NULL,?,1,?,?)").bind(canonical,account,mailId,`gmail:${account}:${instance.thread_id}`,instance.internet_message_id,instance.subject,instance.sender,instance.internal_date,hash,stamp,hash),
      db.prepare("UPDATE gmail_message_instances SET canonical_id=?,state='review',review_reason=?,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(canonical,reason,stamp,account,mailId),
      db.prepare("INSERT INTO reconciliation_matches(id,source,source_id,application_id,state,reason) VALUES(?,'email',?,NULL,'needs_review',?) ON CONFLICT(source,source_id) DO UPDATE SET state='needs_review',reason=excluded.reason WHERE reconciliation_matches.manual=0").bind(crypto.randomUUID(),canonical,`Gmail review: ${reason}`),
    ]);}
  }
  if(terminal&&problem.status===404){
    const stamp=new Date().toISOString();await fencedBatch(env,owner,epoch,connectionGeneration,[
      db.prepare("UPDATE gmail_message_instances SET available=0,state='unavailable',review_reason=?,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(reason,stamp,account,mailId),
      db.prepare("UPDATE message_references SET available=EXISTS(SELECT 1 FROM gmail_message_instances g WHERE g.canonical_id=message_references.id AND g.available=1) WHERE id=(SELECT canonical_id FROM gmail_message_instances WHERE mailbox=? AND gmail_id=?) AND account_id=? AND EXISTS(SELECT 1 FROM gmail_message_instances own WHERE own.canonical_id=message_references.id AND own.gmail_id=message_references.immutable_id)").bind(account,mailId,account),
    ]);
  }
  if(problem.status>=500)await fencedBatch(env,owner,epoch,connectionGeneration,[db.prepare("INSERT INTO gmail_cooldowns(mailbox,until_at,reason) VALUES(?,?,?) ON CONFLICT(mailbox) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),reason=excluded.reason").bind(account,Date.now()+problem.retryAfter*1000,reason)]);
}
export async function gmailMetadataCandidate(env:Env,owner:string,epoch:string,connectionGeneration:string):Promise<boolean>{
  const db=env.JOB_SEARCH_DB;await leaseAndEpoch(env,owner,epoch,connectionGeneration);await assertNoGmailCooldown(env);
  const account=gmailMailbox(env);const turn=await db.prepare("SELECT value FROM app_metadata WHERE key='gmail_metadata_turn'").first<{value:string}>();const preferred=turn?.value==="metadata"?"sweep":"metadata";
  const candidate=await db.prepare("SELECT gmail_id,thread_id,stage FROM gmail_candidates WHERE mailbox=? AND stage IN ('metadata','sweep') AND next_attempt_at<=? ORDER BY next_attempt_at,CASE stage WHEN ? THEN 0 ELSE 1 END,created_at,gmail_id LIMIT 1").bind(account,Date.now(),preferred).first<{gmail_id:string;thread_id:string;stage:string}>();
  if(!candidate){
    // Independently reconcile D1-known Gmail instances. Root-label listing cannot return messages
    // whose label was removed or which were moved to Trash, so this bounded weekly cursor must
    // walk the local ID set directly and ask Gmail for current metadata.
    const checkpoint=await db.prepare("SELECT cursor,completed_at FROM gmail_checkpoints WHERE mailbox=? AND name='known_metadata'").bind(account).first<{cursor:string|null;completed_at:string|null}>();
    const completed=checkpoint?.completed_at?Date.parse(checkpoint.completed_at):0;
    if(!checkpoint||!checkpoint.completed_at||Date.now()-completed>=7*86400000){
      const known=await db.prepare("SELECT gmail_id,thread_id FROM gmail_message_instances WHERE mailbox=? AND (? IS NULL OR gmail_id>?) ORDER BY gmail_id LIMIT 1").bind(account,checkpoint?.cursor||null,checkpoint?.cursor||null).first<{gmail_id:string;thread_id:string}>();
      if(known){const stamp=new Date().toISOString();await fencedBatch(env,owner,epoch,connectionGeneration,[
        db.prepare("INSERT INTO gmail_candidates(mailbox,gmail_id,thread_id,stage,attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'sweep',0,0,?,?) ON CONFLICT(mailbox,gmail_id) DO UPDATE SET thread_id=excluded.thread_id,stage='sweep',next_attempt_at=0,updated_at=excluded.updated_at WHERE gmail_candidates.stage='done'").bind(account,known.gmail_id,known.thread_id,stamp,stamp),
        db.prepare("INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at) VALUES(?,'known_metadata',?,NULL,NULL,NULL,NULL,?) ON CONFLICT(mailbox,name) DO UPDATE SET cursor=excluded.cursor,completed_at=NULL,updated_at=excluded.updated_at").bind(account,known.gmail_id,stamp),
      ]);return true;}
      if(checkpoint?.cursor){await fencedBatch(env,owner,epoch,connectionGeneration,[db.prepare("UPDATE gmail_checkpoints SET cursor=NULL,completed_at=?,updated_at=? WHERE mailbox=? AND name='known_metadata'").bind(new Date().toISOString(),new Date().toISOString(),account)]);}
      else if(!checkpoint){await fencedBatch(env,owner,epoch,connectionGeneration,[db.prepare("INSERT INTO gmail_checkpoints(mailbox,name,cursor,completed_at,updated_at) VALUES(?,'known_metadata',NULL,?,?)").bind(account,new Date().toISOString(),new Date().toISOString())]);}
    }
    return false;
  }
  try{
    const meta=await gmailApi<GmailMessage>(env,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(candidate.gmail_id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,20,2);
    if(meta.id!==candidate.gmail_id||meta.threadId!==candidate.thread_id||!Array.isArray(meta.labelIds)||!meta.internalDate)throw new Problem(422,"gmail_invalid_metadata");
    const config=await db.prepare("SELECT value FROM app_metadata WHERE key='gmail_label_ids'").first<{value:string}>();const ids=config?.value?JSON.parse(config.value) as Record<string,string>:{};
    const labelEntries=Object.entries(ids);const root=ids["Job search"];const labelsNow=meta.labelIds;
    const withinFloor=Number(meta.internalDate)>=Date.parse(env.HISTORICAL_START_DATE||"2026-09-30T07:00:00Z");
    const accepted=Boolean(root&&labelsNow.includes(root)&&!labelsNow.includes("TRASH")&&!labelsNow.includes("DRAFT")&&withinFloor);
    const headers:Record<string,string>={};for(const h of meta.payload?.headers||[])headers[h.name.toLowerCase()]=h.value.slice(0,2000);
    const priorInstance=await db.prepare("SELECT state FROM gmail_message_instances WHERE mailbox=? AND gmail_id=?").bind(account,candidate.gmail_id).first<{state:string}>();
    const instanceId=await digest(`gmail-instance:${account}:${candidate.gmail_id}`);const now=new Date().toISOString();const held=labelsNow.filter(id=>labelEntries.some(([,value])=>value===id));
    const status=accepted?"pending":"excluded";const reason=accepted?null:!withinFloor?"before_import_floor":!root?"root_label_unconfigured":!labelsNow.includes(root)?"root_label_removed":"excluded_system_label";
    await fencedBatch(env,owner,epoch,connectionGeneration,[
      db.prepare("INSERT INTO gmail_message_instances(id,mailbox,gmail_id,thread_id,internet_message_id,labels_json,internal_date,original_date,sender,subject,available,state,review_reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mailbox,gmail_id) DO UPDATE SET thread_id=excluded.thread_id,labels_json=excluded.labels_json,internal_date=excluded.internal_date,original_date=excluded.original_date,sender=excluded.sender,subject=excluded.subject,available=excluded.available,state=CASE WHEN gmail_message_instances.state IN ('imported','review','alert_only') THEN gmail_message_instances.state ELSE excluded.state END,review_reason=CASE WHEN gmail_message_instances.state IN ('imported','review','alert_only') THEN gmail_message_instances.review_reason ELSE excluded.review_reason END,updated_at=excluded.updated_at")
        .bind(instanceId,account,candidate.gmail_id,candidate.thread_id,headers["message-id"]||null,JSON.stringify(held),new Date(Number(meta.internalDate)).toISOString(),headers.date&&Number.isFinite(Date.parse(headers.date))?new Date(headers.date).toISOString():null,(headers.from||"").slice(0,320),(headers.subject||"").slice(0,500),accepted?1:0,status,reason,now),
      db.prepare("UPDATE gmail_candidates SET stage=CASE WHEN ?='sweep' AND ?=1 AND ?='excluded' THEN 'body' WHEN ?='sweep' THEN 'done' WHEN ?=1 THEN 'body' ELSE 'done' END,reason=?,updated_at=? WHERE mailbox=? AND gmail_id=? AND stage=?").bind(candidate.stage,accepted?1:0,priorInstance?.state||"",candidate.stage,accepted?1:0,reason,now,account,candidate.gmail_id,candidate.stage),
      db.prepare("INSERT INTO app_metadata(key,value) VALUES('gmail_metadata_turn',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(candidate.stage),
      db.prepare("UPDATE message_references SET available=EXISTS(SELECT 1 FROM gmail_message_instances g WHERE g.canonical_id=message_references.id AND g.available=1) WHERE id=(SELECT canonical_id FROM gmail_message_instances WHERE mailbox=? AND gmail_id=?) AND account_id=? AND EXISTS(SELECT 1 FROM gmail_message_instances own WHERE own.canonical_id=message_references.id AND own.gmail_id=message_references.immutable_id)").bind(account,candidate.gmail_id,account),
    ]);return true;
  }catch(error){if(error instanceof ExecutionBudgetExceeded)throw error;if(error instanceof Problem&&error.code==="gmail_permission_required"){await noteCandidateFailure(env,owner,epoch,connectionGeneration,candidate.gmail_id,candidate.stage as "metadata"|"sweep",error);throw error;}if(error instanceof Problem&&error.code==="gmail_reconnect_required")throw error;await noteCandidateFailure(env,owner,epoch,connectionGeneration,candidate.gmail_id,candidate.stage as "metadata"|"sweep",error);if(error instanceof Problem&&[404,413,422].includes(error.status))return true;throw error;}
}
export async function gmailBodyCandidate(env:Env,owner:string,epoch:string,connectionGeneration:string):Promise<boolean>{
  const db=env.JOB_SEARCH_DB;await leaseAndEpoch(env,owner,epoch,connectionGeneration);await assertNoGmailCooldown(env);const account=gmailMailbox(env);
  const candidate=await db.prepare("SELECT c.gmail_id,c.thread_id,i.id,i.canonical_id,i.state,(SELECT value FROM app_metadata WHERE key='gmail_label_ids') AS label_config FROM gmail_candidates c JOIN gmail_message_instances i ON i.mailbox=c.mailbox AND i.gmail_id=c.gmail_id WHERE c.mailbox=? AND c.stage='body' AND c.next_attempt_at<=? ORDER BY c.next_attempt_at,c.created_at,c.gmail_id LIMIT 1").bind(account,Date.now()).first<{gmail_id:string;thread_id:string;id:string;canonical_id:string|null;state:string;label_config:string|null}>();if(!candidate)return false;
  try{
    const message=await gmailApi<GmailMessage>(env,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(candidate.gmail_id)}?format=full`,20,4);
    if(message.id!==candidate.gmail_id||message.threadId!==candidate.thread_id||!Array.isArray(message.labelIds)||!message.internalDate)throw new Problem(422,"gmail_invalid_message");
    const ids=candidate.label_config?JSON.parse(candidate.label_config) as Record<string,string>:{};
    const root=ids["Job search"];if(!root||!message.labelIds.includes(root)||message.labelIds.includes("TRASH")||message.labelIds.includes("DRAFT")){await fencedBatch(env,owner,epoch,connectionGeneration,[
      db.prepare("UPDATE gmail_message_instances SET available=0,state='excluded',review_reason='root_label_removed',updated_at=? WHERE mailbox=? AND gmail_id=?").bind(new Date().toISOString(),account,candidate.gmail_id),
      db.prepare("UPDATE gmail_candidates SET stage='done',reason='root_label_removed',updated_at=? WHERE mailbox=? AND gmail_id=?").bind(new Date().toISOString(),account,candidate.gmail_id),
      db.prepare("UPDATE message_references SET available=EXISTS(SELECT 1 FROM gmail_message_instances g WHERE g.canonical_id=message_references.id AND g.available=1) WHERE id=(SELECT canonical_id FROM gmail_message_instances WHERE mailbox=? AND gmail_id=?) AND account_id=? AND EXISTS(SELECT 1 FROM gmail_message_instances own WHERE own.canonical_id=message_references.id AND own.gmail_id=message_references.immutable_id)").bind(account,candidate.gmail_id,account)]);return true;}
    const extracted=extractGmailText(message);let bodyText=extracted.text;
    const external=extracted.textAttachments.find(part=>part.mimeType==="text/plain")||(!bodyText?extracted.textAttachments[0]:undefined);
    if(external&&(!bodyText||external.mimeType==="text/plain")){
      const attachment=await gmailApi<{data?:string;size?:number}>(env,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(candidate.gmail_id)}/attachments/${encodeURIComponent(external.attachmentId)}`,20,0);
      if(!attachment.data||Number(attachment.size||0)>65536)throw new Problem(413,"gmail_text_attachment_oversize");
      let encoded=attachment.data.replaceAll("-","+").replaceAll("_","/");encoded+="=".repeat((4-encoded.length%4)%4);let bytes:Uint8Array;
      try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));}catch{throw new Problem(422,"gmail_text_attachment_invalid");}
      if(bytes.byteLength>65536)throw new Problem(413,"gmail_text_attachment_oversize");bodyText=projectText(decodeText(bytes,external.charset),external.mimeType).slice(0,6000).trim();
    }
    const unsupported=extracted.unsupported||Boolean(!bodyText&&extracted.textAttachments.length);
    const internalDate=Number(message.internalDate);const original=extracted.headers.date&&Number.isFinite(Date.parse(extracted.headers.date))?new Date(extracted.headers.date).toISOString():null;
    const farApart=Boolean(original&&Math.abs(Date.parse(original)-internalDate)>7*86400000);const floor=Date.parse(env.HISTORICAL_START_DATE||"2026-09-30T07:00:00Z");
    const tooOld=Boolean(original&&Date.parse(original)<floor);const labelNames=Object.entries(ids).filter(([,id])=>message.labelIds!.includes(id)).map(([name])=>name);
    const lifecycleLabels=["Application receipts","Recruiter follow ups","Interviews","Offers","Rejections"].filter(name=>labelNames.includes(name));
    const reasons:string[]=[];if(labelNames.includes("Review"))reasons.push("owner_review_label");if(lifecycleLabels.length>1||labelNames.includes("Job alerts")&&lifecycleLabels.length>0)reasons.push("conflicting_lifecycle_labels");if(unsupported)reasons.push("unsupported_mime_or_attachment");if(!original)reasons.push("missing_original_date");if(farApart)reasons.push("original_date_differs_from_receipt");if(tooOld)reasons.push("before_import_floor");if(!bodyText)reasons.push("empty_or_attachment_only_body");
    const alertOnly=!reasons.length&&labelNames.includes("Job alerts")&&!/application|interview|recruiter|offer|rejection|assessment|hiring|employment/i.test(`${extracted.headers.subject||""}\n${bodyText}`);
    const now=new Date().toISOString();const instance=candidate;
    let canonical=instance.canonical_id;let aliased=false;const date=original||new Date(internalDate).toISOString();const internetId=(extracted.headers["message-id"]||"").trim();
    if(!reasons.length&&internetId){
      const prior=(await db.prepare("SELECT id,subject,sender,occurred_at,excerpt FROM message_references WHERE lower(internet_message_id)=lower(?) LIMIT 2").bind(internetId).all<{id:string;subject:string;sender:string;occurred_at:string;excerpt:string|null}>()).results;
      if(prior.length){const one=prior.length===1?prior[0]:null;const normalize=(v:string)=>v.trim().replace(/\s+/g," ").toLowerCase();const compatible=one&&normalize(one.subject)===normalize(extracted.headers.subject||"")&&normalize(one.sender)===normalize(extracted.headers.from||"")&&Math.abs(Date.parse(one.occurred_at)-Date.parse(date))<=7*86400000&&Boolean(one.excerpt)&&Boolean(bodyText)&&normalize(one.excerpt||"").includes(normalize(bodyText.slice(0,100)));
        if(compatible){canonical=one!.id;aliased=true;}else reasons.push("internet_message_id_collision");}
    }
    if(!reasons.length&&!alertOnly&&aliased){
      await fencedBatch(env,owner,epoch,connectionGeneration,[
      db.prepare("UPDATE gmail_message_instances SET canonical_id=?,internet_message_id=?,excerpt=?,content_hash=?,state='imported',review_reason=NULL,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(canonical,internetId||null,bodyText.slice(0,1500),await digest(bodyText),now,account,candidate.gmail_id),
        db.prepare("UPDATE gmail_candidates SET stage='done',reason='validated_legacy_alias',updated_at=? WHERE mailbox=? AND gmail_id=?").bind(now,account,candidate.gmail_id),
      ]);
    }else if(!reasons.length&&!alertOnly){
      canonical ||= await digest(`gmail:${account}:${candidate.gmail_id}`);const excerpt=bodyText.slice(0,1500);const contentHash=await digest(JSON.stringify([candidate.gmail_id,internetId,date,extracted.headers.subject||"",extracted.headers.from||"",excerpt]));
      await fencedBatch(env,owner,epoch,connectionGeneration,[
        db.prepare("INSERT OR IGNORE INTO message_references(id,account_id,immutable_id,conversation_id,internet_message_id,subject,sender,occurred_at,web_link,excerpt,content_hash,available,updated_at,processed_hash) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,1,?,NULL)")
          .bind(canonical,account,candidate.gmail_id,`gmail:${account}:${candidate.thread_id}`,internetId||null,(extracted.headers.subject||"").slice(0,500),(extracted.headers.from||"").slice(0,320),date,excerpt,contentHash,now),
        db.prepare("INSERT OR IGNORE INTO message_folders(message_id,folder) VALUES(?,?)").bind(canonical,message.labelIds.includes("SENT")?"sentitems":"inbox"),
        db.prepare("UPDATE gmail_message_instances SET canonical_id=?,internet_message_id=?,excerpt=?,content_hash=?,state='pending',review_reason=NULL,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(canonical,internetId||null,excerpt,contentHash,now,account,candidate.gmail_id),
        db.prepare("UPDATE gmail_candidates SET stage='process',reason=NULL,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(now,account,candidate.gmail_id),
      ]);
    }else{
      const reason=alertOnly?"alert_only":reasons.join(",")||"review_required";
      const reviewWrites:D1PreparedStatement[]=[];
      if(!alertOnly){canonical ||= await digest(`gmail-review:${account}:${candidate.gmail_id}`);const excerpt=bodyText.slice(0,1500);const contentHash=await digest(JSON.stringify([candidate.gmail_id,internetId,date,extracted.headers.subject||"",extracted.headers.from||"",excerpt]));
        reviewWrites.push(db.prepare("INSERT OR IGNORE INTO message_references(id,account_id,immutable_id,conversation_id,internet_message_id,subject,sender,occurred_at,web_link,excerpt,content_hash,available,updated_at,processed_hash) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,1,?,?)")
          .bind(canonical,account,candidate.gmail_id,`gmail:${account}:${candidate.thread_id}`,internetId||null,(extracted.headers.subject||"").slice(0,500),(extracted.headers.from||"").slice(0,320),date,excerpt,contentHash,now,contentHash));}
      reviewWrites.push(
        db.prepare("UPDATE gmail_message_instances SET canonical_id=?,internet_message_id=?,excerpt=?,state=?,review_reason=?,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(canonical,internetId||null,bodyText.slice(0,1500),alertOnly?"alert_only":"review",reason,now,account,candidate.gmail_id),
        db.prepare("UPDATE gmail_candidates SET stage='done',reason=?,updated_at=? WHERE mailbox=? AND gmail_id=?").bind(reason,now,account,candidate.gmail_id),
      );
      if(!alertOnly&&canonical)reviewWrites.push(db.prepare("INSERT INTO reconciliation_matches(id,source,source_id,application_id,state,reason) VALUES(?,'email',?,NULL,'needs_review',?) ON CONFLICT(source,source_id) DO UPDATE SET state='needs_review',reason=excluded.reason WHERE reconciliation_matches.manual=0").bind(crypto.randomUUID(),canonical,`Gmail review: ${reason}`));
      await fencedBatch(env,owner,epoch,connectionGeneration,reviewWrites);
    }
    return true;
  }catch(error){if(error instanceof ExecutionBudgetExceeded)throw error;if(error instanceof Problem&&error.code==="gmail_permission_required"){await noteCandidateFailure(env,owner,epoch,connectionGeneration,candidate.gmail_id,"body",error);throw error;}if(error instanceof Problem&&error.code==="gmail_reconnect_required")throw error;await noteCandidateFailure(env,owner,epoch,connectionGeneration,candidate.gmail_id,"body",error);if(error instanceof Problem&&[404,413,422].includes(error.status))return true;throw error;}
}
export async function gmailJson<T>(url: string, token: string, init: RequestInit = {}, budgetEnv?:Env): Promise<T> {
  const parsed = new URL(url); if (parsed.origin !== "https://gmail.googleapis.com") throw new Problem(502,"gmail_unsafe_url");
  // Access-token and provider calls share the per-Workflow ordinary-operation cap.
  // OAuth callback routes without a scoped budget remain outside Workflow metering.
  // Gmail calls receive the capability through their scoped Worker environment.
  if(budgetEnv)reserveExternal(budgetEnv);
  const response = await fetch(url,{...init,redirect:"manual",headers:{...init.headers,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  if (!response.ok) {
    const retry = response.headers.get("Retry-After"); const seconds=retry && /^\d{1,4}$/.test(retry)?Number(retry):30;
    let reason="";try{const body=await boundedText(response,8192);const json=JSON.parse(body) as {error?:{status?:string;errors?:{reason?:string}[]}};reason=json.error?.errors?.[0]?.reason || json.error?.status || "";}catch{/* never return provider text */}
    if(response.status===401)throw new Problem(401,"gmail_access_expired");
    if(response.status===404)throw new Problem(404,"gmail_message_unavailable");
    if(response.status===400&&parsed.searchParams.has("pageToken")&&/invalidArgument|failedPrecondition/i.test(reason))throw new Problem(409,"gmail_page_token_invalid");
    if(response.status===403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason))throw new Problem(429,"gmail_quota_limited",Math.max(30,Math.min(900,seconds)));
    if(response.status===403)throw new Problem(403,"gmail_permission_required");
    if(response.status===429)throw new Problem(429,"gmail_quota_limited",Math.max(30,Math.min(900,seconds)));
    throw new Problem(response.status>=500?503:502,"gmail_provider_failed",Math.max(30,Math.min(900,seconds)));
  }
  const raw = await boundedText(response,1_048_576);
  try{return JSON.parse(raw) as T;}catch{throw new Problem(502,"gmail_invalid_response");}
}
async function gmailApi<T>(env:Env,url:string,units=20,rows=1):Promise<T>{
  for(let attempt=0;attempt<2;attempt++){
    const session=await gmailToken(env);if(!session)throw new Problem(409,"gmail_connection_required");
    await reserveGmailCall(env,units,rows);
    try{return await gmailJson<T>(url,session.token,{},env);}catch(error){if(!(error instanceof Problem)||error.status!==401||attempt===1)throw error;accessTokenCache.delete(env);}
  }
  throw new Problem(401,"gmail_access_expired");
}
async function assertNoGmailCooldown(env:Env):Promise<void>{const row=await env.JOB_SEARCH_DB.prepare("SELECT until_at FROM gmail_cooldowns WHERE mailbox=?").bind(gmailMailbox(env)).first<{until_at:number}>();if(row&&row.until_at>Date.now())throw new Problem(429,"gmail_cooldown_active",Math.max(30,Math.ceil((row.until_at-Date.now())/1000)));}
export async function gmailStatus(env: Env) {
  const connected=await env.JOB_SEARCH_DB.prepare("SELECT id,mailbox,status FROM gmail_connections ORDER BY connected_at DESC LIMIT 1").first<{id:string;mailbox:string;status:string}>();
  const config=await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='gmail_label_ids'").first<{value:string}>();
  const checked=await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='gmail_label_checked_at'").first<{value:string}>();
  const status=connected?.status === "reconnect_required" ? "reconnect_required" : connected?.status === "connected" ? "connected" : "disconnected";
  const counts=await env.JOB_SEARCH_DB.prepare("SELECT SUM(CASE WHEN stage<>'done' THEN 1 ELSE 0 END) pending,(SELECT COUNT(*) FROM gmail_message_instances WHERE state='review') review FROM gmail_candidates WHERE mailbox=?").bind(gmailMailbox(env)).first<{pending:number|null;review:number|null}>();
  const times=await env.JOB_SEARCH_DB.prepare("SELECT name,completed_at FROM gmail_checkpoints WHERE mailbox=? AND name IN ('recent','sweep')").bind(gmailMailbox(env)).all<{name:string;completed_at:string|null}>();
  const cooldown=await env.JOB_SEARCH_DB.prepare("SELECT until_at FROM gmail_cooldowns WHERE mailbox=?").bind(gmailMailbox(env)).first<{until_at:number}>();
  const parsed=config?.value?JSON.parse(config.value) as Record<string,string>:{};
  const missing=labels.filter(name=>!parsed[name]);const checkedAt=checked?.value||null;const checkedTime=checkedAt?Date.parse(checkedAt):NaN;const labelCheckStale=!Number.isFinite(checkedTime)||Date.now()-checkedTime>24*3600000;
  return {configured:configured(env),connected:status==="connected",accountEmail:connected?.mailbox||null,status:configured(env)?status:"setup_required",labels:{ready:!missing.length&&!labelCheckStale,missing,labelCheckStale,checkedAt},
    lastRecentPollAt:times.results.find(x=>x.name==="recent")?.completed_at||null,lastSweepAt:times.results.find(x=>x.name==="sweep")?.completed_at||null,
    pending:Number(counts?.pending||0),review:Number(counts?.review||0),coverageWarning:cooldown&&cooldown.until_at>Date.now()?"Gmail imports are paused while provider access recovers.":"Unlabelled Spam/Junk, Live Sent mail, and messages outside the Job search label are not read."};
}
export async function gmailDiscoverPage(env:Env,owner:string,expectedGeneration:string,connectionGeneration:string):Promise<{done:boolean;discovered:number}> {
  const db=env.JOB_SEARCH_DB;const now=new Date().toISOString();await leaseAndEpoch(env,owner,expectedGeneration,connectionGeneration);
  const labelRow=await db.prepare("SELECT value FROM app_metadata WHERE key='gmail_label_ids'").first<{value:string}>();
  const labelIds:Record<string,string>=labelRow?.value?JSON.parse(labelRow.value) as Record<string,string>:{};
  const root=labelIds["Job search"];if(!root)throw new Problem(409,"gmail_labels_missing");
  const account=gmailMailbox(env);const floor=Date.parse(env.HISTORICAL_START_DATE||"2026-09-30T07:00:00Z");if(!Number.isFinite(floor)||floor<0)throw new Problem(503,"historical_date_required");
  const baseline=await db.prepare("SELECT cursor,window_start,window_end,target_end FROM gmail_checkpoints WHERE mailbox=? AND name='baseline'").bind(account).first<{cursor:string|null;window_start:number|null;window_end:number|null;target_end:number|null}>();
  let checkpoint=baseline;let checkpointName="baseline";let start=baseline?.window_start??floor;let targetEnd=baseline?.target_end??Date.now();let end=baseline?.window_end??Math.min(targetEnd,start+86400000);
  if(start>=targetEnd){
    const sweep=await db.prepare("SELECT cursor,window_start,window_end,target_end,completed_at,updated_at FROM gmail_checkpoints WHERE mailbox=? AND name='sweep'").bind(account).first<{cursor:string|null;window_start:number|null;window_end:number|null;target_end:number|null;completed_at:string|null;updated_at:string}>();
    const recent=await db.prepare("SELECT cursor,window_start,window_end,target_end,updated_at FROM gmail_checkpoints WHERE mailbox=? AND name='recent'").bind(account).first<{cursor:string|null;window_start:number|null;window_end:number|null;target_end:number|null;updated_at:string}>();
    const sweepDoneAt=sweep?.completed_at?Date.parse(sweep.completed_at):0;
    const sweepComplete=Boolean(sweep&&sweep.window_start!==null&&sweep.target_end!==null&&sweep.window_start>=sweep.target_end);
    const sweepDue=!sweepComplete||Date.now()-sweepDoneAt>=7*86400000;
    const chooseRecent=!sweepDue||(recent?Date.parse(recent.updated_at)<=Date.parse(sweep?.updated_at||"1970-01-01T00:00:00.000Z"):!sweepComplete);
    if(sweepDue&&!chooseRecent){checkpoint=sweep;checkpointName="sweep";start=sweep?.window_start??floor;targetEnd=sweep?.target_end??Date.now();end=sweep?.window_end??Math.min(targetEnd,start+86400000);if(sweepComplete){start=floor;targetEnd=Date.now();end=Math.min(targetEnd,start+86400000);}}
    else{
      checkpoint=recent;checkpointName="recent";
      if(recent?.cursor){start=recent.window_start??Math.max(floor,Date.now()-7*86400000);end=recent.window_end??Date.now();targetEnd=recent.target_end??end;}
      else{targetEnd=Date.now();end=targetEnd;start=Math.max(floor,end-7*86400000);}
    }
  }
  const pageSize=1;const day=new Date().toISOString().slice(0,10);
  const reserved=await db.prepare("INSERT INTO gmail_budget(day,lists) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET lists=lists+1 WHERE lists+1<=100 RETURNING day").bind(day).first();
  if(!reserved)throw new Problem(429,"gmail_daily_budget_exhausted",3600);
  const after=Math.max(0,Math.floor(start/1000)-1);const before=Math.floor(end/1000);
  const query=new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");query.searchParams.set("maxResults",String(pageSize));query.searchParams.set("includeSpamTrash","true");query.searchParams.append("labelIds",root);query.searchParams.set("q",`after:${after} before:${before} -in:trash -in:drafts`);
  if(checkpoint?.cursor&&checkpoint.cursor!=="__restart__")query.searchParams.set("pageToken",checkpoint.cursor);
  let page:GmailList;
  try{page=await gmailApi<GmailList>(env,query.href,5,0);}catch(error){if(error instanceof Problem&&error.code==="gmail_permission_required")await markPermissionReconnect(env,owner,expectedGeneration,connectionGeneration);if(error instanceof Problem&&error.code==="gmail_page_token_invalid"){
      // An expired page token restarts the same fixed window; deduplication is by immutable Gmail ID.
      await fencedBatch(env,owner,expectedGeneration,connectionGeneration,[db.prepare("UPDATE gmail_checkpoints SET cursor='__restart__',updated_at=? WHERE mailbox=? AND name=?").bind(now,account,checkpointName)]);return {done:false,discovered:0};}throw error;}
  if(page.messages!==undefined&&(!Array.isArray(page.messages)||page.messages.length>pageSize))throw new Problem(502,"gmail_invalid_list_page");
  const pageMessages=page.messages||[];
  if(pageMessages.length){const rows=await db.prepare("UPDATE gmail_budget SET rows_written=rows_written+? WHERE day=? AND rows_written+?<=50000 RETURNING day").bind(pageMessages.length,day,pageMessages.length).first();if(!rows)throw new Problem(429,"gmail_daily_budget_exhausted",3600);}
  const statements:D1PreparedStatement[]=[];
  for(const item of pageMessages){if(!item.id||item.id.length>1000||!item.threadId||item.threadId.length>1000)throw new Problem(502,"gmail_invalid_list_item");
    statements.push(db.prepare("INSERT INTO gmail_candidates(mailbox,gmail_id,thread_id,stage,attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'metadata',0,0,?,?) ON CONFLICT(mailbox,gmail_id) DO UPDATE SET thread_id=excluded.thread_id,stage=CASE WHEN EXISTS(SELECT 1 FROM gmail_message_instances i WHERE i.mailbox=excluded.mailbox AND i.gmail_id=excluded.gmail_id) THEN 'sweep' ELSE 'metadata' END,attempts=0,next_attempt_at=0,updated_at=excluded.updated_at WHERE gmail_candidates.stage='done'").bind(account,item.id,item.threadId,now,now));}
  let nextStart=start;let nextEnd=end;const nextCursor=page.nextPageToken||null;
  if(!nextCursor){
    if(checkpointName==="baseline"||checkpointName==="sweep"){nextStart=end;nextEnd=Math.min(targetEnd,end+86400000);if(nextStart>=targetEnd)nextEnd=targetEnd;}
    else{nextStart=start;nextEnd=end;}
  }
  const sweepFinished=checkpointName==="sweep"&&!nextCursor&&nextStart>=targetEnd;
  const crawlFinished=checkpointName==="baseline"&&!nextCursor&&nextStart>=targetEnd;
  statements.push(db.prepare("INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(mailbox,name) DO UPDATE SET cursor=excluded.cursor,window_start=excluded.window_start,window_end=excluded.window_end,target_end=excluded.target_end,completed_at=excluded.completed_at,updated_at=excluded.updated_at")
    .bind(account,checkpointName,nextCursor,nextCursor?start:nextStart,nextCursor?end:nextEnd,targetEnd,!nextCursor&&(checkpointName==="recent"||sweepFinished||crawlFinished)?now:null,now));
  await fencedBatch(env,owner,expectedGeneration,connectionGeneration,statements);
  return {done:!page.nextPageToken&&(checkpointName==="recent"||nextStart>=targetEnd),discovered:pageMessages.length};
}
export async function gmailRefreshLabels(env:Env,owner:string,expectedGeneration:string,connectionGeneration:string):Promise<void>{
  await leaseAndEpoch(env,owner,expectedGeneration,connectionGeneration);
  let list:{labels?:{id:string;name:string}[]};try{list=await gmailApi<{labels?:{id:string;name:string}[]}>(env,"https://gmail.googleapis.com/gmail/v1/users/me/labels",1,0);}catch(error){if(error instanceof Problem&&error.code==="gmail_permission_required")await markPermissionReconnect(env,owner,expectedGeneration,connectionGeneration);throw error;}
  const apiLabels=list.labels||[];const next:Record<string,string>={};
  for(const name of labels){const exact=name==="Job search"?name:`Job search/${name}`;const found=apiLabels.find(item=>item.name===exact);if(found)next[name]=found.id;}
  const stamp=new Date().toISOString();
  await fencedBatch(env,owner,expectedGeneration,connectionGeneration,[
    env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata(key,value) VALUES('gmail_label_ids',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(next)),
    env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata(key,value) VALUES('gmail_label_checked_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(stamp),
  ]);
  if(labels.some(name=>!next[name]))throw new Problem(409,"gmail_labels_missing");
}
export function extractGmailText(message:GmailMessage): {text:string;headers:Record<string,string>;unsupported:boolean;textAttachments:{mimeType:string;attachmentId:string;charset:string}[]} {
  const root=message.payload;if(!root)throw new Problem(422,"gmail_payload_missing");
  let count=0;let decoded=0;let selected="";let selectedPlain=false;const textAttachments:{mimeType:string;attachmentId:string;charset:string}[]=[];const headers:Record<string,string>={};
  for(const h of root.headers||[])if(["from","subject","date","message-id"].includes(h.name.toLowerCase()))headers[h.name.toLowerCase()]=h.value.slice(0,2000);
  const walk=(part:GmailPart,depth:number)=>{if(depth>20||++count>100)throw new Problem(422,"gmail_mime_unsupported");const mime=(part.mimeType||"").toLowerCase();
    if(part.filename){/* Binary and named attachments are not part of the classification body. */}
    else if((mime==="text/plain"||mime==="text/html")&&part.body?.attachmentId){if(textAttachments.length<2)textAttachments.push({mimeType:mime,attachmentId:part.body.attachmentId,charset:partCharset(part)});}
    else if((mime==="text/plain"||mime==="text/html")&&part.body?.data&&(!selected||mime==="text/plain"&&!selectedPlain)){let raw=part.body.data.replaceAll("-","+").replaceAll("_","/");raw+="=".repeat((4-raw.length%4)%4);let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(raw),c=>c.charCodeAt(0));}catch{throw new Problem(422,"gmail_mime_invalid");}decoded+=bytes.byteLength;if(decoded>65536)throw new Problem(422,"gmail_mime_oversize");const content=decodeText(bytes,partCharset(part));if(mime==="text/plain"){if(!selectedPlain)selected=content;selectedPlain=true;}else if(!selectedPlain)selected=projectText(content,mime);}
    for(const child of part.parts||[])walk(child,depth+1);
  };walk(root,0);const text=selected.slice(0,6000).trim();return {text,headers,unsupported:!text&&!textAttachments.length,textAttachments};
}
function partCharset(part:GmailPart):string{const contentType=part.headers?.find(header=>header.name.toLowerCase()==="content-type")?.value||"";return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase()||"utf-8";}
function decodeText(bytes:Uint8Array,charset:string):string{if(!["utf-8","utf8","us-ascii","ascii","iso-8859-1","latin1","windows-1252"].includes(charset))throw new Problem(422,"gmail_mime_charset_unsupported");try{return new TextDecoder(charset,{fatal:true}).decode(bytes);}catch{throw new Problem(422,"gmail_mime_charset_unsupported");}}
function projectText(content:string,mimeType:string):string{if(mimeType!=="text/html")return content;let visible="";let ignored=0;const parser=new Parser({onopentag(n){if(["script","style","template"].includes(n))ignored++;},ontext(v){if(!ignored)visible+=v.slice(0,65536-visible.length);},onclosetag(n){if(ignored&&["script","style","template"].includes(n))ignored--; }},{decodeEntities:true});parser.end(content.slice(0,65536));return visible;}
export { labels as gmailLabelNames, scope as GMAIL_SCOPE };

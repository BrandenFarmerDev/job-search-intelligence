import { base64url, decrypt, digest, encrypt, Problem, providerJson, randomToken, safeLink, text } from "./security";
import { Parser } from "htmlparser2";

const scopes = "offline_access User.Read Mail.Read";
const tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
interface Tokens { access_token: string; refresh_token?: string; scope?: string }
interface Connection { account_id: string; encrypted_credentials: string }
export interface GraphMessage {
  id: string; subject?: string; bodyPreview?: string; from?: { emailAddress?: { address?: string; name?: string } };
  conversationId?: string; internetMessageId?: string; receivedDateTime?: string; sentDateTime?: string;
  webLink?: string; "@removed"?: { reason: string };
  lastModifiedDateTime?: string;
}
export interface GraphPage { value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }
function assertConfigured(env: Env) {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.HISTORICAL_START_DATE) throw new Problem(503, "microsoft_setup_required");
}
export async function beginMicrosoft(env: Env, owner: string): Promise<Response> {
  assertConfigured(env);
  const state = randomToken(); const verifier = randomToken();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await env.JOB_SEARCH_DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(Date.now()).run();
  await env.JOB_SEARCH_DB.prepare("INSERT INTO oauth_states VALUES(?,?,?,?)").bind(await digest(state), owner, verifier, Date.now() + 600000).run();
  const url = new URL("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
  url.search = new URLSearchParams({ client_id: env.MICROSOFT_CLIENT_ID, response_type: "code", redirect_uri: env.MICROSOFT_REDIRECT_URI,
    scope: scopes, state, code_challenge: challenge, code_challenge_method: "S256", response_mode: "query" }).toString();
  return Response.json({ url: url.href }, { headers: { "Set-Cookie": `job_oauth=${state}; Path=/api/job-intelligence/connections/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
}
async function exchange(env: Env, fields: Record<string, string>): Promise<Tokens> {
  const tokens = await providerJson<Tokens>(tokenUrl, { method: "POST", body: new URLSearchParams({ client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, scope: scopes, ...fields }) });
  if (!tokens.access_token || tokens.scope?.split(" ").some((scope) => /mail\.send/i.test(scope))) throw new Problem(502, "invalid_provider_scope");
  return tokens;
}
export async function completeMicrosoft(request: Request, env: Env, owner: string): Promise<Response> {
  assertConfigured(env);
  const params = new URL(request.url).searchParams; const state = params.get("state"); const code = params.get("code");
  const cookie = request.headers.get("Cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith("job_oauth="))?.slice(10);
  if (!state || !code || state !== cookie || state.length > 100 || code.length > 4096) throw new Problem(400, "invalid_oauth_state");
  const row = await env.JOB_SEARCH_DB.prepare("DELETE FROM oauth_states WHERE state_hash=? AND owner=? AND expires_at>? RETURNING verifier")
    .bind(await digest(state), owner, Date.now()).first<{ verifier: string }>();
  if (!row) throw new Problem(400, "expired_oauth_state");
  const tokens = await exchange(env, { grant_type: "authorization_code", code, redirect_uri: env.MICROSOFT_REDIRECT_URI, code_verifier: row.verifier });
  const profile = await providerJson<{ id: string; mail?: string; userPrincipalName?: string }>("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if ((profile.mail || profile.userPrincipalName || "").toLowerCase() !== env.OWNER_EMAIL.toLowerCase() || !tokens.refresh_token) throw new Problem(403, "mailbox_owner_required");
  const encrypted = await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY, `microsoft:${profile.id}`);
  await env.JOB_SEARCH_DB.prepare("INSERT INTO connections VALUES('microsoft',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET account_id=excluded.account_id,encrypted_credentials=excluded.encrypted_credentials,updated_at=excluded.updated_at")
    .bind(profile.id, encrypted, new Date().toISOString(), new Date().toISOString()).run();
  await env.JOB_SEARCH_DB.prepare("INSERT INTO app_metadata VALUES('sync_paused','false') ON CONFLICT(key) DO UPDATE SET value='false'").run();
  return new Response(null, { status: 303, headers: { Location: env.ALLOWED_ORIGIN, "Set-Cookie": "job_oauth=; Path=/api/job-intelligence/connections/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=0" } });
}
export async function microsoftToken(env: Env): Promise<{ account: string; token: string } | null> {
  const connection = await env.JOB_SEARCH_DB.prepare("SELECT account_id,encrypted_credentials FROM connections WHERE provider='microsoft'").first<Connection>();
  if (!connection) return null;
  assertConfigured(env);
  const refresh = await decrypt(connection.encrypted_credentials, env.TOKEN_ENCRYPTION_KEY, `microsoft:${connection.account_id}`);
  const tokens = await exchange(env, { grant_type: "refresh_token", refresh_token: refresh });
  if (tokens.refresh_token) await env.JOB_SEARCH_DB.prepare("UPDATE connections SET encrypted_credentials=?,updated_at=? WHERE provider='microsoft'")
    .bind(await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY, `microsoft:${connection.account_id}`), new Date().toISOString()).run();
  return { account: connection.account_id, token: tokens.access_token };
}
export function initialDelta(folder: string, start: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/.test(start) || !Number.isFinite(Date.parse(start))) throw new Problem(503, "historical_date_required");
  const url = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta`);
  url.searchParams.set("$select", "id,internetMessageId,conversationId,subject,from,receivedDateTime,sentDateTime,bodyPreview,webLink,lastModifiedDateTime");
  url.searchParams.set("$filter", `receivedDateTime ge ${start.length === 10 ? `${start}T00:00:00Z` : start}`);
  return url.href;
}
export function validateDelta(value: string, folder: string): string {
  const url = new URL(value);
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || url.pathname !== `/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta`) throw new Problem(502, "unsafe_graph_cursor");
  return url.href;
}
export async function graphPage(url: string, folder: string, token: string): Promise<GraphPage> {
  const page = await providerJson<GraphPage>(validateDelta(url, folder), { headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId", odata.maxpagesize=100' } });
  if (!Array.isArray(page.value) || page.value.length > 1000 || page.value.some((item) => !item.id || item.id.length > 1000)) throw new Problem(502, "invalid_graph_page");
  for (const cursor of [page["@odata.nextLink"], page["@odata.deltaLink"]]) if (cursor) validateDelta(cursor, folder);
  return page;
}
export function projectMessage(message: GraphMessage, folder: string) {
  const occurred = folder === "sentitems" ? message.sentDateTime : message.receivedDateTime;
  if (!occurred || !Number.isFinite(Date.parse(occurred))) throw new Problem(502, "invalid_message_date");
  return { subject: text(message.subject, 500), sender: text(message.from?.emailAddress?.address, 320), excerpt: text(message.bodyPreview, 1500),
    occurredAt: new Date(occurred).toISOString(), webLink: safeLink(message.webLink || "", true), conversationId: text(message.conversationId, 1000), internetId: text(message.internetMessageId, 1000), revision:text(message.lastModifiedDateTime,100) };
}
export function bodyText(content:string,contentType:string):string {
  if (contentType.toLowerCase() === "text") return content.slice(0,6000).trim();
  let output="";let ignored=0;
  const blocks=new Set(["br","p","div","li","tr","h1","h2","h3"]);
  const parser=new Parser({
    onopentag(name){if(ignored || ["script","style","template"].includes(name))ignored++;else if(blocks.has(name))output+="\n";},
    ontext(value){if(!ignored && output.length<6000)output+=value.slice(0,6000-output.length);},
    onclosetag(name){if(ignored)ignored--;else if(blocks.has(name))output+="\n";},
  },{decodeEntities:true,lowerCaseTags:true});
  parser.end(content.slice(0,65536));return output.slice(0,6000).trim();
}
export async function graphBody(id:string,token:string):Promise<string> {
  const message=await providerJson<{body?:{content?:unknown;contentType?:unknown}}>(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=body`,{headers:{Authorization:`Bearer ${token}`,Prefer:'IdType="ImmutableId", outlook.body-content-type="text"'}});
  if(typeof message.body?.content !== "string" || typeof message.body.contentType !== "string")throw new Problem(502,"invalid_message_body");
  return bodyText(message.body.content,message.body.contentType);
}

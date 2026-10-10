import type { ApplicationListResponse, ApplicationRecord } from "@job-search/shared";
import { isEventType } from "@job-search/shared";
import { dashboard, csv } from "../services/dashboard";
import { beginMicrosoft, completeMicrosoft } from "../services/microsoft";
import { Problem, readJson, safeLink, text, type Principal } from "../services/security";
import { acquireLease } from "../services/sync";
import { dateValue } from "../services/sheets";
import { ingestLocalOutlookBatch } from "../services/local-outlook";

// Request values only select a key here; the SQL fragments are fixed. The legacy `date` key maps to newest-applied.
const applicationOrder = new Map([["applied_desc", "applied_at DESC"], ["date", "applied_at DESC"], ["applied_asc", "applied_at ASC"], ["company", "company COLLATE NOCASE ASC"], ["status", "status ASC"], ["updated", "updated_at DESC"]]);
export async function intelligenceRoute(request: Request, env: Env, principal: Principal): Promise<Response> {
  const path = new URL(request.url).pathname;
  const mutation = !["GET","HEAD"].includes(request.method) || path.endsWith("/connections/microsoft/callback");
  if (!mutation || path.endsWith("/sync/run")) return route(request,env,principal);
  const lock=crypto.randomUUID();
  if (!(await acquireLease(env.JOB_SEARCH_DB,lock,true))) throw new Problem(409,"sync_running");
  try { return await route(request,env,principal); }
  finally { await env.JOB_SEARCH_DB.prepare("DELETE FROM sync_locks WHERE owner=?").bind(lock).run(); }
}
async function route(request: Request, env: Env, principal: Principal): Promise<Response> {
  const owner = principal.id; const automated = principal.kind === "automation";
  const url = new URL(request.url); const path = url.pathname.slice("/api/job-intelligence".length);
  const db = env.JOB_SEARCH_DB;
  if (path === "/session" && request.method === "GET") return new Response(null, {status:303,headers:{Location:env.ALLOWED_ORIGIN}});
  if (path === "/applications" && request.method === "POST") {
    const body = await readJson(request); const company = text(body.company, 200); const role = text(body.role, 200); const date = text(body.applied_at);
    if (!company || !role || !Number.isFinite(Date.parse(date)) || !isEventType(body.status)) throw new Problem(400, "invalid_application");
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO applications VALUES(?,NULL,?,?,NULL,NULL,?,?,'manual','matched',0,?)").bind(id, company, role, new Date(date).toISOString(), body.status, now),
      db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), id, "status", JSON.stringify(body.status), owner, now),
      db.prepare("INSERT INTO application_events VALUES(?,?,?,?,?,?,1,?)").bind(crypto.randomUUID(), id, body.status, new Date(date).toISOString(), "manual", id, JSON.stringify({method:"manual",actor:owner})),
    ]);
    return Response.json({id}, {status:201});
  }
  if (path === "/events" && request.method === "GET") return Response.json((await db.prepare("SELECT * FROM application_events ORDER BY occurred_at DESC LIMIT 100").all()).results);
  if (path === "/dashboard" && request.method === "GET") return Response.json(await dashboard(env));
  if (path === "/applications" && request.method === "GET") {
    const page = Math.max(0, Math.min(1000, Math.floor(Number(url.searchParams.get("page")) || 0)));
    const query = text(url.searchParams.get("q"), 200); const status = text(url.searchParams.get("status"), 100);
    const source=text(url.searchParams.get("source"),50);const reconciliation=text(url.searchParams.get("reconciliation"),50);
    const from=dateValue(text(url.searchParams.get("from")));const to=dateValue(text(url.searchParams.get("to")));
    const company=text(url.searchParams.get("company"),200);const role=text(url.searchParams.get("role"),200);
    const pageSize = url.searchParams.get("pageSize") === "25" ? 25 : 50;
    const sort = applicationOrder.get(url.searchParams.get("sort") ?? "") ?? applicationOrder.get("applied_desc");
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const where = "excluded=0 AND (company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\') AND (?='' OR status=?) AND (?='' OR source=?) AND (?='' OR reconciliation=?) AND (?='' OR applied_at>=?) AND (?='' OR applied_at<=?) AND (?='' OR company=?) AND (?='' OR role=?)";
    const bindings = [pattern, pattern, status, status, source, source, reconciliation, reconciliation, from, from, to, `${to}T23:59:59.999Z`, company, company, role, role];
    const [counted, listed] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS total FROM applications WHERE ${where}`).bind(...bindings),
      db.prepare(`SELECT * FROM applications WHERE ${where} ORDER BY ${sort},id LIMIT ? OFFSET ?`).bind(...bindings, pageSize, page * pageSize),
    ]);
    const total = Number((counted.results[0] as { total: number }).total);
    return Response.json({ applications: listed.results as ApplicationRecord[], page, pageSize, total, hasMore: (page + 1) * pageSize < total } satisfies ApplicationListResponse);
  }
  if (path === "/export" && request.method === "GET") {
    const apps = (await db.prepare("SELECT * FROM applications WHERE excluded=0 ORDER BY applied_at,id").all<ApplicationRecord>()).results;
    return new Response(csv(apps), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="job-applications.csv"' } });
  }
  if (path === "/connections" && request.method === "GET") {
    const view = await dashboard(env);
    return Response.json({ ...view.connections, historicalStart: env.HISTORICAL_START_DATE || null, aiEnabled: env.AI_ENABLED === "true", aiDailyLimit: Number(env.AI_DAILY_CALL_LIMIT) });
  }
  const graphEnabled = env.MICROSOFT_GRAPH_ENABLED === "true";
  if (path.startsWith("/connections/microsoft") && !graphEnabled) throw new Problem(404, "route_not_found");
  if (path === "/connections/microsoft/start" && request.method === "POST") return beginMicrosoft(env, owner);
  if (path === "/local-outlook/import" && request.method === "POST") return Response.json(await ingestLocalOutlookBatch(env, await readJson(request, 262144), automated));
  if (path === "/connections/microsoft/callback" && request.method === "GET") {
    return completeMicrosoft(request,env,owner);
  }
  if (path === "/connections/microsoft" && request.method === "DELETE") {
    await db.batch([db.prepare("DELETE FROM connections WHERE provider='microsoft'"), db.prepare("DELETE FROM oauth_states"), db.prepare("DELETE FROM sync_state WHERE provider='microsoft'")]);
    return Response.json({ disconnected: true, retainedEvidence: true });
  }
  if (path === "/connections/sheets" && ["POST", "DELETE"].includes(request.method)) {
    if (request.method === "POST" && !env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Problem(503, "sheets_setup_required");
    await db.prepare("INSERT INTO app_metadata VALUES('sheets_paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(request.method === "DELETE" ? "true" : "false").run();
    if (request.method === "POST") await db.prepare("INSERT INTO app_metadata VALUES('sync_paused','false') ON CONFLICT(key) DO UPDATE SET value='false'").run();
    return Response.json({ connected: request.method === "POST" });
  }
  if (path === "/sync-runs" && request.method === "GET") return Response.json((await dashboard(env)).runs);
  if (path === "/sync/run" && request.method === "POST") {
    if ((await db.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>())?.value === "true") throw new Problem(409,"reconnect_sources_to_resume");
    const instance = await env.JOB_SYNC.create({ params: { trigger: automated ? "automation" : "manual" } }); return Response.json({ id: instance.id }, { status: 202 });
  }
  if (["/reconciliation", "/review"].includes(path) && request.method === "GET") {
    const rows = await db.prepare("SELECT r.*,m.subject,m.web_link,s.snapshot,COALESCE(m.available,s.available,0) AS available FROM reconciliation_matches r LEFT JOIN message_references m ON r.source='email' AND r.source_id=m.id LEFT JOIN sheet_rows s ON r.source='sheet' AND r.source_id=s.id WHERE r.state IN ('needs_review','conflict','email_only','sheet_only') ORDER BY r.id LIMIT 100").all();
    return Response.json(rows.results);
  }
  if (["/reconciliation/resolve", "/review/decision"].includes(path) && request.method === "POST") {
    const body = await readJson(request); const sourceId = text(body.sourceId); const source = body.source;
    if (!sourceId || !["email", "sheet"].includes(String(source))) throw new Problem(400, "invalid_source");
    const match = await db.prepare("SELECT id,application_id FROM reconciliation_matches WHERE source=? AND source_id=?").bind(source, sourceId).first<{ id: string; application_id: string | null }>();
    if (!match) throw new Problem(404, "source_not_found");
    if (body.exclude === true) {
      await db.batch([db.prepare("UPDATE reconciliation_matches SET state='excluded',reason='Owner exclusion',manual=1 WHERE id=?").bind(match.id),db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),match.application_id,"source_exclusion",JSON.stringify({source,sourceId}),owner,new Date().toISOString())]);
      return Response.json({ excluded: true });
    }
    const applicationId = text(body.applicationId);
    if (!(await db.prepare("SELECT id FROM applications WHERE id=? AND excluded=0").bind(applicationId).first())) throw new Problem(400, "application_required");
    if (!isEventType(body.type)) throw new Problem(400, "event_type_required");
    const now = new Date().toISOString();
    const message = source === "email" ? await db.prepare("SELECT occurred_at FROM message_references WHERE id=?").bind(sourceId).first<{occurred_at:string}>() : null;
    const occurredAt = message?.occurred_at || now;
    await db.batch([
      db.prepare("UPDATE application_events SET evidence=json_set(evidence,'$.superseded',1) WHERE source=? AND source_id=? AND type<>?").bind(source,sourceId,body.type),
      db.prepare("UPDATE reconciliation_matches SET application_id=?,state='matched',reason='Owner association',manual=1 WHERE id=?").bind(applicationId, match.id),
      db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), applicationId, "association", JSON.stringify({ source, sourceId }), owner, now),
      db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), applicationId, "status", JSON.stringify(body.type), owner, now),
      db.prepare("UPDATE applications SET status=?,reconciliation='matched',updated_at=? WHERE id=?").bind(body.type, now, applicationId),
      db.prepare("INSERT INTO application_events VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(source,source_id,type) DO UPDATE SET application_id=excluded.application_id,confidence=1,evidence=excluded.evidence")
        .bind(crypto.randomUUID(), applicationId, body.type, occurredAt, source, sourceId, JSON.stringify({ method: "manual", actor: owner, dateKnown:Boolean(message) })),
    ]);
    return Response.json({ resolved: true });
  }
  const applicationPath = path.match(/^\/applications\/([a-zA-Z0-9-]{1,100})(\/merge)?$/);
  if (applicationPath) {
    const id = applicationPath[1]; const app = await db.prepare("SELECT * FROM applications WHERE id=?").bind(id).first<ApplicationRecord>();
    if (!app) throw new Problem(404, "application_not_found");
    if (request.method === "GET" && !applicationPath[2]) {
      const events = (await db.prepare("SELECT e.*,COALESCE(json_extract(e.evidence,'$.dateKnown'),1) AS date_known,COALESCE(json_extract(e.evidence,'$.superseded'),0) AS superseded,m.web_link,m.available,m.subject FROM application_events e LEFT JOIN message_references m ON e.source='email' AND e.source_id=m.id WHERE application_id=? ORDER BY occurred_at,id").bind(id).all()).results;
      const overrides = (await db.prepare("SELECT field,value,actor,created_at FROM manual_overrides WHERE application_id=? ORDER BY created_at").bind(id).all()).results;
      return Response.json({ application: app, events, overrides });
    }
    const body = await readJson(request); const now = new Date().toISOString();
    if (request.method === "POST" && applicationPath[2]) {
      const target = text(body.targetId);
      if (id === target || !(await db.prepare("SELECT id FROM applications WHERE id=? AND excluded=0").bind(target).first())) throw new Problem(400, "invalid_merge_target");
      if (!isEventType(body.status)) throw new Problem(400,"merge_status_required");
      await db.batch([
        db.prepare("UPDATE application_events SET application_id=? WHERE application_id=?").bind(target, id),
        db.prepare("UPDATE reconciliation_matches SET application_id=?,state='matched',reason='Owner merge',manual=1 WHERE application_id=?").bind(target, id),
        db.prepare("UPDATE manual_overrides SET application_id=? WHERE application_id=?").bind(target, id),
        db.prepare("UPDATE applications SET excluded=1,reconciliation='excluded',updated_at=? WHERE id=?").bind(now, id),
        db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), target, "merge", id, owner, now),
        db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), target, "status", JSON.stringify(body.status), owner, now),
        db.prepare("UPDATE applications SET status=?,reconciliation='matched',updated_at=? WHERE id=?").bind(body.status,now,target),
        db.prepare("INSERT INTO application_events VALUES(?,?,?,?,?,?,1,?)").bind(crypto.randomUUID(), target, body.status, now, "manual", crypto.randomUUID(), JSON.stringify({method:"manual",actor:owner,mergedFrom:id,dateKnown:true})),
      ]);
      return Response.json({ merged: true });
    }
    if (request.method === "PATCH" && !applicationPath[2]) {
      const allowed = ["company", "role", "status", "applied_at", "application_url", "excluded"];
      const statements: D1PreparedStatement[] = [];
      if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key))) throw new Problem(400, "invalid_patch");
      for (const [field, value] of Object.entries(body)) {
        if (field === "excluded" ? typeof value !== "boolean" : typeof value !== "string" || !value.trim() || value.length > 500) throw new Problem(400, "invalid_field");
        if (field === "status" && !isEventType(value)) throw new Problem(400, "invalid_status");
        if (field === "applied_at" && !Number.isFinite(Date.parse(String(value)))) throw new Problem(400, "invalid_date");
        if (field === "application_url" && !safeLink(String(value))) throw new Problem(400, "invalid_url");
        statements.push(db.prepare(`UPDATE applications SET ${field}=?,updated_at=? WHERE id=?`).bind(field === "excluded" ? Number(value) : value, now, id));
        statements.push(db.prepare("INSERT INTO manual_overrides VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), id, field, JSON.stringify(value), owner, now));
        if (field === "excluded" && value === true) statements.push(db.prepare("UPDATE reconciliation_matches SET state='excluded',reason='Owner application exclusion',manual=1 WHERE application_id=?").bind(id));
      }
      await db.batch(statements); return Response.json({ updated: true });
    }
  }
  if (path === "/reprocess" && request.method === "POST") { await db.prepare("UPDATE message_references SET processed_hash=NULL WHERE excerpt IS NOT NULL AND available=1").run(); return Response.json({ queued: true }); }
  if (path === "/data" && request.method === "DELETE") {
    const body = await readJson(request); if (body.confirmation !== "DELETE ALL JOB DATA") throw new Problem(400, "confirmation_required");
    const tables = ["follow_up_tasks", "manual_overrides", "reconciliation_matches", "application_events", "classification_decisions", "message_folders", "message_references", "sheet_versions", "sheet_rows", "applications", "organizations", "connections", "oauth_states", "sync_state", "sync_runs", "ai_usage"];
    await db.batch([...tables.map((table) => db.prepare(`DELETE FROM ${table}`)),db.prepare("DELETE FROM app_metadata WHERE key IN ('local_outlook_last_import','local_outlook_last_automated_import')"),db.prepare("INSERT INTO app_metadata VALUES('sync_paused','true') ON CONFLICT(key) DO UPDATE SET value='true'"),db.prepare("INSERT INTO app_metadata VALUES('sheets_paused','true') ON CONFLICT(key) DO UPDATE SET value='true'")]); return Response.json({ deleted: true });
  }
  throw new Problem(404, "route_not_found");
}

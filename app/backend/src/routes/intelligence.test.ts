import { afterEach, expect, it, vi } from "vitest";
import { intelligenceRoute } from "./intelligence";
import { fixture } from "../test/fixtures";
import { analytics, csv } from "../services/dashboard";
import { reconcile } from "../services/reconciliation";
import type { ApplicationRecord } from "@job-search/shared";
import type { Principal } from "../services/security";
afterEach(()=>vi.restoreAllMocks());
function caller(env:Env,principal:Principal={kind:"owner",id:"owner-sub"}) {
 return (path:string,method="GET",body?:object)=>intelligenceRoute(new Request(`https://api.example.com/api/job-intelligence${path}`,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined}),env,principal);
}
const manual={company:"ExampleCo",role:"Engineer",applied_at:"2026-09-01",status:"application_submitted"};
it("creates auditable owner records, searches/filters/pages safely, exports and exposes evidence",async()=>{
 const {env,close}=fixture();const call=caller(env);expect((await call("/session")).headers.get("Location")).toBe(env.ALLOWED_ORIGIN);
 const response=await call("/applications","POST",manual);expect(response.status).toBe(201);const {id}=await response.json() as {id:string};
 for(const path of ["/applications", "/applications?q=Example&sort=company&status=application_submitted&page=0", "/applications?q=%27%20OR%201=1--", "/applications?page=9999", "/events", "/connections", "/sync-runs", "/reconciliation", "/review"])expect((await call(path)).status).toBe(200);
 const detail=await (await call(`/applications/${id}`)).json() as {events:unknown[];overrides:unknown[]};expect(detail.events).toHaveLength(1);expect(detail.overrides).toHaveLength(1);
 const view=await (await call("/dashboard")).json() as {total:number;connections:object};expect(view.total).toBe(1);expect(view.connections).toEqual({microsoft:false,localOutlook:false,sheets:false});
 expect((await (await call("/applications?source=manual&reconciliation=matched&from=2026-09-01&to=2026-09-01")).json() as {applications:unknown[]}).applications).toHaveLength(1);
 expect((await (await call("/applications?source=sheet")).json() as {applications:unknown[]}).applications).toHaveLength(0);
 expect(await (await call("/export")).text()).toContain('"ExampleCo"');expect((await call("/sync/run","POST")).status).toBe(202);
 await expect(call("/applications","POST",{})).rejects.toMatchObject({code:"invalid_application"});await expect(call("/unknown")).rejects.toMatchObject({status:404});await expect(call("/applications/missing")).rejects.toMatchObject({status:404});close();
});
it("validates corrections, retains manual history, excludes and merges without discarding evidence",async()=>{
 const {env,db,close}=fixture();const call=caller(env);const {id}=await (await call("/applications","POST",manual)).json() as {id:string};const {id:target}=await (await call("/applications","POST",{...manual,role:"Manager"})).json() as {id:string};
 await call(`/applications/${id}`,"PATCH",{company:"Corrected",role:"Principal Engineer",applied_at:"2026-09-02",status:"offer",application_url:"https://jobs.example.com/1",excluded:false});
 for(const body of [{},{secret:"x"},{status:"fake"},{company:1},{company:""},{company:"x".repeat(501)},{excluded:1},{applied_at:"bad"},{application_url:"javascript:alert(1)"}])await expect(call(`/applications/${id}`,"PATCH",body)).rejects.toMatchObject({status:400});
 await expect(call(`/applications/${id}/merge`,"POST",{targetId:id})).rejects.toMatchObject({status:400});await expect(call(`/applications/${id}/merge`,"POST",{targetId:"missing"})).rejects.toMatchObject({status:400});
 await expect(call(`/applications/${id}/merge`,"POST",{targetId:target})).rejects.toMatchObject({code:"merge_status_required"});
 await call(`/applications/${id}/merge`,"POST",{targetId:target,status:"rejection"});expect((await db.prepare("SELECT excluded FROM applications WHERE id=?").bind(id).first())?.excluded).toBe(1);expect((await db.prepare("SELECT application_id FROM application_events WHERE source_id=?").bind(id).first())?.application_id).toBe(target);expect((await db.prepare("SELECT status FROM applications WHERE id=?").bind(target).first())?.status).toBe("rejection");expect((await db.prepare("SELECT type FROM application_events WHERE application_id=? AND source='manual' AND json_extract(evidence,'$.mergedFrom')=?").bind(target,id).first())?.type).toBe("rejection");expect(((await (await call("/dashboard")).json()) as {metrics:{rejections:number}}).metrics.rejections).toBe(1);
 await expect(call(`/applications/${target}`,"POST",{})).rejects.toMatchObject({status:404});
 await call(`/applications/${target}`,"PATCH",{excluded:true});expect(await (await call("/export")).text()).not.toContain("Corrected");close();
});
it("requires reviewed associations, preserves selected status, and records source exclusions",async()=>{
 const {env,db,close}=fixture();const call=caller(env);const {id}=await (await call("/applications","POST",manual)).json() as {id:string};
 await reconcile(db,{id:"source1",company:"",role:"",appliedAt:"2026-09-30",requisitionId:"",url:"",conversationId:"",applicationId:"",source:"email",status:"other_job_related"},0.4,true);
 await db.prepare("INSERT INTO message_references(id,account_id,immutable_id,subject,sender,occurred_at,content_hash,updated_at) VALUES('source1','account','immutable','Interview reply','recruiter@example.com','2026-09-30T15:00:00Z','hash','2026-09-30')").run();
 for(const body of [{},{source:"fake",sourceId:"x"},{source:"email",sourceId:"missing"},{source:"email",sourceId:"source1",applicationId:"missing"},{source:"email",sourceId:"source1",applicationId:id,type:"fake"}])await expect(call("/review/decision","POST",body)).rejects.toThrow();
 await call("/reconciliation/resolve","POST",{source:"email",sourceId:"source1",applicationId:id,type:"screening"});expect((await db.prepare("SELECT state,manual FROM reconciliation_matches WHERE source_id='source1'").first())).toMatchObject({state:"matched",manual:1});expect((await db.prepare("SELECT status FROM applications WHERE id=?").bind(id).first())?.status).toBe("screening");
 expect((await db.prepare("SELECT occurred_at FROM application_events WHERE source_id='source1'").first())?.occurred_at).toBe("2026-09-30T15:00:00Z");
 await call("/review/decision","POST",{source:"email",sourceId:"source1",exclude:true});expect((await db.prepare("SELECT state FROM reconciliation_matches").first())?.state).toBe("excluded");close();
});
it("controls providers, reprocessing and destructive deletion with explicit confirmation",async()=>{
 const {env,db,close}=fixture();const call=caller(env);await expect(call("/connections/sheets","POST")).rejects.toMatchObject({status:503});env.GOOGLE_SERVICE_ACCOUNT_JSON="configured";
 await call("/connections/sheets","POST");expect((await (await call("/dashboard")).json() as {connections:{sheets:boolean}}).connections.sheets).toBe(true);await call("/connections/sheets","DELETE");
 await call("/connections/microsoft","DELETE");expect((await call("/connections/microsoft/start","POST")).status).toBe(200);
 await expect(call("/connections/microsoft/callback")).rejects.toMatchObject({status:400});
 await call("/reprocess","POST");await expect(call("/data","DELETE",{confirmation:"wrong"})).rejects.toMatchObject({status:400});
 await db.prepare("INSERT INTO sync_locks VALUES('daily','run',?)").bind(Date.now()+10000).run();await expect(call("/data","DELETE",{confirmation:"DELETE ALL JOB DATA"})).rejects.toMatchObject({status:409});await db.prepare("DELETE FROM sync_locks").run();
 await call("/applications","POST",manual);await db.prepare("INSERT INTO app_metadata VALUES('local_outlook_last_import','2026-10-01')").run();expect((await call("/data","DELETE",{confirmation:"DELETE ALL JOB DATA"})).status).toBe(200);expect(await db.prepare("SELECT id FROM applications").first()).toBeNull();expect((await (await call("/dashboard")).json() as {connections:{localOutlook:boolean}}).connections.localOutlook).toBe(false);
 await expect(call("/sync/run","POST")).rejects.toMatchObject({code:"reconnect_sources_to_resume"});expect((await db.prepare("SELECT value FROM app_metadata WHERE key='sheets_paused'").first())?.value).toBe("true");
 await call("/connections/sheets","POST");expect((await call("/sync/run","POST")).status).toBe(202);close();
});
it("does not expose Microsoft connection routes when Graph is outside version one",async()=>{
 const {env,close}=fixture();env.MICROSOFT_GRAPH_ENABLED="false";const call=caller(env);
 await expect(call("/connections/microsoft/start","POST")).rejects.toMatchObject({status:404,code:"route_not_found"});
 await expect(call("/connections/microsoft/callback")).rejects.toMatchObject({status:404,code:"route_not_found"});
 await expect(call("/connections/microsoft","DELETE")).rejects.toMatchObject({status:404,code:"route_not_found"});close();
});
it("accepts only bounded local Outlook import batches",async()=>{
 const {env,db,close}=fixture();const call=caller(env);const body={format:"job-search-intelligence.outlook-com.v1",accountId:"a".repeat(64),exportedAt:"2026-10-01T00:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:false},messages:[{immutableId:"b".repeat(64),folder:"sentitems",subject:"Follow up",sender:env.OWNER_EMAIL,excerpt:"Checking in",occurredAt:"2026-10-01T00:00:00Z",conversationId:"c",internetMessageId:"<m@example.com>",revision:"r"}]};
 expect(await (await call("/local-outlook/import","POST",body)).json()).toEqual({imported:1});expect((await (await call("/dashboard")).json() as {connections:{localOutlook:boolean}}).connections.localOutlook).toBe(true);
 expect((await db.prepare("SELECT folder FROM message_folders").first())?.folder).toBe("sentitems");await expect(call("/local-outlook/import","POST",{...body,accountId:"bad"})).rejects.toMatchObject({status:400});close();
});
it("lets automation import and queue syncs without ever resuming paused imports",async()=>{
 const {env,db,close}=fixture();const owner=caller(env);const auto=caller(env,{kind:"automation",id:"automation"});const body={format:"job-search-intelligence.outlook-com.v1",accountId:"a".repeat(64),exportedAt:"2026-10-02T00:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:false},messages:[]};
 const meta=async(key:string)=>(await db.prepare("SELECT value FROM app_metadata WHERE key=?").bind(key).first<{value:string}>())?.value;
 expect(await (await auto("/local-outlook/import","POST",body)).json()).toEqual({imported:0});expect(await meta("local_outlook_last_automated_import")).toBe("2026-10-02T00:00:00.000Z");expect((await (await auto("/dashboard")).json() as {localOutlookLastAutomatedAt:string}).localOutlookLastAutomatedAt).toBe("2026-10-02T00:00:00.000Z");
 expect((await auto("/sync/run","POST")).status).toBe(202);expect(env.JOB_SYNC.create).toHaveBeenLastCalledWith({params:{trigger:"automation"}});expect((await owner("/sync/run","POST")).status).toBe(202);expect(env.JOB_SYNC.create).toHaveBeenLastCalledWith({params:{trigger:"manual"}});
 await owner("/applications","POST",manual);await owner("/data","DELETE",{confirmation:"DELETE ALL JOB DATA"});expect(await meta("local_outlook_last_automated_import")).toBeUndefined();
 await expect(auto("/local-outlook/import","POST",body)).rejects.toMatchObject({status:409,code:"reconnect_sources_to_resume"});expect(await meta("sync_paused")).toBe("true");expect(await meta("local_outlook_last_automated_import")).toBeUndefined();
 await owner("/local-outlook/import","POST",body);expect(await meta("sync_paused")).toBe("false");expect(await meta("local_outlook_last_automated_import")).toBeUndefined();close();
});
it("rejects capped local Outlook exports instead of treating partial history as complete",async()=>{
 const {env,close}=fixture();const call=caller(env);const body={format:"job-search-intelligence.outlook-com.v1",accountId:"a".repeat(64),exportedAt:"2026-10-01T00:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:true},messages:[]};
 await expect(call("/local-outlook/import","POST",body)).rejects.toMatchObject({status:409,code:"local_outlook_export_truncated"});close();
});
it("computes funnel, cohorts, response timing and unknown tracker dates without fabricated timing",()=>{
 const make=(id:string,status:string,reconciliation="matched")=>({id,company:"Co",role:"Engineer",requisition_id:null,application_url:null,applied_at:"2026-09-01",status,source:"sheet",reconciliation,excluded:0,updated_at:"2026-09-01"}) as ApplicationRecord;
 const apps=[make("a","interview_scheduled"),make("b","rejection","conflict"),make("c","application_submitted","needs_review"),make("d","offer")];
 const events=[{application_id:"a",type:"screening",occurred_at:"2026-09-03"},{application_id:"a",type:"interview_scheduled",occurred_at:"2026-09-05"},{application_id:"b",type:"rejection",occurred_at:"2026-10-01",date_known:0},{application_id:"d",type:"offer",occurred_at:"2026-09-06"}];
 const result=analytics(apps,events,Date.parse("2026-10-02"));expect(result.metrics).toMatchObject({total:4,active:2,responses:3,interviews:1,offers:1,rejections:1,noResponse30:1,review:2,unknownResponseDates:1,firstResponseDays:3.5});expect(result.groups.responseDays["Date unknown"]).toBe(1);
 expect(analytics([],[]).metrics.responsesRate).toBe(0);expect(analytics([make("fresh","application_submitted")],[],Date.parse("2026-09-03")).metrics).toMatchObject({thisWeek:1,thisMonth:1});
 expect(csv([{...make("formula","application_submitted"),company:" =HYPERLINK(\"evil\")",role:"\t=CMD"}])).toContain("' =HYPERLINK");
});

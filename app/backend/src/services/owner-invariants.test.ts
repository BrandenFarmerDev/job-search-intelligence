import { expect, it } from "vitest";
import { fixture } from "../test/fixtures";
import { intelligenceRoute } from "../routes/intelligence";
import { reconcile } from "./reconciliation";
import { acquireLease } from "./sync";
import { dashboard } from "./dashboard";
import { dateValue } from "./sheets";
import type { SourceRecord } from "@job-search/shared";

const record:SourceRecord={id:"row",company:"SyntheticCo",role:"Engineer",requisitionId:"QA-1",url:"",appliedAt:"2026-09-30",conversationId:"",applicationId:"",source:"sheet",status:"application_submitted"};
function call(env:Env,path:string,method:string,body:object) { return intelligenceRoute(new Request(`https://api.example/api/job-intelligence${path}`,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),env,{kind:"owner",id:"owner"}); }
it("keeps application exclusions durable after source changes and reprocessing",async()=>{
 const {env,db,close}=fixture();await reconcile(db,record,1,false);const app=(await db.prepare("SELECT id FROM applications").first<{id:string}>())!;
 await call(env,`/applications/${app.id}`,"PATCH",{excluded:true});await reconcile(db,{...record,status:"offer"},1,false);
 expect((await db.prepare("SELECT id FROM applications").all()).results).toHaveLength(1);expect((await db.prepare("SELECT state,manual FROM reconciliation_matches").first())).toMatchObject({state:"excluded",manual:1});expect((await dashboard(env)).total).toBe(0);close();
});
it("keeps a tracker row attached after the owner corrects its application date",async()=>{
 const {env,db,close}=fixture();const tracker={...record,requisitionId:""};await reconcile(db,tracker,1,false);
 const original=(await db.prepare("SELECT id FROM applications").first<{id:string}>())!.id;
 await call(env,`/applications/${original}`,"PATCH",{applied_at:"2026-01-01"});
 await reconcile(db,{...tracker,status:"interview_scheduled"},1,false);
 const applications=(await db.prepare("SELECT id,applied_at,status FROM applications").all<{id:string;applied_at:string;status:string}>()).results;
 const association=await db.prepare("SELECT application_id FROM reconciliation_matches WHERE source='sheet' AND source_id=?").bind(record.id).first<{application_id:string}>();
 expect(applications).toEqual([{id:original,applied_at:"2026-01-01",status:"interview_scheduled"}]);
 expect(association?.application_id).toBe(original);
 close();
});
it("serializes owner review, merge, reprocessing and disconnect with durable sync",async()=>{
 const {env,db,close}=fixture();await acquireLease(db,"running-sync");
 for(const [path,method] of [["/review/decision","POST"],["/applications/qa/merge","POST"],["/applications/qa","PATCH"],["/reprocess","POST"],["/connections/microsoft","DELETE"],["/connections/sheets","DELETE"]]) await expect(call(env,path,method,{})).rejects.toMatchObject({code:"sync_running"});
 expect((await db.prepare("SELECT owner FROM sync_locks").first())?.owner).toBe("running-sync");close();
});
it("does not invent an applied date from standalone response mail; retains its actual event time when linked",async()=>{
 const {db,close}=fixture();const response={...record,id:"response",source:"email" as const,appliedAt:"",eventAt:"2026-10-01T15:00:00Z",status:"rejection" as const};
 await reconcile(db,response,.95,false);expect(await db.prepare("SELECT id FROM applications").first()).toBeNull();expect((await db.prepare("SELECT state FROM reconciliation_matches").first())?.state).toBe("needs_review");
 await reconcile(db,record,1,false);await reconcile(db,response,.95,false);expect((await db.prepare("SELECT applied_at,status,reconciliation FROM applications").first())).toMatchObject({applied_at:"2026-09-30",status:"rejection",reconciliation:"conflict"});expect((await db.prepare("SELECT occurred_at FROM application_events WHERE source='email'").first())?.occurred_at).toBe(response.eventAt);close();
});
it("flags material tracker disagreement and excludes superseded or unreviewed events from analytics",async()=>{
 const {env,db,close}=fixture();await reconcile(db,record,1,false);await reconcile(db,{...record,id:"email",source:"email",status:"interview_scheduled",eventAt:"2026-10-01"},.95,false);
 let view=await dashboard(env);expect(view.metrics.interviews).toBe(1);expect(view.applications[0].reconciliation).toBe("conflict");
 await reconcile(db,{...record,id:"email",source:"email",status:"offer",eventAt:"2026-10-01"},.4,true);view=await dashboard(env);expect(view.metrics.offers).toBe(0);expect(view.metrics.interviews).toBe(0);
 await reconcile(db,{...record,status:"interview_scheduled"},1,false);expect((await db.prepare("SELECT evidence FROM application_events WHERE source='sheet' AND type='application_submitted'").first<{evidence:string}>())?.evidence).toContain('"superseded":1');close();
});
it("reads explicitly supported tracker calendar dates without rolling invalid dates into another month",()=>{
 expect(dateValue("9/30/2026")).toBe("2026-09-30");expect(dateValue("2026-09-30")).toBe("2026-09-30");
 for(const value of ["2026-02-30","2/29/2026","30/9/2026","9/30/26","tomorrow",""])expect(dateValue(value)).toBe("");
 expect(dateValue("2/29/2024")).toBe("2024-02-29");
});
it("keeps historical confirmations and follow-ups from overwriting advanced tracker lifecycle status",async()=>{
 const {env,db,close}=fixture();await reconcile(db,{...record,id:"confirmation",source:"email",status:"application_confirmation"},.95,false);
 await reconcile(db,{...record,status:"interview_scheduled"},1,false);await reconcile(db,{...record,id:"followup",source:"email",status:"follow_up_received",eventAt:"2026-10-01"},.95,false);
 expect((await dashboard(env)).applications[0]).toMatchObject({status:"interview_scheduled",reconciliation:"matched"});
 await reconcile(db,{...record,id:"interview",source:"email",status:"interview_requested",eventAt:"2026-10-01"},.95,false);expect((await db.prepare("SELECT reconciliation FROM applications").first())?.reconciliation).toBe("matched");close();
});
it.each([['interview_scheduled','interview_requested'],['assessment_completed','assessment_requested']] as const)("preserves advanced %s status when an earlier compatible %s event arrives",async(advanced,earlier)=>{
 const {db,close}=fixture();await reconcile(db,{...record,status:advanced},1,false);await reconcile(db,{...record,id:"earlier",source:"email",status:earlier,eventAt:"2026-09-30T15:00:00Z"},.95,false);
 expect((await db.prepare("SELECT status,reconciliation FROM applications").first())).toMatchObject({status:advanced,reconciliation:"matched"});expect((await db.prepare("SELECT id FROM application_events").all()).results).toHaveLength(2);close();
});

import { expect, it } from "vitest";
import type { ApplicationRecord, SourceRecord } from "@job-search/shared";
import { matchRecord, reconcile } from "./reconciliation";
import { fixture } from "../test/fixtures";
const source: SourceRecord={id:"sheet-1",company:"ExampleCo",role:"Engineer",requisitionId:"req1",url:"https://jobs.example/req1",appliedAt:"2026-09-01",conversationId:"",applicationId:"",source:"sheet",status:"application_submitted"};
const app: ApplicationRecord={id:"app1",company:"ExampleCo",role:"Engineer",requisition_id:"req1",application_url:source.url,applied_at:source.appliedAt,status:source.status,source:"sheet",reconciliation:"sheet_only",excluded:0,updated_at:source.appliedAt};
it("orders matching, quarantines ambiguity and preserves conflicts",()=>{
 expect(matchRecord({...source,applicationId:"app1"},[app]).reason).toBe("Match hierarchy 1");
 expect(matchRecord(source,[app]).reason).toBe("Match hierarchy 2");
 expect(matchRecord({...source,requisitionId:""},[app]).reason).toBe("Match hierarchy 3");
 expect(matchRecord({...source,requisitionId:"",url:"",company:"",role:""},[app],["app1"]).reason).toBe("Match hierarchy 4");
 expect(matchRecord({...source,requisitionId:"",url:""},[app]).reason).toBe("Match hierarchy 5");
 expect(matchRecord(source,[app,{...app,id:"app2"}]).state).toBe("needs_review");
 expect(matchRecord({...source,role:"Manager"},[app]).state).toBe("conflict");
 expect(matchRecord({...source,company:""},[]).state).toBe("needs_review");
 expect(matchRecord({...source,source:"email"},[]).state).toBe("email_only");expect(matchRecord(source,[]).state).toBe("sheet_only");
});
it("retains event lineage, is idempotent, preserves manual status and associations",async()=>{
 const {db,close}=fixture();await reconcile(db,source,1,false);await reconcile(db,source,1,false);
 const canonical=(await db.prepare("SELECT * FROM applications").first<ApplicationRecord>())!;expect((await db.prepare("SELECT * FROM application_events").all()).results).toHaveLength(1);
 await db.prepare("INSERT INTO manual_overrides VALUES('manual',?,'status','offer','owner','2026-09-02')").bind(canonical.id).run();
 await reconcile(db,{...source,id:"email-1",source:"email",status:"rejection"},0.95,false);expect((await db.prepare("SELECT status FROM applications").first())?.status).toBe("application_submitted");
 await db.prepare("UPDATE reconciliation_matches SET manual=1,state='matched' WHERE source_id='sheet-1'").run();
 await reconcile(db,{...source,role:"different",company:"other"},1,false);expect((await db.prepare("SELECT application_id FROM reconciliation_matches WHERE source_id='sheet-1'").first())?.application_id).toBe(canonical.id);
 await db.prepare("UPDATE reconciliation_matches SET state='excluded' WHERE source_id='sheet-1'").run();await reconcile(db,source,1,false);expect((await db.prepare("SELECT state FROM reconciliation_matches WHERE source_id='sheet-1'").first())?.state).toBe("excluded");
 await reconcile(db,{...source,id:"uncertain",company:"",role:"",url:"",requisitionId:""},0.4,true);expect((await db.prepare("SELECT application_id FROM reconciliation_matches WHERE source_id='uncertain'").first())?.application_id).toBeNull();close();
});
it("marks tracker status event date unknown instead of falsifying timing",async()=>{
 const {db,close}=fixture();await reconcile(db,{...source,status:"rejection"},1,false);const event=(await db.prepare("SELECT occurred_at,evidence FROM application_events").first<{occurred_at:string;evidence:string}>())!;
 expect(event.occurred_at).not.toBe(source.appliedAt);expect(JSON.parse(event.evidence).dateKnown).toBe(false);close();
});

import { afterEach, expect, it, vi } from "vitest";
import { JobSyncWorkflow, retryDelay, type SyncParameters } from "./workflow";
import * as sync from "./services/sync";
import { fixture } from "./test/fixtures";
import { Problem } from "./services/security";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
vi.mock("./services/sync",async(importOriginal)=>({...await importOriginal<typeof import("./services/sync")>(),ingestGraphPage:vi.fn(),processMessages:vi.fn(),syncSheets:vi.fn(),retain:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
function workflow(env:Env,id="run",continuation?:number) {
 const instance=new JobSyncWorkflow({} as ExecutionContext,env);
 const event={instanceId:id,payload:{trigger:"manual" as const,continuation},timestamp:new Date()} as WorkflowEvent<SyncParameters>;
 const step={do:vi.fn(async(_name:string,_options:unknown,callback:()=>Promise<unknown>)=>callback())} as unknown as WorkflowStep;
 return {instance,event,step};
}
it("runs durable bounded stages and records counters without storing private outputs",async()=>{
 const {env,db,close}=fixture();vi.mocked(sync.ingestGraphPage).mockResolvedValueOnce({done:false,count:2}).mockResolvedValue({done:true,count:1});vi.mocked(sync.processMessages).mockResolvedValueOnce(20).mockResolvedValue(1);vi.mocked(sync.syncSheets).mockResolvedValue({changed:3,unchanged:4,missing:1});
 await db.prepare("INSERT INTO sync_runs(id,trigger,status,started_at,finished_at) VALUES('dead','automation','running','2026-10-01',NULL)").run();
 const {instance,event,step}=workflow(env);expect(await instance.run(event,step)).toMatchObject({messages:4,processed:21,changedRows:3});expect((await db.prepare("SELECT status FROM sync_runs WHERE id='run'").first())?.status).toBe("completed");expect(await db.prepare("SELECT owner FROM sync_locks").first()).toBeNull();expect(step.do).toHaveBeenCalledWith("sync sheet",expect.objectContaining({retries:{limit:3,delay:expect.any(Function),backoff:"exponential"},sensitive:"output"}),expect.any(Function));expect(retryDelay({error:new Problem(502,"provider_rate_limited",120)})).toBe("120 seconds");expect(retryDelay({error:new Error("failed")})).toBe("30 seconds");
 // A run that died holding the lease is closed out by the next lease holder instead of staying "running" forever.
 expect(await db.prepare("SELECT status,error_code,finished_at FROM sync_runs WHERE id='dead'").first()).toMatchObject({status:"failed",error_code:"sync_interrupted",finished_at:expect.any(String)});expect(env.JOB_SYNC.create).not.toHaveBeenCalled();close();
});
it("skips overlaps and records safe failure codes while releasing only its own lease",async()=>{
 const {env,db,close}=fixture();await sync.acquireLease(db,"other");await db.prepare("INSERT INTO sync_runs(id,trigger,status,started_at,finished_at) VALUES('other','manual','running','2026-10-01',NULL)").run();
 const {instance,event,step}=workflow(env);expect(await instance.run(event,step)).toEqual({status:"skipped_overlap"});expect((await db.prepare("SELECT status,finished_at FROM sync_runs WHERE id='run'").first())?.finished_at).toBeTruthy();
 // Without the lease, a run must never close out the live holder's row.
 expect((await db.prepare("SELECT status FROM sync_runs WHERE id='other'").first())?.status).toBe("running");await db.prepare("DELETE FROM sync_locks").run();
 const failed=workflow(env,"fail");vi.mocked(sync.ingestGraphPage).mockRejectedValue(new Problem(502,"provider_rate_limited"));await expect(failed.instance.run(failed.event,failed.step)).rejects.toThrow("Job sync failed");expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='fail'").first())?.error_code).toBe("provider_rate_limited");
 const unsafe=workflow(env,"unsafe");vi.mocked(sync.ingestGraphPage).mockRejectedValue(new Error("private secret"));await expect(unsafe.instance.run(unsafe.event,unsafe.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='unsafe'").first())?.error_code).toBe("sync_failed");
 // When even the failure record cannot be written (invocation budget exhausted), the safe error still surfaces.
 const exhausted=workflow(env,"exhausted");vi.spyOn(exhausted.instance,"finish").mockRejectedValue(new Error("Too many API requests"));await expect(exhausted.instance.run(exhausted.event,exhausted.step)).rejects.toThrow("Job sync failed");expect((await db.prepare("SELECT status FROM sync_runs WHERE id='exhausted'").first())?.status).toBe("running");close();
});
it("stops excessive mail pages and processing batches with resumable checkpoints",async()=>{
 const {env,db,close}=fixture();vi.mocked(sync.ingestGraphPage).mockResolvedValue({done:false,count:100});const pages=workflow(env,"pages");await expect(pages.instance.run(pages.event,pages.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='pages'").first())?.error_code).toBe("mail_page_limit_resume_required");
 const capped=workflow(env,"capped",50);vi.mocked(sync.ingestGraphPage).mockClear();vi.mocked(sync.processMessages).mockResolvedValue(20);await expect(capped.instance.run(capped.event,capped.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='capped'").first())?.error_code).toBe("processing_limit_resume_required");
 // A continuation drains only the classification backlog and never repeats mail ingest.
 expect(sync.ingestGraphPage).not.toHaveBeenCalled();close();
});
it("hands a large backlog to a continuation only after recording the slice and releasing the lease",async()=>{
 const {env,db,close}=fixture();vi.mocked(sync.ingestGraphPage).mockResolvedValue({done:true,count:0});vi.mocked(sync.processMessages).mockResolvedValue(20);
 let leaseAtHandOff:unknown="unset";let statusAtHandOff:unknown;
 vi.mocked(env.JOB_SYNC.create).mockImplementation(async()=>{leaseAtHandOff=await db.prepare("SELECT owner FROM sync_locks").first();statusAtHandOff=(await db.prepare("SELECT status FROM sync_runs WHERE id='batches'").first())?.status;return {id:"next"} as WorkflowInstance;});
 const batches=workflow(env,"batches");expect(await batches.instance.run(batches.event,batches.step)).toMatchObject({processed:40});
 expect(sync.processMessages).toHaveBeenCalledTimes(2);expect(sync.processMessages).toHaveBeenCalledWith(env,"batches",20);expect(sync.syncSheets).not.toHaveBeenCalled();
 expect(env.JOB_SYNC.create).toHaveBeenCalledWith({params:{trigger:"manual",continuation:1}});expect(leaseAtHandOff).toBeNull();expect(statusAtHandOff).toBe("continued");
 // An unfinished slice never counts as the last successful sync.
 expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='batches'").first())?.error_code).toBeNull();
 // A failed hand-off keeps the recorded slice and flags it; the backlog stays in D1 for the next trigger.
 vi.mocked(env.JOB_SYNC.create).mockRejectedValue(new Error("binding unavailable"));const orphan=workflow(env,"orphan");expect(await orphan.instance.run(orphan.event,orphan.step)).toMatchObject({processed:40});
 expect(await db.prepare("SELECT status,error_code FROM sync_runs WHERE id='orphan'").first()).toMatchObject({status:"continued",error_code:"continuation_failed"});
 // The last permitted continuation still finishes normally when its slice drains the backlog.
 vi.mocked(sync.processMessages).mockResolvedValue(5);vi.mocked(sync.syncSheets).mockResolvedValue({changed:0,unchanged:2,missing:0});const last=workflow(env,"last",50);expect(await last.instance.run(last.event,last.step)).toMatchObject({processed:5,unchangedRows:2});
 expect((await db.prepare("SELECT status FROM sync_runs WHERE id='last'").first())?.status).toBe("completed");close();
});
it("treats a replayed finish step as already recorded instead of a lost lease",async()=>{
 const {env,db,close}=fixture();vi.mocked(sync.ingestGraphPage).mockResolvedValue({done:true,count:0});vi.mocked(sync.processMessages).mockResolvedValue(0);vi.mocked(sync.syncSheets).mockResolvedValue({changed:0,unchanged:0,missing:0});
 const {instance,event}=workflow(env,"replay");
 const step={do:vi.fn(async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{const result=await callback();if(name==="finish")return callback();return result;})} as unknown as WorkflowStep;
 await expect(instance.run(event,step)).resolves.toMatchObject({processed:0});expect((await db.prepare("SELECT status FROM sync_runs WHERE id='replay'").first())?.status).toBe("completed");close();
});
it("continues changed sheet rows with the lease released and retains only after the final slice",async()=>{
 const {env,db,close}=fixture();env.MICROSOFT_GRAPH_ENABLED="false";vi.mocked(sync.processMessages).mockResolvedValue(0);
 vi.mocked(sync.syncSheets).mockResolvedValueOnce({changed:15,unchanged:27,missing:0,more:true}).mockResolvedValue({changed:1,unchanged:42,missing:2});
 const first=workflow(env,"sheet-first");await first.instance.run(first.event,first.step);
 expect(sync.syncSheets).toHaveBeenCalledWith(env,"sheet-first",15);expect(sync.retain).not.toHaveBeenCalled();
 expect((await db.prepare("SELECT status FROM sync_runs WHERE id='sheet-first'").first())?.status).toBe("continued");expect(await db.prepare("SELECT owner FROM sync_locks").first()).toBeNull();expect(env.JOB_SYNC.create).toHaveBeenCalledWith({params:{trigger:"manual",continuation:1}});
 const last=workflow(env,"sheet-last",1);await last.instance.run(last.event,last.step);expect(sync.retain).toHaveBeenCalledTimes(1);expect((await db.prepare("SELECT status FROM sync_runs WHERE id='sheet-last'").first())?.status).toBe("completed");
 vi.mocked(sync.syncSheets).mockResolvedValue({changed:15,unchanged:0,missing:0,more:true});const capped=workflow(env,"sheet-capped",50);await expect(capped.instance.run(capped.event,capped.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='sheet-capped'").first())?.error_code).toBe("processing_limit_resume_required");close();
});
it("never repopulates deleted data from queued or scheduled syncs until explicit reconnect",async()=>{
 const {env,db,close}=fixture();await db.prepare("INSERT INTO app_metadata VALUES('sync_paused','true')").run();const paused=workflow(env,"queued-before-delete");expect(await paused.instance.run(paused.event,paused.step)).toEqual({status:"skipped_paused"});expect(sync.ingestGraphPage).not.toHaveBeenCalled();expect(sync.syncSheets).not.toHaveBeenCalled();expect(await db.prepare("SELECT id FROM sync_runs").first()).toBeNull();close();
});
it("keeps Microsoft Graph out of the version-one workflow",async()=>{
 const {env,close}=fixture();env.MICROSOFT_GRAPH_ENABLED="false";vi.mocked(sync.processMessages).mockResolvedValue(0);vi.mocked(sync.syncSheets).mockResolvedValue({changed:0,unchanged:0,missing:0});
 const {instance,event,step}=workflow(env,"v1");expect(await instance.run(event,step)).toMatchObject({messages:0,processed:0});expect(sync.ingestGraphPage).not.toHaveBeenCalled();close();
});

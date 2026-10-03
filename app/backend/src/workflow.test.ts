import { afterEach, expect, it, vi } from "vitest";
import { JobSyncWorkflow, retryDelay } from "./workflow";
import * as sync from "./services/sync";
import { fixture } from "./test/fixtures";
import { Problem } from "./services/security";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
vi.mock("./services/sync",async(importOriginal)=>({...await importOriginal<typeof import("./services/sync")>(),ingestGraphPage:vi.fn(),processMessages:vi.fn(),syncSheets:vi.fn(),retain:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
function workflow(env:Env,id="run") {
 const instance=new JobSyncWorkflow({} as ExecutionContext,env);
 const event={instanceId:id,payload:{trigger:"manual"},timestamp:new Date()} as WorkflowEvent<{trigger:"manual"}>;
 const step={do:vi.fn(async(_name:string,_options:unknown,callback:()=>Promise<unknown>)=>callback())} as unknown as WorkflowStep;
 return {instance,event,step};
}
it("runs durable bounded stages and records counters without storing private outputs",async()=>{
 const {env,db,close}=fixture();vi.mocked(sync.ingestGraphPage).mockResolvedValueOnce({done:false,count:2}).mockResolvedValue({done:true,count:1});vi.mocked(sync.processMessages).mockResolvedValueOnce(100).mockResolvedValue(1);vi.mocked(sync.syncSheets).mockResolvedValue({changed:3,unchanged:4,missing:1});
 const {instance,event,step}=workflow(env);expect(await instance.run(event,step)).toMatchObject({messages:4,processed:101,changedRows:3});expect((await db.prepare("SELECT status FROM sync_runs").first())?.status).toBe("completed");expect(await db.prepare("SELECT owner FROM sync_locks").first()).toBeNull();expect(step.do).toHaveBeenCalledWith("sync sheet",expect.objectContaining({retries:{limit:3,delay:expect.any(Function),backoff:"exponential"},sensitive:"output"}),expect.any(Function));expect(retryDelay({error:new Problem(502,"provider_rate_limited",120)})).toBe("120 seconds");expect(retryDelay({error:new Error("failed")})).toBe("30 seconds");close();
});
it("skips overlaps and records safe failure codes while releasing only its own lease",async()=>{
 const {env,db,close}=fixture();await sync.acquireLease(db,"other");const {instance,event,step}=workflow(env);expect(await instance.run(event,step)).toEqual({status:"skipped_overlap"});expect((await db.prepare("SELECT status,finished_at FROM sync_runs WHERE id='run'").first())?.finished_at).toBeTruthy();await db.prepare("DELETE FROM sync_locks").run();
 const failed=workflow(env,"fail");vi.mocked(sync.ingestGraphPage).mockRejectedValue(new Problem(502,"provider_rate_limited"));await expect(failed.instance.run(failed.event,failed.step)).rejects.toThrow("Job sync failed");expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='fail'").first())?.error_code).toBe("provider_rate_limited");
 const unsafe=workflow(env,"unsafe");vi.mocked(sync.ingestGraphPage).mockRejectedValue(new Error("private secret"));await expect(unsafe.instance.run(unsafe.event,unsafe.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='unsafe'").first())?.error_code).toBe("sync_failed");close();
});
it("stops excessive mail pages and processing batches with resumable checkpoints",async()=>{
 const {env,db,close}=fixture();vi.mocked(sync.ingestGraphPage).mockResolvedValue({done:false,count:100});const pages=workflow(env,"pages");await expect(pages.instance.run(pages.event,pages.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='pages'").first())?.error_code).toBe("mail_page_limit_resume_required");
 vi.mocked(sync.ingestGraphPage).mockResolvedValue({done:true,count:0});vi.mocked(sync.processMessages).mockResolvedValue(100);const batches=workflow(env,"batches");await expect(batches.instance.run(batches.event,batches.step)).rejects.toThrow();expect((await db.prepare("SELECT error_code FROM sync_runs WHERE id='batches'").first())?.error_code).toBe("processing_limit_resume_required");close();
});
it("never repopulates deleted data from queued or scheduled syncs until explicit reconnect",async()=>{
 const {env,db,close}=fixture();await db.prepare("INSERT INTO app_metadata VALUES('sync_paused','true')").run();const paused=workflow(env,"queued-before-delete");expect(await paused.instance.run(paused.event,paused.step)).toEqual({status:"skipped_paused"});expect(sync.ingestGraphPage).not.toHaveBeenCalled();expect(sync.syncSheets).not.toHaveBeenCalled();expect(await db.prepare("SELECT id FROM sync_runs").first()).toBeNull();close();
});
it("keeps Microsoft Graph out of the version-one workflow",async()=>{
 const {env,close}=fixture();env.MICROSOFT_GRAPH_ENABLED="false";vi.mocked(sync.processMessages).mockResolvedValue(0);vi.mocked(sync.syncSheets).mockResolvedValue({changed:0,unchanged:0,missing:0});
 const {instance,event,step}=workflow(env,"v1");expect(await instance.run(event,step)).toMatchObject({messages:0,processed:0});expect(sync.ingestGraphPage).not.toHaveBeenCalled();close();
});

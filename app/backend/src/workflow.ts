import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { acquireLease, heartbeat, ingestGraphPage, processMessages, retain, syncSheets } from "./services/sync";
import { assertGmailDrained, fencedGmailBatch, gmailBodyCandidate, gmailDiscoverPage, gmailMetadataCandidate, gmailRefreshLabels, reserveGmailWorkflowStep } from "./services/gmail";
import { Problem } from "./services/security";
import { dataGeneration } from "./services/data-generation";
import { createExecutionBudget, ExecutionBudgetExceeded, reserveWorkflowHandoff, type ExecutionBudgetSnapshot } from "./services/execution-budget";

export type GmailPhase = "labels" | "discovery" | "metadata" | "body" | "classification" | "sheets" | "finish";
export interface SyncParameters { trigger: "manual" | "scheduled" | "automation"; expectedGeneration: string; continuation?: number; mailSource?: "none" | "gmail" | "microsoft"; connectionGeneration?: string; gmailPhase?: GmailPhase }
export function retryDelay({error}:{error:Error}): `${number} seconds` { return `${error instanceof Problem ? error.retryAfter : 30} seconds`; }
const retry = { retries: { limit: 3, delay: retryDelay, backoff: "exponential" as const }, timeout: "2 minutes" as const, sensitive: "output" as const };
const gmailRetry = { retries: { limit: 0, delay: retryDelay, backoff: "exponential" as const }, timeout: "2 minutes" as const, sensitive: "output" as const };
// Every message costs roughly fifteen sequential D1 calls. A Worker invocation allows 1,000 calls to Cloudflare services
// and step retries share that budget, so an instance classifies a bounded slice and hands the remainder to a fresh instance.
export const BATCH_MESSAGES = 20;
export const BATCHES_PER_INSTANCE = 2;
export const SHEET_ROWS_PER_INSTANCE = 15;
export const MAX_CONTINUATIONS = 50;
export class JobSyncWorkflow extends WorkflowEntrypoint<Env, SyncParameters> {
  async run(event: WorkflowEvent<SyncParameters>, step: WorkflowStep) {
    const { env, budget } = createExecutionBudget(this.env);
    const id = event.instanceId; const counters: {messages:number;processed:number;changedRows:number;unchangedRows:number;missingRows:number;workflowBudget?:ExecutionBudgetSnapshot} = { messages: 0, processed: 0, changedRows: 0, unchangedRows: 0, missingRows: 0 };
    const expectedGeneration = event.payload.expectedGeneration;
    // Old queued events and events bound to a deleted dataset never acquire a lease or write run records.
    if (!expectedGeneration || (await dataGeneration(env.JOB_SEARCH_DB)) !== expectedGeneration) return { status:"skipped_stale_generation" };
    const acquired = await step.do("acquire lease", event.payload.mailSource==="gmail"?gmailRetry:retry, async () => {
      if ((await dataGeneration(env.JOB_SEARCH_DB)) !== expectedGeneration) return "stale";
      const lease = await acquireLease(env.JOB_SEARCH_DB, id);
      // Deletion can finish between the precheck and lease acquisition. Validate while holding
      // the lease before writing history or closing interrupted rows.
      if (lease && (await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='job_data_generation'").first<{value:string}>())?.value !== expectedGeneration) {
        await env.JOB_SEARCH_DB.prepare("DELETE FROM sync_locks WHERE owner=?").bind(id).run();
        return "stale";
      }
      if (!lease && (await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>())?.value === "true") return "paused";
      const startedAt = new Date().toISOString();
      await env.JOB_SEARCH_DB.prepare("INSERT OR IGNORE INTO sync_runs(id,trigger,status,started_at,finished_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM app_metadata WHERE key='job_data_generation' AND value=?)").bind(id, event.payload.trigger, lease ? "running" : "skipped_overlap", startedAt, lease ? null : startedAt, expectedGeneration).run();
      // Holding the lease proves no other run is alive, so any other row still marked running died before it could finish.
      if (lease) await env.JOB_SEARCH_DB.prepare("UPDATE sync_runs SET status='failed',finished_at=?,error_code='sync_interrupted' WHERE status='running' AND id<>?").bind(startedAt, id).run();
      return lease;
    });
    // Workflow step results are durable and can be replayed from cache. Revalidate the epoch outside
    // the step before any provider or classification work, and release only this run's lease if stale.
    if (acquired === true && (await dataGeneration(env.JOB_SEARCH_DB)) !== expectedGeneration) {
      await budget.withControl(() => env.JOB_SEARCH_DB.prepare("DELETE FROM sync_locks WHERE owner=?").bind(id).run());
      return { status:"skipped_stale_generation" };
    }
    if (acquired === "stale") return { status:"skipped_stale_generation" };
    if (acquired === "paused") return {status:"skipped_paused"};
    if (!acquired) return { status: "skipped_overlap" };
    const continuation = (event.payload.continuation ?? 0) + 1;
    let more = false;
    let nextPhase:GmailPhase|undefined;
    try {
      // Every continuation resumes durable provider work; Gmail has separate discovery, metadata, body and classify phases.
      if(event.payload.mailSource==="gmail"){
        if(env.GMAIL_ENABLED!=="true"||env.GMAIL_SYNC_ENABLED!=="true"||!event.payload.connectionGeneration)throw new Problem(409,"gmail_sync_not_accepted");
        await step.do("reserve Gmail daily step",gmailRetry,()=>reserveGmailWorkflowStep(env));
        const phase=event.payload.gmailPhase||"labels";
        if(phase==="labels"){
          await step.do("validate Gmail labels",gmailRetry,()=>gmailRefreshLabels(env,id,expectedGeneration,event.payload.connectionGeneration!));
          more=true;nextPhase="discovery";
        }else if(phase==="discovery"){
          const result=await step.do("gmail discovery page",gmailRetry,()=>gmailDiscoverPage(env,id,expectedGeneration,event.payload.connectionGeneration!));
          counters.messages+=result.discovered;more=true;nextPhase=result.done?"metadata":"discovery";
        }else if(phase==="metadata"){
          const did=await step.do("gmail metadata candidate",gmailRetry,()=>gmailMetadataCandidate(env,id,expectedGeneration,event.payload.connectionGeneration!));
          more=true;nextPhase=did?"metadata":"body";
        }else if(phase==="body"){
          const did=await step.do("gmail body candidate",gmailRetry,()=>gmailBodyCandidate(env,id,expectedGeneration,event.payload.connectionGeneration!));
          more=true;nextPhase=did?"body":"classification";
        }else if(phase==="classification"){
          const count=await step.do("classify one message",gmailRetry,()=>processMessages(env,id,1,{epoch:expectedGeneration,connectionGeneration:event.payload.connectionGeneration!}));counters.processed+=count;
          more=true;nextPhase=count?"classification":"sheets";
        }else if(phase==="sheets"){
          const sheet=await step.do("sync sheet",gmailRetry,()=>syncSheets(env,id,1,{epoch:expectedGeneration,connectionGeneration:event.payload.connectionGeneration!}));counters.changedRows=sheet.changed;counters.unchangedRows=sheet.unchanged;counters.missingRows=sheet.missing;
          more=true;nextPhase=sheet.more?"sheets":"finish";
        }else if(phase==="finish"){
          await step.do("verify Gmail backlog drained",gmailRetry,()=>assertGmailDrained(env));
          await step.do("retention",gmailRetry,()=>retain(env.JOB_SEARCH_DB,(statements)=>fencedGmailBatch(env,id,expectedGeneration,event.payload.connectionGeneration!,statements)));
        }
      }
      if(event.payload.mailSource!=="gmail"){
       if(event.payload.mailSource==="microsoft"&&env.MICROSOFT_GRAPH_ENABLED==="true"&&!event.payload.continuation){
        for(const folder of ["inbox","sentitems"]){let done=false;for(let page=0;page<100;page++){
         const result=await step.do(`${folder} page ${page}`,retry,()=>ingestGraphPage(this.env,folder,id));counters.messages+=result.count;
         if(result.done){done=true;break;}
        }if(!done)throw new Problem(409,"mail_page_limit_resume_required");}
       }
       for(let index=0;index<BATCHES_PER_INSTANCE;index++){
        const count=await step.do(`classify batch ${index+1}`,retry,()=>processMessages(this.env,id,BATCH_MESSAGES));
        counters.processed+=count;if(count<BATCH_MESSAGES)break;
       }
       more=counters.processed>=BATCH_MESSAGES*BATCHES_PER_INSTANCE;
      }
      if (!more && event.payload.mailSource!=="gmail") {
        const sheet = await step.do("sync sheet", retry, () => syncSheets(this.env, id, SHEET_ROWS_PER_INSTANCE));
        counters.changedRows = sheet.changed; counters.unchangedRows = sheet.unchanged; counters.missingRows = sheet.missing;
        more = sheet.more ?? false;
        if (!more) await step.do("retention", retry, () => retain(this.env.JOB_SEARCH_DB));
      }
      if (more && continuation > MAX_CONTINUATIONS) throw new Problem(409, "processing_limit_resume_required");
      // "continued" keeps an unfinished slice out of the last successful sync time shown to the owner.
      if(event.payload.mailSource==="gmail")counters.workflowBudget=budget.snapshot;
      await budget.withControl(() => step.do("finish", event.payload.mailSource==="gmail"?gmailRetry:retry, async () => {
        // A replay after a committed finish must not fail on the already released lease.
        if ((await env.JOB_SEARCH_DB.prepare("SELECT status FROM sync_runs WHERE id=?").bind(id).first<{status:string}>())?.status !== "running") return;
        await heartbeat(env.JOB_SEARCH_DB, id); await this.finish(id, more ? "continued" : "completed", counters, null, env.JOB_SEARCH_DB);
      }));
    } catch (error) {
      // The failure record is best effort: when the invocation budget itself is exhausted, the next run marks this one interrupted.
      if(event.payload.mailSource==="gmail")counters.workflowBudget=budget.snapshot;
      try { await budget.withControl(() => this.finish(id, "failed", counters, error instanceof Problem ? error.code : error instanceof ExecutionBudgetExceeded ? error.message : "sync_failed", env.JOB_SEARCH_DB)); } catch { /* recorded by the next lease holder */ }
      throw new Error("Job sync failed; see authenticated run history.");
    }
    if (!more) return counters;
    // The run is already recorded and its lease released, so the continuation can take the lease. A failed hand-off leaves
    // the backlog durable in D1 for the next trigger rather than rewriting this recorded run as failed.
      try { await budget.withControl(() => step.do("continue", event.payload.mailSource==="gmail"?gmailRetry:retry, async () => { reserveWorkflowHandoff(env); await env.JOB_SYNC.create({ params: { trigger: event.payload.trigger, expectedGeneration, continuation, ...(event.payload.mailSource?{mailSource:event.payload.mailSource}:{}), ...(event.payload.connectionGeneration?{connectionGeneration:event.payload.connectionGeneration}:{}), ...(nextPhase?{gmailPhase:nextPhase}:{}) } }); })); }
    catch { try { await budget.withControl(() => env.JOB_SEARCH_DB.prepare("UPDATE sync_runs SET error_code='continuation_failed' WHERE id=?").bind(id).run()); } catch { /* backlog remains pending */ } }
    return counters;
  }
  async finish(id: string, status: string, counters: object, error: string | null, database: D1Database = this.env.JOB_SEARCH_DB) {
    await database.batch([
      database.prepare("UPDATE sync_runs SET status=?,finished_at=?,counters=?,error_code=? WHERE id=?").bind(status, new Date().toISOString(), JSON.stringify(counters), error, id),
      database.prepare("DELETE FROM sync_locks WHERE owner=?").bind(id),
    ]);
  }
}

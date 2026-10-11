import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { acquireLease, heartbeat, ingestGraphPage, processMessages, retain, syncSheets } from "./services/sync";
import { Problem } from "./services/security";

export interface SyncParameters { trigger: "manual" | "scheduled" | "automation"; continuation?: number }
export function retryDelay({error}:{error:Error}): `${number} seconds` { return `${error instanceof Problem ? error.retryAfter : 30} seconds`; }
const retry = { retries: { limit: 3, delay: retryDelay, backoff: "exponential" as const }, timeout: "2 minutes" as const, sensitive: "output" as const };
// Every message costs roughly fifteen sequential D1 calls. A Worker invocation allows 1,000 calls to Cloudflare services
// and step retries share that budget, so an instance classifies a bounded slice and hands the remainder to a fresh instance.
export const BATCH_MESSAGES = 20;
export const BATCHES_PER_INSTANCE = 2;
export const MAX_CONTINUATIONS = 50;
export class JobSyncWorkflow extends WorkflowEntrypoint<Env, SyncParameters> {
  async run(event: WorkflowEvent<SyncParameters>, step: WorkflowStep) {
    const id = event.instanceId; const counters = { messages: 0, processed: 0, changedRows: 0, unchangedRows: 0, missingRows: 0 };
    const acquired = await step.do("acquire lease", retry, async () => {
      const lease = await acquireLease(this.env.JOB_SEARCH_DB, id);
      if (!lease && (await this.env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>())?.value === "true") return "paused";
      const startedAt = new Date().toISOString();
      await this.env.JOB_SEARCH_DB.prepare("INSERT OR IGNORE INTO sync_runs(id,trigger,status,started_at,finished_at) VALUES(?,?,?,?,?)").bind(id, event.payload.trigger, lease ? "running" : "skipped_overlap", startedAt, lease ? null : startedAt).run();
      // Holding the lease proves no other run is alive, so any other row still marked running died before it could finish.
      if (lease) await this.env.JOB_SEARCH_DB.prepare("UPDATE sync_runs SET status='failed',finished_at=?,error_code='sync_interrupted' WHERE status='running' AND id<>?").bind(startedAt, id).run();
      return lease;
    });
    if (acquired === "paused") return {status:"skipped_paused"};
    if (!acquired) return { status: "skipped_overlap" };
    const continuation = (event.payload.continuation ?? 0) + 1;
    let more = false;
    try {
      // A continuation only drains the classification backlog; mail ingest already happened in the first instance.
      if (this.env.MICROSOFT_GRAPH_ENABLED === "true" && !event.payload.continuation) {
        for (const folder of ["inbox", "sentitems"]) {
          let done = false;
          for (let page = 0; page < 100; page++) {
            const result = await step.do(`${folder} page ${page}`, retry, () => ingestGraphPage(this.env, folder, id));
            counters.messages += result.count;
            if (result.done) { done = true; break; }
          }
          if (!done) throw new Problem(409, "mail_page_limit_resume_required");
        }
      }
      more = true;
      for (let batch = 0; batch < BATCHES_PER_INSTANCE && more; batch++) {
        const count = await step.do(`classify batch ${batch}`, retry, () => processMessages(this.env, id, BATCH_MESSAGES));
        counters.processed += count;
        more = count >= BATCH_MESSAGES;
      }
      if (more && continuation > MAX_CONTINUATIONS) throw new Problem(409, "processing_limit_resume_required");
      if (!more) {
        const sheet = await step.do("sync sheet", retry, () => syncSheets(this.env, id));
        counters.changedRows = sheet.changed; counters.unchangedRows = sheet.unchanged; counters.missingRows = sheet.missing;
        await step.do("retention", retry, () => retain(this.env.JOB_SEARCH_DB));
      }
      // "continued" keeps an unfinished slice out of the last successful sync time shown to the owner.
      await step.do("finish", retry, async () => {
        // A replay after a committed finish must not fail on the already released lease.
        if ((await this.env.JOB_SEARCH_DB.prepare("SELECT status FROM sync_runs WHERE id=?").bind(id).first<{status:string}>())?.status !== "running") return;
        await heartbeat(this.env.JOB_SEARCH_DB, id); await this.finish(id, more ? "continued" : "completed", counters, null);
      });
    } catch (error) {
      // The failure record is best effort: when the invocation budget itself is exhausted, the next run marks this one interrupted.
      try { await this.finish(id, "failed", counters, error instanceof Problem ? error.code : "sync_failed"); } catch { /* recorded by the next lease holder */ }
      throw new Error("Job sync failed; see authenticated run history.");
    }
    if (!more) return counters;
    // The run is already recorded and its lease released, so the continuation can take the lease. A failed hand-off leaves
    // the backlog durable in D1 for the next trigger rather than rewriting this recorded run as failed.
    try { await step.do("continue", retry, async () => { await this.env.JOB_SYNC.create({ params: { trigger: event.payload.trigger, continuation } }); }); }
    catch { try { await this.env.JOB_SEARCH_DB.prepare("UPDATE sync_runs SET error_code='continuation_failed' WHERE id=?").bind(id).run(); } catch { /* backlog remains pending */ } }
    return counters;
  }
  async finish(id: string, status: string, counters: object, error: string | null) {
    await this.env.JOB_SEARCH_DB.batch([
      this.env.JOB_SEARCH_DB.prepare("UPDATE sync_runs SET status=?,finished_at=?,counters=?,error_code=? WHERE id=?").bind(status, new Date().toISOString(), JSON.stringify(counters), error, id),
      this.env.JOB_SEARCH_DB.prepare("DELETE FROM sync_locks WHERE owner=?").bind(id),
    ]);
  }
}

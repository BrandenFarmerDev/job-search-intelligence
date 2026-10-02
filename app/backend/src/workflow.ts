import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { acquireLease, heartbeat, ingestGraphPage, processMessages, retain, syncSheets } from "./services/sync";
import { Problem } from "./services/security";

export interface SyncParameters { trigger: "manual" | "scheduled" }
export function retryDelay({error}:{error:Error}): `${number} seconds` { return `${error instanceof Problem ? error.retryAfter : 30} seconds`; }
const retry = { retries: { limit: 3, delay: retryDelay, backoff: "exponential" as const }, timeout: "2 minutes" as const, sensitive: "output" as const };
export class JobSyncWorkflow extends WorkflowEntrypoint<Env, SyncParameters> {
  async run(event: WorkflowEvent<SyncParameters>, step: WorkflowStep) {
    const id = event.instanceId; const counters = { messages: 0, processed: 0, changedRows: 0, unchangedRows: 0, missingRows: 0 };
    const acquired = await step.do("acquire lease", retry, async () => {
      const lease = await acquireLease(this.env.JOB_SEARCH_DB, id);
      if (!lease && (await this.env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>())?.value === "true") return "paused";
      await this.env.JOB_SEARCH_DB.prepare("INSERT OR IGNORE INTO sync_runs(id,trigger,status,started_at) VALUES(?,?,?,?)").bind(id, event.payload.trigger, lease ? "running" : "skipped_overlap", new Date().toISOString()).run();
      return lease;
    });
    if (acquired === "paused") return {status:"skipped_paused"};
    if (!acquired) return { status: "skipped_overlap" };
    try {
      if (this.env.MICROSOFT_GRAPH_ENABLED === "true") {
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
      let processed = false;
      for (let batch = 0; batch < 100; batch++) {
        const count = await step.do(`classify batch ${batch}`, retry, () => processMessages(this.env, id));
        counters.processed += count;
        if (count < 100) { processed = true; break; }
      }
      if (!processed) throw new Problem(409, "processing_limit_resume_required");
      const sheet = await step.do("sync sheet", retry, () => syncSheets(this.env, id));
      counters.changedRows = sheet.changed; counters.unchangedRows = sheet.unchanged; counters.missingRows = sheet.missing;
      await step.do("retention", retry, () => retain(this.env.JOB_SEARCH_DB));
      await step.do("finish", retry, async () => { await heartbeat(this.env.JOB_SEARCH_DB, id); await this.finish(id, "completed", counters, null); });
      return counters;
    } catch (error) {
      await this.finish(id, "failed", counters, error instanceof Problem ? error.code : "sync_failed");
      throw new Error("Job sync failed; see authenticated run history.");
    }
  }
  async finish(id: string, status: string, counters: object, error: string | null) {
    await this.env.JOB_SEARCH_DB.batch([
      this.env.JOB_SEARCH_DB.prepare("UPDATE sync_runs SET status=?,finished_at=?,counters=?,error_code=? WHERE id=?").bind(status, new Date().toISOString(), JSON.stringify(counters), error, id),
      this.env.JOB_SEARCH_DB.prepare("DELETE FROM sync_locks WHERE owner=?").bind(id),
    ]);
  }
}

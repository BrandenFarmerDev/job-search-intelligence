import { useState } from "react";
import type { SyncRun } from "@job-search/shared";
import { DashboardGate } from "../components/DashboardGate";
import { PageHeader } from "../components/PageHeader";
import { Alert, Button, DataTable, Drawer, Field, Panel, StatusBadge, humanize, type Column } from "../components/ui";
import { errorMessage, intelligenceApi } from "../lib/api";
import { useDashboard } from "../lib/dashboard-context";
import { formatDateTime, formatDuration } from "../lib/format";

const BATCH = 40; const MAX_BYTES = 10_000_000; const MAX_MESSAGES = 10_000; const CONFIRMATION = "DELETE ALL JOB DATA";
const invalid = () => new Error("Invalid local Outlook export.");

function parseExport(text: string): { source: Record<string, unknown>; messages: unknown[] } {
  const bundle: unknown = JSON.parse(text);
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw invalid();
  const source = bundle as Record<string, unknown>;
  if (!Array.isArray(source.messages) || source.messages.length > MAX_MESSAGES) throw invalid();
  const summary = source.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary) || !("truncated" in summary)) throw invalid();
  if ((summary as Record<string, unknown>).truncated === true) throw new Error("This export reached its message cap. Export a narrower date range and try again.");
  if ((summary as Record<string, unknown>).truncated !== false) throw invalid();
  return { source, messages: source.messages };
}

const runColumns: Column<SyncRun>[] = [
  { key: "started", header: "Started", render: (run) => formatDateTime(run.started_at) },
  { key: "status", header: "Status", render: (run) => <StatusBadge value={run.status} /> },
  { key: "finished", header: "Finished", render: (run) => run.finished_at ? `${formatDateTime(run.finished_at)} · ${formatDuration(run.started_at, run.finished_at)}` : "Not finished" },
  { key: "error", header: "Error", render: (run) => run.error_code ? humanize(run.error_code) : "—" },
];

export function SourcesPage() {
  const { busy, perform, refresh, runAction, error } = useDashboard();
  const [progress, setProgress] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [attempted, setAttempted] = useState(false);

  async function importLocalOutlook(file: File | undefined) {
    if (!file) return;
    await perform(async () => {
      if (file.size > MAX_BYTES) throw new Error("Local Outlook export is larger than 10 MB.");
      const { source, messages } = parseExport(await file.text());
      const batches = Math.ceil(messages.length / BATCH);
      let saved = 0; let imported = 0;
      try {
        for (let index = 0; index < batches; index++) {
          setProgress(`Uploading batch ${index + 1} of ${batches}`);
          const result = await intelligenceApi<{ imported: number }>("/local-outlook/import", "POST", { ...source, messages: messages.slice(index * BATCH, (index + 1) * BATCH) });
          saved++; imported += result.imported;
        }
        await intelligenceApi("/sync/run", "POST");
      } catch (reason) {
        throw new Error(`${errorMessage(reason, "Local Outlook import failed")} ${saved} of ${batches} batches were saved before this failure.`);
      } finally { setProgress(""); }
      return `Imported ${imported} local Outlook messages. Classification is running.`;
    });
  }
  async function deleteAll(confirmation: string) {
    setAttempted(true);
    if (await runAction("/data", "DELETE", { confirmation }, "All job data was deleted. Imports stay paused until you reconnect a source.")) setConfirming(false);
  }

  return <>
    <PageHeader title="Sources & privacy" description="Connect read-only sources, review sync history and control the data this workspace keeps." />
    <DashboardGate>{(dashboard) => {
      const failedRecently = dashboard.runs.slice(0, 3).filter((run) => run.status === "failed").length >= 3;
      return <>
        <Panel title="Connections" description="Version one uses the local Outlook export and a read-only tracker connection. Sync never sends email or changes your spreadsheet."
          actions={<>
            <Button variant="primary" disabled={busy} onClick={() => runAction("/sync/run", "POST", undefined, "Sync queued. Refresh to see results.")}>Run sync</Button>
            <Button disabled={busy} onClick={refresh}>Refresh</Button>
          </>}>
          <div className="qe-stack" data-gap="5">
            <div className="qe-stack" data-gap="3">
              <p className="qe-cluster" data-gap="2"><span className="qe-label">Local Outlook</span><StatusBadge value={dashboard.connections.localOutlook ? "imported" : "not_imported"} /></p>
              <Field label="Import local Outlook JSON" help="Choose the JSON file written by the Windows export script. Up to 10 MB and 10,000 messages.">{(control) => <input {...control} className="qe-input" type="file" accept="application/json,.json" disabled={busy}
                onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void importLocalOutlook(file); }} />}</Field>
              <p className="qe-help" aria-live="polite">{progress}</p>
            </div>
            <hr className="qe-divider" />
            <div className="qe-cluster" data-gap="4">
              <p className="qe-cluster" data-gap="2"><span className="qe-label">Google tracker</span><StatusBadge value={dashboard.connections.sheets ? "connected" : "not_connected"} /></p>
              <Button disabled={busy} onClick={() => runAction("/connections/sheets", dashboard.connections.sheets ? "DELETE" : "POST")}>{dashboard.connections.sheets ? "Pause tracker" : "Connect tracker"}</Button>
            </div>
          </div>
        </Panel>
        <Panel title="Sync history" description="The latest runs, newest first." flush>
          {failedRecently && <div className="qe-panel-body"><Alert tone="warning">The last three syncs failed. Review setup and run history before retrying.</Alert></div>}
          <DataTable caption="Sync history" columns={runColumns} rows={dashboard.runs.slice(0, 10)} rowKey={(run) => run.id} stickyHeader={false} density="compact" empty="No sync runs yet." />
        </Panel>
        <Panel title="Privacy" description="Message excerpts expire after 30 days; run history after 90 days. Evidence identifiers and owner decisions remain until you delete them.">
          <Button disabled={busy} onClick={() => runAction("/reprocess", "POST", undefined, "Retained evidence will be reprocessed on the next sync.")}>Reprocess retained evidence</Button>
        </Panel>
        <section className="qe-danger-zone" aria-labelledby="danger-heading">
          <div className="qe-stack" data-gap="1">
            <h2 id="danger-heading">Danger zone</h2>
            <p className="qe-text-secondary">Deleting job data cannot be undone. Export your applications first if you need a copy.</p>
          </div>
          <Button variant="destructive" disabled={busy} onClick={() => { setAttempted(false); setConfirming(true); }}>Delete all job data</Button>
        </section>
        <Drawer open={confirming} title="Delete all job data" onClose={() => setConfirming(false)}>
          <form className="qe-stack" data-gap="4" onSubmit={(event) => { event.preventDefault(); void deleteAll(String(new FormData(event.currentTarget).get("confirmation"))); }}>
            <Alert tone="danger" title="This cannot be undone">This removes connections and all imported records. Export first if you need a copy. Deleted data cannot be recovered, and imports stay paused until you reconnect.</Alert>
            {attempted && error && <Alert tone="danger" title="Nothing was deleted">{error}</Alert>}
            <Field label={`Type ${CONFIRMATION}`}>{(control) => <input {...control} className="qe-input" name="confirmation" required pattern={CONFIRMATION} autoComplete="off" />}</Field>
            <div className="qe-cluster"><Button type="submit" variant="destructive" disabled={busy}>Delete permanently</Button></div>
          </form>
        </Drawer>
      </>;
    }}</DashboardGate>
  </>;
}

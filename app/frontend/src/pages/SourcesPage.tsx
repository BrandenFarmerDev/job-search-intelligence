import { useState } from "react";
import type { GmailConnectionStatus, GmailSyncResponse, SyncRun } from "@job-search/shared";
import { DashboardGate } from "../components/DashboardGate";
import { PageHeader } from "../components/PageHeader";
import { Alert, Button, DataTable, Drawer, Field, Panel, StatusBadge, humanize, type Column } from "../components/ui";
import { errorMessage, intelligenceApi } from "../lib/api";
import { useDashboard } from "../lib/dashboard-context";
import { formatDateTime, formatDuration } from "../lib/format";
import { useApiResource } from "../lib/use-api";

type GmailStatus = GmailConnectionStatus;
const requiredLabels = ["Job search", "Application receipts", "Recruiter follow ups", "Interviews", "Offers", "Rejections", "Job alerts", "Review"];

const runColumns: Column<SyncRun>[] = [
  { key: "started", header: "Started", render: (run) => formatDateTime(run.started_at) },
  { key: "trigger", header: "Trigger", render: (run) => run.trigger ? humanize(run.trigger) : "—" },
  { key: "status", header: "Status", render: (run) => <StatusBadge value={run.status} /> },
  { key: "finished", header: "Finished", render: (run) => run.finished_at ? formatDateTime(run.finished_at) : "Not finished" },
  { key: "duration", header: "Duration", align: "end", render: (run) => run.finished_at ? formatDuration(run.started_at, run.finished_at) : "—" },
  { key: "error", header: "Error", render: (run) => run.error_code ? humanize(run.error_code) : "—" },
];

export function SourcesPage() {
  const { busy, refresh, revision, runAction, error } = useDashboard();
  const gmailResource = useApiResource<GmailStatus>("/connections/gmail", revision, "Gmail connection status unavailable");
  const gmail = gmailResource.data;
  const gmailLoading = gmailResource.loading;
  const [confirming, setConfirming] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busyGmail, setBusyGmail] = useState(false);
  const [notice, setNotice] = useState("");
  const [gmailActionError, setGmailActionError] = useState("");

  async function gmailAction(action: "sync" | "resume") {
    setBusyGmail(true); setGmailActionError(""); setNotice("");
    try {
      const result = await intelligenceApi<GmailSyncResponse>("/gmail/sync/run", "POST", { action });
      setNotice(action === "resume" ? "Gmail ingestion resumed and sync queued." : "Gmail sync queued.");
      refresh();
      return result;
    } catch (reason) { setGmailActionError(errorMessage(reason, "Gmail sync could not be queued")); }
    finally { setBusyGmail(false); }
  }
  async function connectGmail() {
    setBusyGmail(true); setGmailActionError("");
    try {
      const result = await intelligenceApi<{ authorizationUrl: string }>("/connections/gmail/start", "POST");
      window.location.assign(result.authorizationUrl);
    } catch (reason) { setGmailActionError(errorMessage(reason, "Gmail authorization could not be started")); setBusyGmail(false); }
  }
  async function deleteAll(confirmation: string) {
    setAttempted(true);
    if (await runAction("/data", "DELETE", { confirmation }, "All job data was deleted. Imports stay paused until you reconnect a source.")) setConfirming(false);
  }

  return <>
    <PageHeader title="Sources & privacy" description="Connect Gmail and the read-only tracker, review sync coverage and control the data this workspace keeps." />
    <DashboardGate>{(dashboard) => {
      const failedRecently = dashboard.runs.slice(0, 3).filter((run) => run.status === "failed").length >= 3;
      const connected = gmail?.connected === true;
      const stateLabel = gmailLoading ? "Loading" : gmail?.status === "connected" ? "Connected" : gmail?.status === "reconnect_required" ? "Reconnect required" : gmail?.status === "setup_required" ? "Setup required" : "Not connected";
      return <>
        <Panel title="Connections" description="Gmail is the only mailbox source. The app reads labeled messages with read-only access; it never sends, labels, or deletes mail. The Google tracker connection remains separate."
          actions={<>
            <Button variant="primary" disabled={busy || busyGmail || !connected || !gmail?.labels.ready} onClick={() => void gmailAction("sync")}>Run Gmail sync</Button>
            <Button disabled={busy || busyGmail || !connected} onClick={() => void gmailAction("resume")}>Resume Gmail imports</Button>
            <Button disabled={busy || busyGmail} onClick={() => refresh()}>Refresh</Button>
          </>}>
          <div className="qe-stack" data-gap="5">
            <div className="qe-connection">
              <span className="qe-label">Gmail mailbox</span><StatusBadge value={stateLabel.toLowerCase().replaceAll(" ", "_")} />
              <p className="qe-help">Expected account: branden.farmer.dev@gmail.com</p>
              {gmail?.accountEmail && <p className="qe-help">Connected account: {gmail.accountEmail}</p>}
              <div className="qe-connection-action">
                {!connected ? <Button disabled={busy || busyGmail || !gmail?.configured} onClick={() => void connectGmail()}>{gmail?.status === "reconnect_required" ? "Reconnect Gmail" : "Connect Gmail"}</Button> : <Button disabled={busy || busyGmail} onClick={() => void gmailAction("sync")}>Sync now</Button>}
              </div>
            </div>
            {gmail?.status === "setup_required" && <Alert tone="warning" title="Gmail setup is incomplete">OAuth is not configured for this environment. No mailbox has been connected.</Alert>}
            {gmail?.status === "reconnect_required" && <Alert tone="warning" title="Reconnect Gmail">The saved authorization needs owner action. Reconnect to resume mailbox reads.</Alert>}
            {gmail && !gmail.labels.ready && <Alert tone="warning" title="Required Gmail labels are missing">Create the parent label <strong>Job search</strong> and its child labels before syncing: {gmail.labels.missing.join(", ") || requiredLabels.join(", ")}.</Alert>}
            <div className="qe-panel-body" aria-label="Gmail coverage">
              <h3>Mail coverage</h3>
              <p>Recent poll: {gmail?.lastRecentPollAt ? formatDateTime(gmail.lastRecentPollAt) : "Not yet completed"}. Historical sweep: {gmail?.lastSweepAt ? formatDateTime(gmail.lastSweepAt) : "Not yet completed"}.</p>
              <p>{gmail?.pending ?? 0} pending messages · {gmail?.review ?? 0} messages for review.</p>
              {gmail?.coverageWarning && <Alert tone="warning">{gmail.coverageWarning}</Alert>}
              <p className="qe-help">Incoming mail from Live depends on server-side redirect rules. Live Sent Items are not captured automatically; send future applications and replies from Gmail and label relevant sent messages.</p>
              <p className="qe-help">Gmail labels required: {requiredLabels.join(", ")}.</p>
              <p className="qe-help">The read-only permission covers the mailbox. The application processes messages under the exact Job search label; labels do not narrow Google's permission grant.</p>
            </div>
            <div className="qe-connection">
              <span className="qe-label">Google tracker</span><StatusBadge value={dashboard.connections.sheets ? "connected" : "not_connected"} />
              <div className="qe-connection-action"><Button disabled={busy} onClick={() => runAction("/connections/sheets", dashboard.connections.sheets ? "DELETE" : "POST")}>{dashboard.connections.sheets ? "Pause tracker" : "Connect tracker"}</Button></div>
            </div>
            {(gmailActionError || gmailResource.error || error) && <Alert tone="danger">{gmailActionError || gmailResource.error || error}</Alert>}
            {notice && <p role="status" className="qe-help">{notice}</p>}
            {gmailLoading && <p role="status" className="qe-help">Loading Gmail connection status…</p>}
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
          <div className="qe-stack" data-gap="1"><h2 id="danger-heading">Danger zone</h2><p className="qe-text-secondary">Deleting job data cannot be undone. Export your applications first if you need a copy.</p></div>
          <Button variant="destructive" disabled={busy} onClick={() => { setAttempted(false); setPhrase(""); setConfirming(true); }}>Delete all job data</Button>
        </section>
        <Drawer open={confirming} title="Delete all job data" onClose={() => setConfirming(false)}>
          <form className="qe-stack" data-gap="4" onSubmit={(event) => { event.preventDefault(); if (phrase === "DELETE ALL JOB DATA") void deleteAll(phrase); }}>
            <Alert tone="danger" title="This cannot be undone">This removes connections and all imported records. Export first if you need a copy. Deleted data cannot be recovered, and imports stay paused until you reconnect.</Alert>
            {attempted && error && <Alert tone="danger" title="Nothing was deleted">{error}</Alert>}
            <Field label="Type DELETE ALL JOB DATA">{(control) => <input {...control} className="qe-input" name="confirmation" value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" />}</Field>
            <div className="qe-cluster"><Button onClick={() => setConfirming(false)}>Cancel</Button><Button type="submit" variant="destructive" disabled={busy || phrase !== "DELETE ALL JOB DATA"}>Delete permanently</Button></div>
          </form>
        </Drawer>
      </>;
    }}</DashboardGate>
  </>;
}

import { useId, useRef, useState, type RefObject } from "react";
import type { ApplicationRecord } from "@job-search/shared";
import { type ApplicationBody, type ApplicationDetail } from "../lib/applications";
import { useDashboard } from "../lib/dashboard-context";
import { formatDate } from "../lib/format";
import { useApiResource } from "../lib/use-api";
import { ApplicationForm } from "./ApplicationForm";
import { ApplicationPicker } from "./ApplicationPicker";
import { ApplicationTimeline } from "./ApplicationTimeline";
import { ErrorAlert } from "./ErrorAlert";
import { StatusOptions } from "./StatusOptions";
import { Alert, Button, Drawer, Field, Skeleton, StatusBadge, Tabs, humanize } from "./ui";

const tabs = [{ id: "timeline", label: "Timeline" }, { id: "details", label: "Details" }, { id: "merge", label: "Merge" }];
export interface ApplicationDrawerProps { appId: string; onClose: () => void; fallbackFocusRef: RefObject<HTMLElement | null> }

// Opens from the `app` URL parameter and loads its own record, so a deep link works when the row is not on the current page.
export function ApplicationDrawer({ appId, onClose, fallbackFocusRef }: ApplicationDrawerProps) {
  const { revision } = useDashboard();
  const detail = useApiResource<ApplicationDetail>(appId ? `/applications/${encodeURIComponent(appId)}` : null, revision, "Timeline unavailable");
  const application = detail.data?.application;
  return <Drawer open={Boolean(appId)} title={application ? `${application.company} — ${application.role}` : "Application details"} onClose={onClose} fallbackFocusRef={fallbackFocusRef}>
    {detail.error ? <ErrorAlert message={detail.error} />
      : detail.data ? <DetailBody key={detail.data.application.id} detail={detail.data} onDone={onClose} />
      : <div aria-busy="true"><p role="status" className="qe-visually-hidden">Loading application…</p><Skeleton lines={4} /></div>}
  </Drawer>;
}

function DetailBody({ detail: { application, events, overrides }, onDone }: { detail: ApplicationDetail; onDone: () => void }) {
  const { busy, error, runAction } = useDashboard();
  const [tab, setTab] = useState("timeline");
  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const excludeButton = useRef<HTMLButtonElement>(null);
  async function save(path: string, method: string, body: object) {
    setAttempted(true);
    if (await runAction(path, method, body)) onDone();
  }
  const base = `/applications/${application.id}`;
  return <div className="qe-stack" data-gap="5">
    <Summary application={application} />
    {attempted && error && <ErrorAlert message={error} title="Not saved" />}
    <Tabs label="Application detail" tabs={tabs} value={tab} onChange={setTab}>
      {tab === "timeline" ? <ApplicationTimeline events={events} overrides={overrides} />
        : tab === "details" ? <div className="qe-stack" data-gap="3"><h3>Correct application</h3><ApplicationForm key={application.id} application={application} busy={busy} submitLabel="Save application" onSubmit={(body: ApplicationBody) => save(base, "PATCH", body)} /></div>
        : <MergeForm application={application} busy={busy} onMerge={(body) => save(`${base}/merge`, "POST", body)} />}
    </Tabs>
    <hr className="qe-divider" />
    <div className="qe-stack" data-gap="3">
      <Button ref={excludeButton} variant="destructive" aria-expanded={confirming} disabled={busy} onClick={() => setConfirming(true)}>Exclude application</Button>
      {confirming && <Alert tone="warning" title="Exclude this application?">
        <p>It will no longer appear in the application list, analytics or CSV export. Source evidence is kept and the decision is recorded in the audit history. This workspace has no way to restore it.</p>
        <div className="qe-cluster qe-alert-actions">
          <Button variant="destructive" disabled={busy} onClick={() => save(base, "PATCH", { excluded: true })}>Confirm exclusion</Button>
          <Button onClick={() => { setConfirming(false); excludeButton.current?.focus(); }}>Cancel</Button>
        </div>
      </Alert>}
    </div>
  </div>;
}

function Summary({ application }: { application: ApplicationRecord }) {
  return <dl className="qe-dl">
    <dt>Status</dt><dd><StatusBadge value={application.status} /></dd>
    <dt>Reconciliation</dt><dd><StatusBadge value={application.reconciliation} /></dd>
    <dt>Applied</dt><dd>{formatDate(application.applied_at)}</dd>
    <dt>Requisition</dt><dd>{application.requisition_id ?? "Not recorded"}</dd>
    <dt>Source</dt><dd>{humanize(application.source)}</dd>
  </dl>;
}

function MergeForm({ application, busy, onMerge }: { application: ApplicationRecord; busy: boolean; onMerge: (body: { targetId: string; status: string }) => void }) {
  const heading = useId();
  const [target, setTarget] = useState("");
  const [status, setStatus] = useState(application.status);
  return <form className="qe-stack" data-gap="4" aria-labelledby={heading} onSubmit={(event) => { event.preventDefault(); if (target) onMerge({ targetId: target, status }); }}>
    <div className="qe-stack" data-gap="1">
      <h3 id={heading}>Merge into another application</h3>
      <p className="qe-text-secondary">Moves this application&apos;s evidence to the application you choose, then removes this one from the list.</p>
    </div>
    <ApplicationPicker label="Merge into" excludeId={application.id} value={target} onChange={setTarget} required />
    <Field label="Verified status after merge">{(control) => <select {...control} className="qe-input" value={status} onChange={(event) => setStatus(event.target.value)}><StatusOptions /></select>}</Field>
    <div className="qe-cluster"><Button type="submit" disabled={busy}>Merge evidence</Button></div>
  </form>;
}

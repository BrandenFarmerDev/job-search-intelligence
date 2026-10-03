import { useId, useRef, useState } from "react";
import { DashboardGate } from "../components/DashboardGate";
import { ApplicationPicker } from "../components/ApplicationPicker";
import { PageHeader } from "../components/PageHeader";
import { StatusOptions } from "../components/StatusOptions";
import { Alert, Button, EmptyState, Field, Panel, StatusBadge, humanize } from "../components/ui";
import { useDashboard } from "../lib/dashboard-context";
import type { ReviewItem } from "../lib/applications";

const QUEUE_CAP = 100;

export function ReviewPage() {
  const { reviews, busy, runAction } = useDashboard();
  const [openId, setOpenId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  async function decide(body: object) {
    // The resolved item leaves the queue, so focus returns to the page heading rather than a removed button.
    if (await runAction("/review/decision", "POST", body)) { setOpenId(null); heading.current?.focus(); }
  }
  return <>
    <PageHeader title="Review" headingRef={heading} description="Uncertain source records wait here until you link them to an application or exclude them." />
    <DashboardGate>{() => <>
      {reviews.length >= QUEUE_CAP && <Alert tone="info">Showing the first {QUEUE_CAP} records. Resolve some to see the rest.</Alert>}
      <Panel title="Source records to review" description="Each record was found in Outlook or the tracker but could not be matched with confidence.">
        {!reviews.length ? <EmptyState title="No outstanding source records." description="New uncertain matches appear here after the next sync." />
          : <ul className="qe-review-list">{reviews.map((item) => <li key={item.id} className="qe-review-item">
            <ReviewRow item={item} open={openId === item.id} busy={busy} onToggle={() => setOpenId(openId === item.id ? null : item.id)} onDecide={decide} />
          </li>)}</ul>}
      </Panel>
    </>}</DashboardGate>
  </>;
}

interface ReviewRowProps { item: ReviewItem; open: boolean; busy: boolean; onToggle: () => void; onDecide: (body: object) => void }
function ReviewRow({ item, open, busy, onToggle, onDecide }: ReviewRowProps) {
  const formId = useId();
  const [application, setApplication] = useState("");
  const [type, setType] = useState("");
  const title = item.subject || "Tracker row";
  return <>
    <div className="qe-review-summary">
      <div className="qe-stack" data-gap="1">
        <h3>{title}</h3>
        <p className="qe-cluster" data-gap="2"><span className="qe-text-secondary">{humanize(item.source)}</span><StatusBadge value={item.state} /></p>
        <p className="qe-text-secondary">{item.reason}</p>
        {item.available === 0 && <p className="qe-text-muted">Source no longer available in the tracked folder or sheet range.</p>}
      </div>
      <Button size="compact" aria-expanded={open} aria-controls={formId} aria-label={`Resolve ${title}`} onClick={onToggle}>Resolve</Button>
    </div>
    {open && <form id={formId} className="qe-review-form qe-stack" data-gap="4" aria-label={`Decision for ${title}`} onSubmit={(event) => {
      event.preventDefault();
      if (application && type) onDecide({ source: item.source, sourceId: item.source_id, applicationId: application, type });
    }}>
      <ApplicationPicker label="Canonical application" value={application} onChange={setApplication} required />
      <Field label="Verified event">{(control) => <select {...control} className="qe-input" required value={type} onChange={(event) => setType(event.target.value)}><option value="">Choose event</option><StatusOptions /></select>}</Field>
      <div className="qe-cluster">
        <Button type="submit" variant="primary" disabled={busy}>Save decision</Button>
        <Button variant="quiet" disabled={busy} onClick={() => onDecide({ source: item.source, sourceId: item.source_id, exclude: true })}>Exclude source</Button>
      </div>
    </form>}
  </>;
}

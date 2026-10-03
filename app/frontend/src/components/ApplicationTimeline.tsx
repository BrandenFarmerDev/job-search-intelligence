import type { ApplicationDetail } from "../lib/applications";
import { formatDate, plural } from "../lib/format";
import { ExternalLinkIcon, humanize } from "./ui";

export function ApplicationTimeline({ events, overrides }: Pick<ApplicationDetail, "events" | "overrides">) {
  return <div className="qe-stack" data-gap="4">
    {!events.length ? <p className="qe-text-secondary">No evidence has been recorded for this application.</p>
      : <ol className="qe-timeline" aria-label="Evidence timeline">{events.map((event) => <li key={event.id}>
        <p><time dateTime={event.occurred_at}>{formatDate(event.occurred_at)}</time>{event.date_known === 0 && <span className="qe-text-muted"> (observed; event date unknown)</span>}</p>
        <p className="qe-timeline-title">{humanize(event.type)} <span className="qe-text-muted">· {humanize(event.source)}</span></p>
        {event.subject && <p className="qe-text-secondary">{event.subject}</p>}
        {event.superseded === 1 && <p className="qe-text-muted">Superseded by a later source classification or owner decision</p>}
        {event.available === 0 && <p className="qe-text-muted">Source no longer in a tracked folder</p>}
        {event.web_link && <p><a href={event.web_link} target="_blank" rel="noreferrer">Open Outlook evidence <span className="qe-text-muted">(opens Outlook)</span><ExternalLinkIcon /></a></p>}
      </li>)}</ol>}
    <div>
      <p className="qe-label">{plural(overrides.length, "recorded owner decision")}</p>
      {overrides.length > 0 && <ul className="qe-text-secondary">{overrides.map((override, index) => <li key={index}>{humanize(override.field)} · {formatDate(override.created_at)}</li>)}</ul>}
    </div>
  </div>;
}

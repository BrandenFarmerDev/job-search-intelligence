import { ApiStatus } from "../components/ApiStatus";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/ui";
import { plannedCapabilities } from "../content/project";

export function AboutPage() {
  return <>
    <PageHeader title="A reviewable job-search timeline" description="Review application progress alongside the source evidence and your own decisions." />
    <ApiStatus />
    <Panel title="How this workspace works" description="Outlook and tracker connections are read-only. Uncertain matches require your review before they affect results.">
      <div className="qe-grid" data-cols="3" data-gap="6">{plannedCapabilities.map((item) => <article key={item.title} className="qe-stack" data-gap="1">
        <h3>{item.title}</h3><p className="qe-text-secondary">{item.description}</p>
      </article>)}</div>
    </Panel>
    <Panel title="Connections in version one">
      <p className="qe-reading">Import uses a local Outlook export and a read-only tracker connection. Microsoft Graph access is a future option only: it is disabled in version one, and this workspace never connects to the Outlook API.</p>
    </Panel>
  </>;
}

import { ApiStatus } from "../components/ApiStatus";
import { plannedCapabilities } from "../content/project";

export function HomePage() {
  return <>
    <p className="eyebrow">Private owner workspace</p>
    <h1>A reviewable job-search timeline.</h1>
    <p className="intro">Review application progress alongside the source evidence and your own decisions.</p>
    <p>Outlook and tracker connections are read-only. The dashboard shows their connection state; import requires provider setup and owner consent. Uncertain matches require review.</p>
    <ApiStatus />
    <section aria-labelledby="planned-heading">
      <h2 id="planned-heading">How this workspace works</h2>
      <div className="capabilities">{plannedCapabilities.map((item) => <article key={item.title}>
        <h3>{item.title}</h3><p>{item.description}</p>
      </article>)}</div>
    </section>
  </>;
}

import { useEffect, useState } from "react";
import type { ApplicationRecord, Dashboard } from "@job-search/shared";
import { eventTypes } from "@job-search/shared";
import { exportUrl, intelligenceApi } from "../lib/api";

interface Timeline { application: ApplicationRecord; events: { id: string; type: string; occurred_at: string; source: string; date_known:number; superseded:number; web_link: string | null; available: number; subject: string | null }[]; overrides: {field:string;created_at:string}[] }
interface Review { id: string; source: string; source_id: string; state: string; reason: string; subject: string | null; available:number }
const label = (value: string) => value.replaceAll("_", " ");
export function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [apps, setApps] = useState<ApplicationRecord[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""); const [status, setStatus] = useState(""); const [sort, setSort] = useState("date"); const [page, setPage] = useState(0); const [hasMore, setHasMore] = useState(false);
  const [filters,setFilters]=useState({source:"",reconciliation:"",from:"",to:""});
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([intelligenceApi<Dashboard>("/dashboard", "GET", undefined, controller.signal), intelligenceApi<Review[]>("/review", "GET", undefined, controller.signal)])
      .then(([dashboard, review]) => { if (!controller.signal.aborted) { setData(dashboard); setReviews(review); setError(""); } })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    intelligenceApi<{applications:ApplicationRecord[];hasMore:boolean}>(`/applications?${new URLSearchParams({ q: query, status, sort, ...filters,page: String(page) })}`, "GET", undefined, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setApps(result.applications); setHasMore(result.hasMore); } })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [query, status, sort, filters,page, revision]);
  async function action(path: string, method = "POST", body?: object) {
    setBusy(true); setError(""); setNotice("");
    try { await intelligenceApi(path, method, body); setNotice("Saved. The dashboard has been refreshed."); setRevision((value) => value + 1); setTimeline(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed"); }
    finally { setBusy(false); }
  }
  async function select(id: string) {
    try { setTimeline(await intelligenceApi<Timeline>(`/applications/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Timeline unavailable"); }
  }
  async function importLocalOutlook(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (file.size > 10_000_000) throw new Error("Local Outlook export is larger than 10 MB.");
      const bundle: unknown = JSON.parse(await file.text());
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("Invalid local Outlook export.");
      const source = bundle as Record<string, unknown>; if (!Array.isArray(source.messages) || source.messages.length > 10_000) throw new Error("Invalid local Outlook export.");
      const summary = source.summary;
      if (!summary || typeof summary !== "object" || Array.isArray(summary) || !("truncated" in summary)) throw new Error("Invalid local Outlook export.");
      if ((summary as Record<string, unknown>).truncated === true) throw new Error("This export reached its message cap. Export a narrower date range and try again.");
      if ((summary as Record<string, unknown>).truncated !== false) throw new Error("Invalid local Outlook export.");
      let imported = 0;
      for (let index=0; index<source.messages.length; index+=40) {
        const result = await intelligenceApi<{imported:number}>("/local-outlook/import","POST",{...source,messages:source.messages.slice(index,index+40)});
        imported += result.imported;
      }
      await intelligenceApi("/sync/run","POST");
      setNotice(`Imported ${imported} local Outlook messages. Classification is running.`); setRevision(value=>value+1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Local Outlook import failed"); }
    finally { setBusy(false); }
  }
  return <>
    <p className="eyebrow">Owner workspace</p><h1>Job search intelligence</h1>
    <p>Review application progress, source evidence, and records that need a decision.</p>
    {error && <p role="alert">{error} <a href={`${import.meta.env.VITE_API_BASE_URL || ""}/api/job-intelligence/session`}>Sign in to the private API</a></p>}{notice && <p role="status">{notice}</p>}
    {!data ? <p role="status">{error ? "The private dashboard is unavailable. Your records have not been loaded." : "Loading private dashboard…"}</p> : <>
      <section aria-labelledby="connections"><h2 id="connections">Connections and sync</h2>
        <div className="toolbar"><label>Import local Outlook JSON<input type="file" accept="application/json,.json" disabled={busy} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void importLocalOutlook(file);}} /></label>
          <span>Local Outlook: {data.connections.localOutlook ? "imported" : "not imported"}</span>
          <span>Tracker: {data.connections.sheets ? "connected" : "not connected"}</span><button disabled={busy} onClick={() => action("/connections/sheets", data.connections.sheets ? "DELETE" : "POST")}>{data.connections.sheets ? "Pause tracker" : "Connect tracker"}</button>
          <button disabled={busy} onClick={() => action("/sync/run")}>Run sync</button><button disabled={busy} onClick={() => setRevision((value) => value + 1)}>Refresh</button><a href={exportUrl()}>Export CSV</a>
        </div><p className="muted">Version one uses the local Outlook export and a read-only tracker connection. Sync never sends email or changes your spreadsheet.</p>
        {data.runs.slice(0, 3).filter((run) => run.status === "failed").length >= 3 && <p role="alert">The last three syncs failed. Review setup and run history before retrying.</p>}
        <ul>{data.runs.slice(0, 5).map((run) => <li key={run.id}>{new Date(run.started_at).toLocaleString()} · {label(run.status)} {run.error_code && `· ${label(run.error_code)}`}</li>)}</ul>
      </section>
      <section aria-labelledby="metrics"><h2 id="metrics">Application progress</h2><dl className="metrics">
        {Object.entries(data.metrics).map(([key, value]) => <div key={key}><dt>{label(key.replace(/([A-Z])/g, " $1"))}</dt><dd>{key.endsWith("Rate") ? `${Math.round(value * 100)}%` : Math.round(value * 10) / 10}</dd></div>)}
      </dl></section>
      <section aria-labelledby="charts"><h2 id="charts">Trends and funnel</h2><div className="charts">
        <Chart name="Funnel" values={Object.fromEntries(["total", "responses", "screenings", "interviews", "offers"].map((key) => [key, data.metrics[key] || 0]))} />
        {Object.entries(data.groups).map(([name, values]) => <Chart key={name} name={label(name)} values={values} />)}
      </div></section>
      <section aria-labelledby="follow-ups"><h2 id="follow-ups">Follow-up recommendations</h2><p>Applications with no response after seven days. Review the evidence before contacting anyone.</p>
        {!data.followUps?.length ? <p>No follow-ups due.</p> : <ul>{data.followUps.map(item=><li key={item.application_id}>{item.company} · {item.role} · Due {item.due_at.slice(0,10)} <button onClick={()=>select(item.application_id)}>Review evidence</button></li>)}</ul>}
      </section>
      <section aria-labelledby="applications"><h2 id="applications">Applications</h2><div className="toolbar">
        <label>Search company or role<input value={query} onChange={(event) => {setQuery(event.target.value);setPage(0);}} /></label>
        <label>Status<select value={status} onChange={(event) => {setStatus(event.target.value);setPage(0);}}><option value="">All statuses</option>{eventTypes.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></label>
        <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="date">Newest applied</option><option value="company">Company</option></select></label>
        <label>Source<select value={filters.source} onChange={event=>{setFilters({...filters,source:event.target.value});setPage(0);}}><option value="">All sources</option>{["email","sheet","manual"].map(value=><option key={value}>{value}</option>)}</select></label>
        <label>Reconciliation<select value={filters.reconciliation} onChange={event=>{setFilters({...filters,reconciliation:event.target.value});setPage(0);}}><option value="">All states</option>{["matched","email_only","sheet_only","conflict","needs_review"].map(value=><option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Applied from<input type="date" value={filters.from} onChange={event=>{setFilters({...filters,from:event.target.value});setPage(0);}} /></label><label>Applied through<input type="date" value={filters.to} onChange={event=>{setFilters({...filters,to:event.target.value});setPage(0);}} /></label>
      </div>{!apps.length ? <p>No applications match. Connect sources and run sync, or add a reviewed application.</p> : <div className="table-scroll"><table><thead><tr>{["Company / role", "Applied", "Status", "Reconciliation", "Evidence"].map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead><tbody>{apps.map((app) => <tr key={app.id}><td>{app.company}<br />{app.role}</td><td>{app.applied_at.slice(0, 10)}</td><td>{label(app.status)}</td><td>{label(app.reconciliation)}</td><td><button onClick={() => select(app.id)}>View {app.company}</button></td></tr>)}</tbody></table></div>}
        <div className="toolbar"><button disabled={!page} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page + 1}</span><button disabled={!hasMore} onClick={() => setPage((value) => value + 1)}>Next</button></div>
        <ApplicationEditor busy={busy} onSave={(body) => action("/applications", "POST", body)} />
      </section>
      {timeline && <section aria-labelledby="timeline"><h2 id="timeline">{timeline.application.company}: evidence timeline</h2><button onClick={() => setTimeline(null)}>Close timeline</button>
        <ol>{timeline.events.map((event) => <li key={event.id}>{event.occurred_at.slice(0, 10)}{event.date_known === 0 && " (observed; event date unknown)"} · {label(event.type)} · {event.source}{event.superseded === 1 && " · Superseded by a later source classification or owner decision"}{event.subject && <p>{event.subject}</p>}{event.web_link && <a href={event.web_link} target="_blank" rel="noreferrer">Open Outlook evidence</a>}{event.available === 0 && <span> · Source no longer in a tracked folder</span>}</li>)}</ol>
        <p>{timeline.overrides.length} recorded owner decisions.</p><ApplicationEditor key={timeline.application.id} application={timeline.application} busy={busy} onSave={(body) => action(`/applications/${timeline.application.id}`, "PATCH", body)} />
        <button disabled={busy} onClick={() => action(`/applications/${timeline.application.id}`, "PATCH", {excluded:true})}>Exclude application</button>
        <form onSubmit={(event) => {event.preventDefault();const form=new FormData(event.currentTarget);const targetId = String(form.get("target"));void action(`/applications/${timeline.application.id}/merge`, "POST", {targetId,status:form.get("mergedStatus")});}}>
          <label>Merge into<select name="target" required><option value="">Choose application</option>{apps.filter((app) => app.id !== timeline.application.id).map((app) => <option key={app.id} value={app.id}>{app.company} · {app.role}</option>)}</select></label><label>Verified status after merge<select name="mergedStatus" defaultValue={timeline.application.status}>{eventTypes.map(type=><option key={type} value={type}>{label(type)}</option>)}</select></label><button disabled={busy}>Merge evidence</button>
        </form>
      </section>}
      <section aria-labelledby="review"><h2 id="review">Reconciliation and review</h2>{!reviews.length && <p>No outstanding source records.</p>}
        {reviews.map((item) => <article key={item.id}><h3>{item.subject || "Tracker row"}</h3><p>{item.source} · {label(item.state)} · {item.reason}</p>
          {item.available === 0 && <p>Source no longer available in the tracked folder or sheet range.</p>}
          <form onSubmit={(event) => {event.preventDefault();const form = new FormData(event.currentTarget);void action("/review/decision", "POST", {source:item.source,sourceId:item.source_id,applicationId:form.get("application"),type:form.get("type")});}}>
            <label>Canonical application<select name="application" required><option value="">Choose application</option>{apps.map((app) => <option value={app.id} key={app.id}>{app.company} · {app.role}</option>)}</select></label>
            <label>Verified event<select name="type">{eventTypes.map((type) => <option value={type} key={type}>{label(type)}</option>)}</select></label><button disabled={busy}>Save decision</button>
          </form><button disabled={busy} onClick={() => action("/review/decision", "POST", {source:item.source,sourceId:item.source_id,exclude:true})}>Exclude source</button>
        </article>)}
      </section>
      <section aria-labelledby="privacy"><h2 id="privacy">Privacy controls</h2><p>Message excerpts expire after 30 days; run history after 90 days. Evidence identifiers and owner decisions remain until you delete them.</p>
        <button disabled={busy} onClick={() => action("/reprocess")}>Reprocess retained evidence</button>
        <details><summary>Delete all job data</summary><p>This removes connections and all imported records. Export first if you need a copy.</p><form onSubmit={(event) => {event.preventDefault();void action("/data", "DELETE", {confirmation:new FormData(event.currentTarget).get("confirmation")});}}><label>Type DELETE ALL JOB DATA<input name="confirmation" required pattern="DELETE ALL JOB DATA" autoComplete="off" /></label><button disabled={busy}>Delete permanently</button></form></details>
      </section>
    </>}
  </>;
}
function Chart({ name, values }: {name:string;values:Record<string,number>}) {
  const maximum = Math.max(1, ...Object.values(values));
  return <article><h3>{name}</h3>{!Object.keys(values).length && <p>No data yet.</p>}{Object.entries(values).slice(0, 20).map(([key, value]) => <p className="chart-row" key={key}><span>{label(key)} ({value})</span><meter min={0} max={maximum} value={value} aria-label={`${name}: ${label(key)}`} /></p>)}</article>;
}
function ApplicationEditor({ application, busy, onSave }: {application?:ApplicationRecord;busy:boolean;onSave:(body:object)=>void}) {
  return <form onSubmit={(event) => { event.preventDefault();const form = new FormData(event.currentTarget);onSave({company:form.get("company"),role:form.get("role"),applied_at:form.get("date"),status:form.get("status")}); }}>
    <h3>{application ? "Correct application" : "Add reviewed application"}</h3><div className="toolbar">
      <label>Company<input name="company" required maxLength={200} defaultValue={application?.company} /></label><label>Role<input name="role" required maxLength={200} defaultValue={application?.role} /></label>
      <label>Applied date<input name="date" type="date" required defaultValue={application?.applied_at.slice(0, 10)} /></label>
      <label>Status<select name="status" defaultValue={application?.status || "application_submitted"}>{eventTypes.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></label><button disabled={busy}>Save application</button>
    </div>
  </form>;
}

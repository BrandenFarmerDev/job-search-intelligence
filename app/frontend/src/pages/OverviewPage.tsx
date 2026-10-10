import { useState } from "react";
import { Link } from "react-router-dom";
import type { Dashboard, OutcomeCounts, OutcomeDimension } from "@job-search/shared";
import { DashboardGate } from "../components/DashboardGate";
import { PageHeader } from "../components/PageHeader";
import { BarChart, ColumnChart, StageReach } from "../components/charts";
import { DataTable, EmptyState, Kpi, Panel, Skeleton, Tabs, humanize, type Column, type SortState } from "../components/ui";
import { formatDate, formatMonth, oneDecimal, percent, plural } from "../lib/format";
import { useDashboard } from "../lib/dashboard-context";
import { REVIEW_CAP } from "../lib/applications";

const FOLLOW_UP_DAYS = 7; const DAY = 86_400_000;
const dimensions: { id: OutcomeDimension; label: string; header: string }[] = [
  { id: "source", label: "By source", header: "Source" }, { id: "company", label: "By company", header: "Company" }, { id: "role", label: "By role", header: "Role" },
];
interface InsightRow extends OutcomeCounts { name: string; rate: number }
type InsightKey = "name" | "applied" | "responses" | "rate" | "interviews" | "offers" | "rejections" | "median";
const insightValue = (row: InsightRow, key: InsightKey): string | number | null => key === "name" ? row.name : key === "median" ? row.medianResponseDays : row[key];

function compareRows(key: InsightKey, direction: SortState["direction"]) {
  const sign = direction === "ascending" ? 1 : -1;
  return (first: InsightRow, second: InsightRow): number => {
    const a = insightValue(first, key); const b = insightValue(second, key);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return (typeof a === "string" ? a.localeCompare(String(b)) : a - Number(b)) * sign;
  };
}

export function OverviewPage() {
  return <>
    <PageHeader title="Overview" description="Application progress, response outcomes and the records that need a decision." />
    <DashboardGate skeleton={<OverviewSkeleton />}>{(dashboard) => dashboard.total === 0
      ? <EmptyState title="No applications yet" description="Import a local Outlook export or connect the tracker, then run a sync. You can also add a reviewed application by hand."
        action={<Link className="qe-button" data-variant="primary" to="/sources">Open Sources &amp; privacy</Link>} />
      : <OverviewContent dashboard={dashboard} />}</DashboardGate>
  </>;
}

function OverviewSkeleton() {
  return <>
    <div className="qe-kpi-strip">{Array.from({ length: 5 }, (_, index) => <div className="qe-kpi" key={index}><Skeleton width="medium" /><Skeleton /></div>)}</div>
    <div className="qe-grid" data-cols="2"><Skeleton variant="block" /><Skeleton variant="block" /></div>
  </>;
}

function OverviewContent({ dashboard }: { dashboard: Dashboard }) {
  const { metrics, groups, weekly, medianFirstResponseDays } = dashboard;
  const { reviews } = useDashboard();
  const queue = reviews.length >= REVIEW_CAP ? `${REVIEW_CAP}+ source records` : plural(reviews.length, "source record");
  const earliest = Object.keys(groups.month ?? {}).sort()[0];
  const distribution = (name: string) => Object.entries(groups[name] ?? {}).map(([label, value]) => ({ label: humanize(label), value }));
  return <>
    <div className="qe-stack" data-gap="3">
      {earliest && <p className="qe-text-secondary">Applications since {formatMonth(earliest)}</p>}
      <div className="qe-kpi-strip" role="group" aria-label="Key figures">
        <Kpi label="Applications" value={metrics.total ?? 0} context={`${metrics.thisWeek ?? 0} in the last 7 days`} />
        <Kpi label="Response rate" value={percent(metrics.responsesRate ?? 0)} context={`${metrics.responses ?? 0} of ${metrics.total ?? 0} applications`} />
        <Kpi label="Interview rate" value={percent(metrics.interviewsRate ?? 0)} context={`${metrics.interviews ?? 0} of ${metrics.total ?? 0} applications`} />
        <Kpi label="Median days to first response" value={medianFirstResponseDays === null ? "Unavailable" : oneDecimal(medianFirstResponseDays)} unit={medianFirstResponseDays === null ? undefined : "days"}
          context={medianFirstResponseDays === null ? "No dated responses yet" : "Responses with a known date"} />
        <Kpi label="Applications needing review" value={metrics.review ?? 0} tone={metrics.review > 0 ? "warning" : undefined}
          context={metrics.review > 0 || reviews.length > 0 ? `${queue} in the review queue` : "Nothing waiting"} link={<Link to="/review">Open review queue</Link>} />
      </div>
    </div>
    <Panel title="Outcomes and trends">
      <div className="qe-grid" data-cols="2" data-gap="6">
        <StageReach headingLevel={3} total={metrics.total ?? 0} responses={metrics.responses ?? 0} screenings={metrics.screenings ?? 0} interviews={metrics.interviews ?? 0} offers={metrics.offers ?? 0} />
        <ColumnChart headingLevel={3} title="Applications per week" description="Weeks start on Monday (UTC), most recent 26 weeks." weeks={weekly} />
      </div>
    </Panel>
    <Panel title="Status and reconciliation">
      <div className="qe-grid" data-cols="2" data-gap="6">
        <BarChart headingLevel={3} title="Status distribution" items={distribution("status")} />
        <BarChart headingLevel={3} title="Reconciliation state" items={distribution("reconciliation")} />
      </div>
    </Panel>
    <Insights outcomes={dashboard.outcomes} />
    <FollowUps items={dashboard.followUps ?? []} />
  </>;
}

function Insights({ outcomes }: { outcomes: Dashboard["outcomes"] }) {
  const [dimension, setDimension] = useState<OutcomeDimension>("source");
  const [sort, setSort] = useState<SortState>({ key: "applied", direction: "descending" });
  const header = dimensions.find((item) => item.id === dimension)!.header;
  const rows: InsightRow[] = Object.entries(outcomes[dimension] ?? {}).map(([name, counts]) => ({ name, ...counts, rate: counts.applied ? counts.responses / counts.applied : 0 }))
    .sort(compareRows(sort.key as InsightKey, sort.direction));
  const number = (key: InsightKey, title: string, render: (row: InsightRow) => string | number): Column<InsightRow> => ({ key, header: title, align: "end", sortKey: key, render });
  const columns: Column<InsightRow>[] = [
    { key: "name", header, sortKey: "name", truncate: true, render: (row) => <Link to={`/applications?${new URLSearchParams({ [dimension]: row.name })}`}>{row.name}</Link> },
    number("applied", "Applied", (row) => row.applied), number("responses", "Responses", (row) => row.responses), number("rate", "Response rate", (row) => percent(row.rate)),
    number("interviews", "Interviews", (row) => row.interviews), number("offers", "Offers", (row) => row.offers), number("rejections", "Rejections", (row) => row.rejections),
    number("median", "Median response days", (row) => row.medianResponseDays === null ? "—" : oneDecimal(row.medianResponseDays)),
  ];
  return <Panel title="Insights" description="Outcomes grouped by source, company or role. Select a name to list those applications.">
    <Tabs label="Insight grouping" tabs={dimensions} value={dimension} onChange={(id) => setDimension(id as OutcomeDimension)}>
      <DataTable caption={`Outcomes ${dimensions.find((item) => item.id === dimension)!.label.toLowerCase()}`} density="compact" columns={columns} rows={rows} rowKey={(row) => row.name} sort={sort}
        onSort={(key) => setSort((current) => current.key === key ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" } : { key, direction: key === "name" ? "ascending" : "descending" })}
        empty="No outcomes recorded yet." />
    </Tabs>
  </Panel>;
}

function FollowUps({ items }: { items: NonNullable<Dashboard["followUps"]> }) {
  const [now] = useState(Date.now);
  const columns: Column<typeof items[number]>[] = [
    { key: "application", header: "Company / role", render: (item) => <span className="qe-two-line"><span className="qe-strong">{item.company}</span><span className="qe-text-muted">{item.role}</span></span> },
    { key: "applied", header: "Applied", render: (item) => formatDate(new Date(Date.parse(item.due_at) - FOLLOW_UP_DAYS * DAY).toISOString()) },
    { key: "due", header: "Due", render: (item) => formatDate(item.due_at) },
    { key: "overdue", header: "Days overdue", align: "end", render: (item) => Math.max(0, Math.floor((now - Date.parse(item.due_at)) / DAY)) },
  ];
  return <Panel title="Follow-ups due" description="Applications with no response after seven days. Review the evidence before contacting anyone." flush={items.length > 0}>
    {!items.length ? <p>No follow-ups due.</p>
      : <DataTable caption="Follow-ups due" density="compact" stickyHeader={false} columns={columns} rows={items} rowKey={(item) => item.application_id}
        action={{ header: "Evidence", render: (item) => <Link to={`/applications?app=${encodeURIComponent(item.application_id)}`}>Open evidence<span className="qe-visually-hidden"> for {item.company} {item.role}</span></Link> }} />}
  </Panel>;
}

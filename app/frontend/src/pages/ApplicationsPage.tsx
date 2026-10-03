import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { applicationSorts, type ApplicationListResponse, type ApplicationRecord, type ApplicationSort } from "@job-search/shared";
import { ApplicationDrawer } from "../components/ApplicationDrawer";
import { ApplicationForm } from "../components/ApplicationForm";
import { ErrorAlert } from "../components/ErrorAlert";
import { PageHeader } from "../components/PageHeader";
import { StatusOptions } from "../components/StatusOptions";
import { Button, DataTable, Drawer, EmptyState, Field, FilterChip, Pagination, SearchInput, StatusBadge, humanize, type Column, type SortState } from "../components/ui";
import { buildApplicationsQuery, datePresets, filterKeys, pageSizes, presetOf, reconciliationOptions, readView, sortLabels, sourceOptions, type DatePreset, type FilterKey } from "../lib/applications";
import { exportUrl } from "../lib/api";
import { useDashboard } from "../lib/dashboard-context";
import { daysAgo, formatDate, plural } from "../lib/format";
import { useApiResource } from "../lib/use-api";

const sortStates: Record<ApplicationSort, SortState> = {
  applied_desc: { key: "applied", direction: "descending" }, applied_asc: { key: "applied", direction: "ascending" },
  company: { key: "company", direction: "ascending" }, status: { key: "status", direction: "ascending" }, updated: { key: "updated", direction: "descending" },
};
const chipLabels: Record<FilterKey, string> = { q: "Search", status: "Status", source: "Source", reconciliation: "Reconciliation", from: "Applied from", to: "Applied through", company: "Company", role: "Role" };
const chipValue = (key: FilterKey, value: string) => key === "status" || key === "source" || key === "reconciliation" ? humanize(value) : value;

type Changes = Partial<Record<string, string | null>>;

export function ApplicationsPage() {
  const [params, setParams] = useSearchParams();
  const { busy, error: actionError, revision, runAction } = useDashboard();
  const heading = useRef<HTMLHeadingElement>(null);
  const [adding, setAdding] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [customRange, setCustomRange] = useState(false);
  const view = readView(params);
  const { filters, sort, page, pageSize } = view;
  const appId = params.get("app") ?? "";
  const list = useApiResource<ApplicationListResponse>(`/applications?${buildApplicationsQuery(filters, { sort, page, pageSize })}`, revision, "Applications unavailable");

  // Updates are functional so a debounced search can never overwrite a filter changed in the meantime.
  function update(changes: Changes, options: { replace?: boolean; keepPage?: boolean } = {}) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
      if (!options.keepPage) next.delete("page");
      return next;
    }, { replace: options.replace });
  }
  const chips = filterKeys.filter((key) => filters[key]);
  const preset: DatePreset = customRange ? "custom" : presetOf(filters);
  function clearFilters() {
    setCustomRange(false);
    update(Object.fromEntries(filterKeys.map((key) => [key, null])));
  }
  function choosePreset(value: DatePreset) {
    setCustomRange(value === "custom");
    if (value !== "custom") update({ from: value === "any" ? null : daysAgo(Number(value)), to: null });
  }
  async function add(body: object) {
    setAttempted(true);
    if (await runAction("/applications", "POST", body)) setAdding(false);
  }

  const total = list.data?.total ?? 0;
  const empty = chips.length
    ? <EmptyState variant="filtered" title="No applications match these filters" description="Remove a filter or search for something broader." action={<Button onClick={clearFilters}>Clear all filters</Button>} />
    : <EmptyState title="No applications yet" description="Import a local Outlook export or connect the tracker, then run a sync. You can also add a reviewed application."
      action={<Link className="qe-button" data-variant="primary" to="/sources">Open Sources &amp; privacy</Link>} />;
  const columns: Column<ApplicationRecord>[] = [
    { key: "company", header: "Company / role", sortKey: "company", render: (row) => <span className="qe-two-line"><span className="qe-strong">{row.company}</span><span className="qe-text-muted">{row.role}</span></span> },
    { key: "applied", header: "Applied", sortKey: "applied", render: (row) => formatDate(row.applied_at) },
    { key: "status", header: "Status", sortKey: "status", render: (row) => <StatusBadge value={row.status} /> },
    { key: "source", header: "Source", render: (row) => humanize(row.source) },
    { key: "reconciliation", header: "Reconciliation", render: (row) => <StatusBadge value={row.reconciliation} /> },
    { key: "updated", header: "Updated", sortKey: "updated", render: (row) => formatDate(row.updated_at) },
  ];
  const sortKeyOf: Record<string, ApplicationSort> = { applied: sort === "applied_desc" ? "applied_asc" : "applied_desc", company: "company", status: "status", updated: "updated" };

  return <>
    <PageHeader title="Applications" description="Search, filter and review every application with its source evidence." headingRef={heading} actions={<>
      <Button variant="primary" onClick={() => { setAttempted(false); setAdding(true); }}>Add application</Button>
      <a className="qe-button" data-variant="secondary" data-size="default" href={exportUrl()}>Export CSV</a>
    </>} />
    <div className="qe-stack" data-gap="3">
      <form className="qe-toolbar" role="search" aria-label="Filter applications" onSubmit={(event) => event.preventDefault()}>
        <SearchInput label="Search company or role" value={filters.q} onChange={(value) => update({ q: value }, { replace: true })} />
        <Field label="Status">{(control) => <select {...control} className="qe-input" value={filters.status} onChange={(event) => update({ status: event.target.value })}><option value="">All statuses</option><StatusOptions /></select>}</Field>
        <Field label="Source">{(control) => <select {...control} className="qe-input" value={filters.source} onChange={(event) => update({ source: event.target.value })}><option value="">All sources</option>{sourceOptions.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select>}</Field>
        <Field label="Reconciliation">{(control) => <select {...control} className="qe-input" value={filters.reconciliation} onChange={(event) => update({ reconciliation: event.target.value })}><option value="">All states</option>{reconciliationOptions.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select>}</Field>
        <Field label="Applied date">{(control) => <select {...control} className="qe-input" value={preset} onChange={(event) => choosePreset(event.target.value as DatePreset)}>{datePresets.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>}</Field>
        {preset === "custom" && <>
          <Field label="Applied from">{(control) => <input {...control} className="qe-input" type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => update({ from: event.target.value })} />}</Field>
          <Field label="Applied through">{(control) => <input {...control} className="qe-input" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => update({ to: event.target.value })} />}</Field>
        </>}
        <Field label="Sort by">{(control) => <select {...control} className="qe-input" value={sort} onChange={(event) => update({ sort: event.target.value === "applied_desc" ? null : event.target.value })}>{applicationSorts.map((value) => <option key={value} value={value}>{sortLabels[value].option}</option>)}</select>}</Field>
      </form>
      {chips.length > 0 && <div className="qe-cluster" data-gap="2" role="group" aria-label="Active filters">
        {chips.map((key) => <FilterChip key={key} label={chipLabels[key]} value={chipValue(key, filters[key])} onRemove={() => update({ [key]: null })} />)}
        <Button variant="quiet" size="compact" onClick={clearFilters}>Clear all filters</Button>
      </div>}
    </div>
    <div className="qe-stack" data-gap="3">
      <p className="qe-result-line" aria-live="polite">{list.data ? `${plural(total, "application")} · Sorted by ${sortLabels[sort].summary}` : list.error ? "" : "Loading applications…"}</p>
      {list.error ? <ErrorAlert message={list.error} title="Applications could not be loaded" />
        : <DataTable caption="Applications" columns={columns} rows={list.data?.applications ?? []} rowKey={(row) => row.id} loading={!list.data} empty={empty} currentRowKey={appId || null}
          sort={sortStates[sort]} onSort={(key) => update({ sort: sortKeyOf[key] === "applied_desc" ? null : sortKeyOf[key] })}
          action={{ header: "Actions", render: (row) => <Button size="compact" aria-label={`View ${row.company} ${row.role}`} onClick={() => update({ app: row.id }, { keepPage: true })}>View</Button> }} />}
      {total > 0 && <Pagination page={page} pageSize={pageSize} total={total} pageSizes={[...pageSizes]} label="Applications pages"
        onPageChange={(next) => update({ page: next ? String(next) : null }, { keepPage: true })} onPageSizeChange={(size) => update({ pageSize: size === 25 ? null : String(size) })} />}
    </div>
    <ApplicationDrawer appId={appId} fallbackFocusRef={heading} onClose={() => update({ app: null }, { keepPage: true })} />
    <Drawer open={adding} title="Add application" onClose={() => setAdding(false)}>
      <div className="qe-stack" data-gap="4">
        {attempted && actionError && <ErrorAlert message={actionError} title="Not saved" />}
        <ApplicationForm busy={busy} submitLabel="Save application" onSubmit={add} />
      </div>
    </Drawer>
  </>;
}

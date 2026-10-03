import { useState } from "react";
import type { ApplicationListResponse, ApplicationRecord } from "@job-search/shared";
import { buildApplicationsQuery } from "../lib/applications";
import { formatDate } from "../lib/format";
import { useApiResource } from "../lib/use-api";
import { ErrorAlert } from "./ErrorAlert";
import { Field, SearchInput } from "./ui";

export interface ApplicationPickerProps { label: string; value: string; onChange: (id: string) => void; excludeId?: string; required?: boolean }

// Looks applications up on its own so the choice never depends on the list filters or the current page.
export function ApplicationPicker({ label, value, onChange, excludeId, required }: ApplicationPickerProps) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ApplicationRecord | null>(null);
  const { data, error, loading } = useApiResource<ApplicationListResponse>(`/applications?${buildApplicationsQuery({ q: query }, { pageSize: 25 })}`, 0, "Applications unavailable");
  const found = (data?.applications ?? []).filter((application) => application.id !== excludeId);
  const options = chosen?.id === value && !found.some((application) => application.id === value) ? [chosen, ...found] : found;
  return <div className="qe-stack" data-gap="3">
    <SearchInput label="Search applications" value={query} onChange={setQuery} placeholder="Company or role" />
    <Field label={label}>{(control) => <select {...control} className="qe-input" required={required} value={value}
      onChange={(event) => { setChosen(options.find((application) => application.id === event.target.value) ?? null); onChange(event.target.value); }}>
      <option value="">Choose application</option>
      {options.map((application) => <option key={application.id} value={application.id}>{application.company} · {application.role} · {formatDate(application.applied_at)}</option>)}
    </select>}</Field>
    {error ? <ErrorAlert message={error} />
      : <p className="qe-help" role="status">{loading ? "Searching…" : !options.length ? "No matches. Try a different company or role." : ""}</p>}
  </div>;
}

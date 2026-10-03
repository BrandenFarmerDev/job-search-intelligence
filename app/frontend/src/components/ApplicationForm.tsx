import type { ApplicationRecord } from "@job-search/shared";
import type { ApplicationBody } from "../lib/applications";
import { formatDate } from "../lib/format";
import { StatusOptions } from "./StatusOptions";
import { Button, Field } from "./ui";

export interface ApplicationFormProps { application?: ApplicationRecord; busy: boolean; submitLabel: string; onSubmit: (body: ApplicationBody) => void }

export function ApplicationForm({ application, busy, submitLabel, onSubmit }: ApplicationFormProps) {
  return <form className="qe-stack" data-gap="4" onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({ company: String(form.get("company")), role: String(form.get("role")), applied_at: String(form.get("date")), status: String(form.get("status")) });
  }}>
    <Field label="Company">{(control) => <input {...control} className="qe-input" name="company" required maxLength={200} defaultValue={application?.company} />}</Field>
    <Field label="Role">{(control) => <input {...control} className="qe-input" name="role" required maxLength={200} defaultValue={application?.role} />}</Field>
    <Field label="Applied date">{(control) => <input {...control} className="qe-input" name="date" type="date" required defaultValue={application ? formatDate(application.applied_at) : undefined} />}</Field>
    <Field label="Status">{(control) => <select {...control} className="qe-input" name="status" defaultValue={application?.status ?? "application_submitted"}><StatusOptions /></select>}</Field>
    <div className="qe-cluster"><Button type="submit" variant="primary" disabled={busy}>{submitLabel}</Button></div>
  </form>;
}

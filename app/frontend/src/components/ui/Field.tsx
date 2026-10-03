import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface FieldControlProps { id: string; "aria-describedby"?: string; "aria-invalid"?: true; required?: true }
export interface FieldProps {
  label: ReactNode; help?: ReactNode; error?: ReactNode; required?: boolean; className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

export function Field({ label, help, error, required, className, children }: FieldProps) {
  const id = useId(); const helpId = `${id}-help`; const errorId = `${id}-error`;
  const describedBy = [help && helpId, error && errorId].filter(Boolean).join(" ") || undefined;
  return <div className={cx("qe-field", className)}>
    <label className="qe-label" htmlFor={id}>{label}{required && <span className="qe-help"> (required)</span>}</label>
    {help && <div className="qe-help" id={helpId}>{help}</div>}
    {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required: required ? true : undefined })}
    {error && <div className="qe-error" id={errorId} role="alert">{error}</div>}
  </div>;
}

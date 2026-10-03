import type { ReactNode } from "react";

export interface KpiProps { label: string; value: ReactNode; unit?: string; context?: ReactNode; link?: ReactNode; tone?: "warning" }

// Group KPIs in a `.qe-kpi-strip` so they read as one summary rather than separate cards.
export function Kpi({ label, value, unit, context, link, tone }: KpiProps) {
  return <div className="qe-kpi" data-tone={tone}>
    <p className="qe-kpi-label">{label}</p>
    <p className="qe-kpi-value">{value}{unit && <span className="qe-kpi-unit">{unit}</span>}</p>
    {context && <p className="qe-kpi-context">{context}</p>}
    {link && <p className="qe-kpi-context">{link}</p>}
  </div>;
}

import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface PanelProps {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; headingLevel?: 2 | 3; flush?: boolean; className?: string; children: ReactNode;
}

export function Panel({ title, description, actions, headingLevel = 2, flush, className, children }: PanelProps) {
  const id = useId(); const Heading = `h${headingLevel}` as const;
  return <section className={cx("qe-panel", className)} aria-labelledby={id} data-flush={flush ? "true" : undefined}>
    <header className="qe-panel-header">
      <div><Heading className="qe-panel-title" id={id}>{title}</Heading>{description && <p className="qe-panel-description">{description}</p>}</div>
      {actions && <div className="qe-cluster">{actions}</div>}
    </header>
    <div className="qe-panel-body">{children}</div>
  </section>;
}

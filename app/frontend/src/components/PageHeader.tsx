import type { ReactNode, Ref } from "react";

export interface PageHeaderProps { title: string; description?: string; actions?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }

// The heading is focusable so the shell can move focus here after a route change.
export function PageHeader({ title, description, actions, headingRef }: PageHeaderProps) {
  return <header className="qe-page-header">
    <div className="qe-stack" data-gap="1">
      <h1 className="qe-page-title" ref={headingRef} tabIndex={-1}>{title}</h1>
      {description && <p className="qe-page-description">{description}</p>}
    </div>
    {actions && <div className="qe-cluster" role="group" aria-label="Page actions">{actions}</div>}
  </header>;
}

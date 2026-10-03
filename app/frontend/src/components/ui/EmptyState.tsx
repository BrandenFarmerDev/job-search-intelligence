import type { ReactNode } from "react";
import { FilterIcon, InboxIcon } from "./icons";

export interface EmptyStateProps { title: string; description?: ReactNode; action?: ReactNode; variant?: "dataset" | "filtered" }

// "dataset" means nothing exists yet; "filtered" means the current filters hide everything.
export function EmptyState({ title, description, action, variant = "dataset" }: EmptyStateProps) {
  const Icon = variant === "filtered" ? FilterIcon : InboxIcon;
  return <div className="qe-empty" data-variant={variant}>
    <Icon size="xl" />
    <p className="qe-empty-title">{title}</p>
    {description && <p className="qe-empty-description">{description}</p>}
    {action}
  </div>;
}

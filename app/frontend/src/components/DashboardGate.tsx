import type { ReactNode } from "react";
import type { Dashboard } from "@job-search/shared";
import { useDashboard } from "../lib/dashboard-context";
import { Button, EmptyState, Skeleton } from "./ui";

export interface DashboardGateProps { skeleton?: ReactNode; children: (dashboard: Dashboard) => ReactNode }

// Shows loading and unavailable states until the private dashboard has loaded once.
export function DashboardGate({ skeleton, children }: DashboardGateProps) {
  const { dashboard, loading, refresh } = useDashboard();
  if (dashboard) return <>{children(dashboard)}</>;
  if (loading) return <div className="qe-stack" data-gap="4" aria-busy="true"><p role="status" className="qe-visually-hidden">Loading private dashboard…</p>{skeleton ?? <Skeleton variant="block" />}</div>;
  return <EmptyState title="The private dashboard is unavailable" description="Your records have not been loaded. Sign in again if your session expired, then try again." action={<Button onClick={refresh}>Try again</Button>} />;
}

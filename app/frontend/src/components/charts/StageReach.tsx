import { BarChart } from "./BarChart";

export interface StageReachProps {
  total: number; responses: number; screenings: number; interviews: number; offers: number;
  title?: string; headingLevel?: 2 | 3 | 4;
}

// Each bar is a share of ALL applications. Stages are not sequential, so this is not a conversion funnel.
export function StageReach({ total, responses, screenings, interviews, offers, title = "Stage reach", headingLevel }: StageReachProps) {
  const stages = [["Applied", total], ["Responded", responses], ["Screening", screenings], ["Interview", interviews], ["Offer", offers]] as const;
  return <BarChart title={title} headingLevel={headingLevel} description="Share of all applications that reached each stage. Stages are counted independently, so a later stage can exceed an earlier one."
    items={total > 0 ? stages.map(([label, value]) => ({ label, value })) : []} max={total} showShare sorted={false} maxItems={stages.length} categoryHeader="Stage" emptyDescription="Stage reach appears after the first application is imported." />;
}

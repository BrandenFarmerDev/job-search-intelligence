import { useId, useState, type ReactNode } from "react";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl, type SegmentedOption } from "../ui/SegmentedControl";

type View = "chart" | "table";
const views: SegmentedOption<View>[] = [{ value: "chart", label: "Chart" }, { value: "table", label: "Table" }];
export interface ChartTable { columns: { header: string; numeric?: boolean }[]; rows: (string | number)[][] }
export interface ChartIds { titleId: string; summaryId: string }
export interface ChartFrameProps {
  title: string; description?: string;
  /** Plain-language reading of the chart for assistive technology; the table view holds every value. */
  summary: string; headingLevel?: 2 | 3 | 4; table: ChartTable; emptyDescription?: string;
  children: (ids: ChartIds) => ReactNode;
}

export function ChartFrame({ title, description, summary, headingLevel = 3, table, emptyDescription, children }: ChartFrameProps) {
  const id = useId(); const ids = { titleId: `${id}-title`, summaryId: `${id}-summary` };
  const [view, setView] = useState<View>("chart");
  const Heading = `h${headingLevel}` as const;
  const empty = table.rows.length === 0;
  return <section className="qe-chart" aria-labelledby={ids.titleId}>
    <header className="qe-chart-header">
      <div><Heading className="qe-chart-title" id={ids.titleId}>{title}</Heading>{description && <p className="qe-chart-description">{description}</p>}</div>
      {!empty && <SegmentedControl label={`${title} view`} options={views} value={view} onChange={setView} />}
    </header>
    <div className="qe-chart-body">
      {empty ? <EmptyState title="No data yet" description={emptyDescription} />
        : view === "table" ? <DataTable caption={`${title}: values`} density="compact" stickyHeader={false} rows={table.rows.map((cells, index) => ({ index, cells }))} rowKey={(row) => String(row.index)}
          columns={table.columns.map((column, position) => ({ key: String(position), header: column.header, align: column.numeric ? "end" as const : undefined, render: (row: { cells: (string | number)[] }) => row.cells[position] }))} />
        : <>{children(ids)}<p className="qe-visually-hidden" id={ids.summaryId}>{summary}</p></>}
    </div>
  </section>;
}

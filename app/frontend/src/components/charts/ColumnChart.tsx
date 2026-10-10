import { ChartFrame } from "./ChartFrame";
import { countOf, formatWeek, useChartWidth } from "./chart-utils";

export interface ColumnChartProps {
  title: string; description?: string; weeks: { weekStart: string; count: number }[];
  /** Singular noun for values, e.g. "application". */
  unit?: string; headingLevel?: 2 | 3 | 4; emptyDescription?: string;
}
const HEIGHT = 200; const TOP = 20; const PLOT = 150; const LEFT = 32; const LABEL_WIDTH = 46; const VALUE_SLOT = 20;

export function ColumnChart({ title, description, weeks, unit = "application", headingLevel, emptyDescription }: ColumnChartProps) {
  const [measure, width] = useChartWidth();
  const hasData = weeks.some((week) => week.count > 0);
  const peak = Math.max(1, ...weeks.map((week) => week.count));
  const slot = (width - LEFT) / Math.max(1, weeks.length);
  const column = Math.max(2, slot * 0.64);
  const every = Math.max(1, Math.ceil(LABEL_WIDTH / slot));
  const total = weeks.reduce((sum, week) => sum + week.count, 0);
  const wording = (week: { weekStart: string; count: number }) => `Week of ${formatWeek(week.weekStart)}: ${countOf(week.count, unit)}`;
  return <ChartFrame title={title} description={description} headingLevel={headingLevel} emptyDescription={emptyDescription}
    summary={`Column chart of ${countOf(total, unit)} over ${weeks.length} weeks; the busiest week had ${peak}. Choose Table for every week.`}
    table={{ columns: [{ header: "Week starting" }, { header: `${unit[0].toUpperCase()}${unit.slice(1)}s`, numeric: true }], rows: hasData ? weeks.map((week) => [week.weekStart, week.count]) : [] }}>
    {({ titleId, summaryId }) => <div ref={measure}>
      <svg className="qe-chart-svg" role="img" aria-labelledby={titleId} aria-describedby={summaryId} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}>
        <line className="qe-chart-grid" x1={LEFT} x2={width} y1={TOP} y2={TOP} />
        <line className="qe-chart-baseline" x1={LEFT} x2={width} y1={TOP + PLOT} y2={TOP + PLOT} />
        <text className="qe-chart-axis" x={LEFT - 8} y={TOP} textAnchor="end" dominantBaseline="central">{peak}</text>
        <text className="qe-chart-axis" x={LEFT - 8} y={TOP + PLOT} textAnchor="end" dominantBaseline="central">0</text>
        {weeks.map((week, index) => {
          const height = Math.max(week.count ? 2 : 1, (week.count / peak) * PLOT);
          const left = LEFT + index * slot + (slot - column) / 2;
          return <g key={week.weekStart} className="qe-bar" tabIndex={0}>
            <title>{wording(week)}</title>
            <rect className="qe-bar-fill qe-series-1" x={left} y={TOP + PLOT - height} width={column} height={height} rx={1} />
            {week.count > 0 && slot >= VALUE_SLOT && <text className="qe-chart-value" x={left + column / 2} y={TOP + PLOT - height - 8} textAnchor="middle">{week.count}</text>}
            {(weeks.length - 1 - index) % every === 0 && <text className="qe-chart-axis" x={left + column / 2} y={TOP + PLOT + 18} textAnchor="middle">{formatWeek(week.weekStart)}</text>}
          </g>;
        })}
      </svg>
    </div>}
  </ChartFrame>;
}

import { ChartFrame } from "./ChartFrame";
import { countOf, truncate, useChartWidth } from "./chart-utils";

export interface BarDatum { label: string; value: number }
export interface BarChartProps {
  title: string; description?: string; items: BarDatum[];
  /** Singular noun for values, e.g. "application". */
  unit?: string; series?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Categories beyond this many are summed into one "Other (n)" bar. */
  maxItems?: number;
  /** Value that fills a whole bar; defaults to the largest value. */
  max?: number;
  /** Show each value as a share of `max` and add that share to the table view. */
  showShare?: boolean; sorted?: boolean;
  categoryHeader?: string; headingLevel?: 2 | 3 | 4; emptyDescription?: string;
}
const ROW = 32; const BAR = 16; const GAP = 8; const CHAR = 7; const VALUE_CHAR = 8;

// A single leftover category is shown as itself; "Other" only replaces two or more.
const order = (items: BarDatum[], sorted: boolean): BarDatum[] => sorted ? [...items].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)) : items;
export function groupTopItems(items: BarDatum[], maxItems: number, sorted = true): (BarDatum & { merged?: number })[] {
  const ordered = order(items, sorted);
  if (ordered.length <= maxItems + 1) return ordered;
  const rest = ordered.slice(maxItems);
  return [...ordered.slice(0, maxItems), { label: `Other (${rest.length})`, value: rest.reduce((sum, item) => sum + item.value, 0), merged: rest.length }];
}

export function BarChart({ title, description, items, unit = "application", series = 1, maxItems = 8, max, showShare = false, sorted = true, categoryHeader = "Category", headingLevel, emptyDescription }: BarChartProps) {
  const [measure, width] = useChartWidth();
  const ordered = order(items, sorted);
  const bars = groupTopItems(ordered, maxItems, false);
  const scale = max ?? Math.max(1, ...bars.map((bar) => bar.value));
  const share = (value: number) => scale ? Math.round(value / scale * 100) : 0;
  const valueText = (value: number) => showShare ? `${value} · ${share(value)}%` : String(value);
  const labelWidth = Math.min(200, Math.max(96, Math.round(width * 0.38)));
  const valueWidth = Math.max(0, ...bars.map((bar) => valueText(bar.value).length)) * VALUE_CHAR + GAP;
  const barMax = Math.max(40, width - labelWidth - valueWidth - GAP);
  const leader = ordered.reduce((best, item) => item.value > best.value ? item : best, ordered[0] ?? { label: "", value: 0 });
  return <ChartFrame title={title} description={description} headingLevel={headingLevel} emptyDescription={emptyDescription}
    summary={`Horizontal bar chart of ${ordered.length} categories; the largest is ${leader.label} with ${countOf(leader.value, unit)}. Use View as table for every value.`}
    table={{ columns: [{ header: categoryHeader }, { header: `${unit[0].toUpperCase()}${unit.slice(1)}s`, numeric: true }, ...(showShare ? [{ header: "Share of all applications", numeric: true }] : [])],
      rows: ordered.map((item) => [item.label, item.value, ...(showShare ? [`${share(item.value)}%`] : [])]) }}>
    {({ titleId, summaryId }) => <div ref={measure}>
      <svg className="qe-chart-svg" role="img" aria-labelledby={titleId} aria-describedby={summaryId} width={width} height={bars.length * ROW} viewBox={`0 0 ${width} ${bars.length * ROW}`}>
        {bars.map((bar, index) => {
          const length = Math.max(bar.value > 0 ? 2 : 0, Math.round((scale ? Math.min(1, bar.value / scale) : 0) * barMax));
          const name = bar.merged ? `Other (${bar.merged} categories)` : bar.label;
          return <g key={index} className="qe-bar" tabIndex={0} transform={`translate(0 ${index * ROW})`}>
            <title>{`${name}: ${countOf(bar.value, unit)}${showShare ? `, ${share(bar.value)}% of all` : ""}`}</title>
            <text className="qe-chart-label" x={0} y={ROW / 2} dominantBaseline="central">{truncate(bar.label, Math.floor(labelWidth / CHAR))}</text>
            {showShare && <rect className="qe-chart-track" x={labelWidth} y={(ROW - BAR) / 2} width={barMax} height={BAR} rx={2} />}
            <rect className={`qe-bar-fill qe-series-${series}`} x={labelWidth} y={(ROW - BAR) / 2} width={length} height={BAR} rx={2} />
            <text className="qe-chart-value" x={labelWidth + length + GAP} y={ROW / 2} dominantBaseline="central">{valueText(bar.value)}</text>
          </g>;
        })}
      </svg>
    </div>}
  </ChartFrame>;
}

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, SortIcon } from "./icons";
import { Skeleton } from "./Skeleton";

export interface Column<T> {
  key: string; header: ReactNode; render: (row: T) => ReactNode;
  align?: "start" | "end" | "center"; sortKey?: string; truncate?: boolean;
}
export interface SortState { key: string; direction: "ascending" | "descending" }
export interface DataTableProps<T> {
  caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string;
  sort?: SortState | null; onSort?: (sortKey: string) => void;
  /** Row action column, always last. The header is read by assistive technology but not shown. */
  action?: { header: string; render: (row: T) => ReactNode };
  currentRowKey?: string | null; empty?: ReactNode; loading?: boolean; density?: "comfortable" | "compact"; stickyHeader?: boolean;
}
const LOADING_ROWS = 5;

function useOverflow() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOverflowing(node.scrollWidth > node.clientWidth));
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, overflowing] as const;
}

export function DataTable<T>({ caption, columns, rows, rowKey, sort, onSort, action, currentRowKey, empty, loading = false, density = "comfortable", stickyHeader = true }: DataTableProps<T>) {
  const [scrollRef, overflowing] = useOverflow();
  const span = columns.length + (action ? 1 : 0);
  return <>
    {/* A scrollable region must be keyboard focusable so its hidden columns are reachable. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    <div className="qe-table-scroll" ref={scrollRef} role="region" aria-label={`${caption} table`} tabIndex={0} data-sticky={stickyHeader}>
      <table className="qe-table" data-density={density} aria-busy={loading || undefined}>
        <caption className="qe-visually-hidden">{caption}</caption>
        <thead><tr>
          {columns.map((column) => <th key={column.key} scope="col" data-align={column.align} aria-sort={sort && column.sortKey === sort.key ? sort.direction : undefined}>
            {column.sortKey && onSort
              ? <button type="button" className="qe-sort" onClick={() => onSort(column.sortKey!)}>{column.header}{sort?.key !== column.sortKey ? <SortIcon /> : sort.direction === "ascending" ? <ArrowUpIcon /> : <ArrowDownIcon />}</button>
              : column.header}
          </th>)}
          {action && <th scope="col"><span className="qe-visually-hidden">{action.header}</span></th>}
        </tr></thead>
        <tbody>
          {loading ? Array.from({ length: LOADING_ROWS }, (_, row) => <tr key={row}>{Array.from({ length: span }, (_, cell) => <td key={cell}><Skeleton /></td>)}</tr>)
            : !rows.length ? <tr><td colSpan={span}>{empty ?? "No records to show."}</td></tr>
            : rows.map((row) => { const key = rowKey(row); return <tr key={key} aria-current={key === currentRowKey ? "true" : undefined}>
              {columns.map((column) => { const content = column.render(row); return <td key={column.key} data-align={column.align}>{column.truncate ? <span className="qe-cell-truncate" title={typeof content === "string" ? content : undefined}>{content}</span> : content}</td>; })}
              {action && <td data-align="end">{action.render(row)}</td>}
            </tr>; })}
        </tbody>
      </table>
    </div>
    {overflowing && <p className="qe-table-hint"><ChevronRightIcon />Scroll sideways to see more columns.</p>}
  </>;
}

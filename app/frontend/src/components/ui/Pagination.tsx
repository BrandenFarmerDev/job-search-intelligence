import { Button } from "./Button";
import { Field } from "./Field";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

export interface PaginationProps {
  /** Zero-based page index. */
  page: number; pageSize: number; total: number; onPageChange: (page: number) => void;
  pageSizes?: number[]; onPageSizeChange?: (size: number) => void; label?: string;
}

export function Pagination({ page, pageSize, total, onPageChange, pageSizes = [], onPageSizeChange, label = "Pagination" }: PaginationProps) {
  const first = total ? page * pageSize + 1 : 0;
  const last = Math.min(total, (page + 1) * pageSize);
  return <nav className="qe-pagination" aria-label={label}>
    <p className="qe-pagination-summary" aria-live="polite" aria-atomic="true">{total ? `${first}–${last} of ${total}` : "No results"}</p>
    <div className="qe-cluster">
      {onPageSizeChange && pageSizes.length > 0 && <Field label="Rows per page">{(control) => <select {...control} className="qe-input" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select>}</Field>}
      <Button size="compact" disabled={page <= 0} onClick={() => onPageChange(page - 1)}><ChevronLeftIcon />Previous</Button>
      <Button size="compact" disabled={last >= total} onClick={() => onPageChange(page + 1)}>Next<ChevronRightIcon /></Button>
    </div>
  </nav>;
}

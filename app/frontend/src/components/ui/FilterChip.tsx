import { CloseIcon } from "./icons";

export interface FilterChipProps { label: string; value: string; onRemove: () => void }

export function FilterChip({ label, value, onRemove }: FilterChipProps) {
  return <button type="button" className="qe-chip" aria-label={`Remove filter: ${label}: ${value}`} onClick={onRemove}><span>{label}: {value}</span><CloseIcon /></button>;
}

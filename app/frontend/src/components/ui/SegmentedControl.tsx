import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; /** Accessible name and tooltip; give one when the label is only an icon. */ name?: string }
export interface SegmentedControlProps<T extends string> { label: string; options: SegmentedOption<T>[]; value: T; onChange: (value: T) => void; iconOnly?: boolean; className?: string }

// Fixed labels with aria-pressed (never self-relabelling), so each segment keeps one stable name.
export function SegmentedControl<T extends string>({ label, options, value, onChange, iconOnly, className }: SegmentedControlProps<T>) {
  return <div className={cx("qe-segmented", className)} role="group" aria-label={label} data-icon-only={iconOnly || undefined}>
    {options.map((option) => <button key={option.value} type="button" className="qe-segment" aria-pressed={option.value === value} aria-label={option.name} title={option.name} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

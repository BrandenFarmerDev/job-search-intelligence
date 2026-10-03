import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem { id: string; label: ReactNode }
export interface TabsProps { label: string; tabs: TabItem[]; value: string; onChange: (id: string) => void; children: ReactNode }

// Automatic activation: arrow keys move focus and select, as in the ARIA tabs pattern.
export function Tabs({ label, tabs, value, onChange, children }: TabsProps) {
  const base = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const found = tabs.findIndex((tab) => tab.id === value);
  const current = Math.max(0, found);
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const moves: Record<string, number> = { ArrowRight: (current + 1) % tabs.length, ArrowLeft: (current - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
    if (!Object.hasOwn(moves, event.key)) return;
    const next = moves[event.key];
    event.preventDefault(); buttons.current[next]?.focus(); onChange(tabs[next].id);
  }
  return <div className="qe-tabs">
    <div className="qe-tablist" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => <button key={tab.id} ref={(node) => { buttons.current[index] = node; }} type="button" role="tab" className="qe-tab" id={`${base}-tab-${tab.id}`}
        aria-selected={index === current} aria-controls={index === current ? `${base}-panel` : undefined} tabIndex={index === current ? 0 : -1} onClick={() => onChange(tab.id)} onKeyDown={keyDown}>{tab.label}</button>)}
    </div>
    <div className="qe-tabpanel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tabs[current].id}`} tabIndex={0}>{children}</div>
  </div>;
}

import { useEffect, useState } from "react";

const MIN_WIDTH = 240;
// Charts draw at their real pixel width so SVG text stays at its CSS size instead of scaling with a viewBox.
export function useChartWidth(initial = 640) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(MIN_WIDTH, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width] as const;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const formatWeek = (isoDate: string): string => { const [, month, day] = isoDate.split("-"); return `${MONTHS[Number(month) - 1] ?? isoDate} ${Number(day)}`; };
export const countOf = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? "" : "s"}`;
export const truncate = (text: string, chars: number): string => text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;

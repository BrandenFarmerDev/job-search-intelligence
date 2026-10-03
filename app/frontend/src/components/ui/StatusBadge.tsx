import type { ComponentType } from "react";
import { AlertTriangleIcon, CheckCircleIcon, InfoIcon, MinusCircleIcon, type IconProps } from "./icons";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface StatusDescriptor { label: string; tone: Tone; Icon: ComponentType<IconProps> }
const icons = { neutral: MinusCircleIcon, info: InfoIcon, success: CheckCircleIcon, warning: AlertTriangleIcon, danger: AlertTriangleIcon } satisfies Record<Tone, ComponentType<IconProps>>;
export const humanize = (value: string): string => { const text = value.replaceAll("_", " ").trim(); return text ? text[0].toUpperCase() + text.slice(1) : "Unknown"; };

export function describeStatus(value: string): StatusDescriptor {
  const tone: Tone = /^(interview_|assessment_)/.test(value) || value === "screening" ? "info"
    : ["offer", "matched", "completed", "connected", "imported"].includes(value) ? "success"
    : value === "needs_review" || value === "conflict" ? "warning"
    : value === "failed" ? "danger" : "neutral";
  return { label: humanize(value), tone, Icon: icons[tone] };
}

// Status text is always visible; the icon and tone only reinforce it.
export function StatusBadge({ value }: { value: string }) {
  const { label, tone, Icon } = describeStatus(value);
  return <span className="qe-badge" data-tone={tone}><Icon />{label}</span>;
}

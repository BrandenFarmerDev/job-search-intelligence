import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, InfoIcon } from "./icons";

export interface AlertProps { tone?: "info" | "success" | "warning" | "danger"; title?: ReactNode; className?: string; children?: ReactNode }
const icons = { info: InfoIcon, success: CheckCircleIcon, warning: AlertTriangleIcon, danger: AlertCircleIcon };

// Warnings and errors interrupt assistive technology; information and success are announced politely.
export function Alert({ tone = "info", title, className, children }: AlertProps) {
  const Icon = icons[tone];
  return <div className={cx("qe-alert", className)} data-tone={tone} role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
    <Icon size="lg" />
    <div className="qe-alert-body">{title && <p className="qe-alert-title">{title}</p>}{children}</div>
  </div>;
}

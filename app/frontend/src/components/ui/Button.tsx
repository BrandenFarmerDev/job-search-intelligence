import type { ComponentProps } from "react";
import { cx } from "../../lib/cx";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: "primary" | "secondary" | "quiet" | "destructive";
  size?: "compact" | "default" | "large";
  loading?: boolean;
  iconOnly?: boolean;
}

// The label stays in the layout while loading so the button keeps its width.
export function Button({ variant = "secondary", size = "default", loading = false, iconOnly = false, disabled, type = "button", className, children, ...rest }: ButtonProps) {
  return <button {...rest} type={type} className={cx("qe-button", className)} data-variant={variant} data-size={size} data-icon-only={iconOnly || undefined} aria-busy={loading || undefined} disabled={disabled || loading}>
    <span className="qe-button-label">{children}</span>
    {loading && <span className="qe-spinner qe-button-spinner" aria-hidden="true" />}
  </button>;
}

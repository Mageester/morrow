import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "neutral" | "accent" | "success" | "warning" | "danger";
}

export function StatusPill({
  className,
  variant = "neutral",
  ...props
}: StatusPillProps) {
  return (
    <span
      aria-live="polite"
      className={clsx("morrow-status-pill", className)}
      data-variant={variant}
      role="status"
      {...props}
    />
  );
}

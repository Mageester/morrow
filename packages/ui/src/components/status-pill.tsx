import { clsx } from "clsx";
import type { ComponentPropsWithRef } from "react";

export interface StatusPillProps extends ComponentPropsWithRef<"span"> {
  variant?: "neutral" | "accent" | "success" | "warning" | "danger";
}

export function StatusPill({
  className,
  ref,
  variant = "neutral",
  ...props
}: StatusPillProps) {
  return (
    <span
      aria-live="polite"
      className={clsx("morrow-status-pill", className)}
      data-variant={variant}
      ref={ref}
      role="status"
      {...props}
    />
  );
}

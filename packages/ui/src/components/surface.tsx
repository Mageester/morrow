import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "small" | "medium" | "large";
  variant?: "default" | "subtle" | "raised";
}

export function Surface({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  padding = "medium",
  role,
  variant = "default",
  ...props
}: SurfaceProps) {
  return (
    <div
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={clsx("morrow-surface", className)}
      data-padding={padding}
      data-variant={variant}
      role={role ?? (ariaLabel || ariaLabelledBy ? "region" : undefined)}
      {...props}
    />
  );
}

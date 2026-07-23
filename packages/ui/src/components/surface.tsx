import { clsx } from "clsx";
import type { ComponentPropsWithRef } from "react";

export interface SurfaceProps extends ComponentPropsWithRef<"div"> {
  padding?: "none" | "small" | "medium" | "large";
  variant?: "default" | "subtle" | "raised";
}

export function Surface({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  padding = "medium",
  ref,
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
      ref={ref}
      role={role ?? (ariaLabel || ariaLabelledBy ? "region" : undefined)}
      {...props}
    />
  );
}

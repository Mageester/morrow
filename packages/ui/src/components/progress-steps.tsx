import { clsx } from "clsx";
import type { ComponentPropsWithRef } from "react";

export interface ProgressStep {
  id: string;
  label: string;
  status: "complete" | "current" | "upcoming";
}

export interface ProgressStepsProps extends ComponentPropsWithRef<"ol"> {
  label: string;
  steps: readonly ProgressStep[];
}

const statusLabels: Record<ProgressStep["status"], string> = {
  complete: "Complete",
  current: "Current",
  upcoming: "Upcoming",
};

export function ProgressSteps({
  className,
  label,
  ref,
  steps,
  ...props
}: ProgressStepsProps) {
  return (
    <ol
      aria-label={label}
      className={clsx("morrow-progress-steps", className)}
      ref={ref}
      {...props}
    >
      {steps.map((step) => (
        <li
          aria-current={step.status === "current" ? "step" : undefined}
          data-status={step.status}
          key={step.id}
        >
          <span aria-hidden="true" className="morrow-progress-steps__marker" />
          <span>{step.label}</span>
          <span className="morrow-sr-only"> — {statusLabels[step.status]}</span>
        </li>
      ))}
    </ol>
  );
}

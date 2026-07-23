import { clsx } from "clsx";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

import { Button } from "./button.js";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps
  extends Omit<ComponentPropsWithRef<"section">, "title"> {
  action?: EmptyStateAction;
  description: ReactNode;
  title: ReactNode;
}

export function EmptyState({
  action,
  className,
  description,
  ref,
  title,
  ...props
}: EmptyStateProps) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={clsx("morrow-empty-state", className)}
      ref={ref}
      {...props}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="morrow-empty-state__description">{description}</div>
      {action ? <Button onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}

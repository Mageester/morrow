import { clsx } from "clsx";
import { useId, type HTMLAttributes, type ReactNode } from "react";

import { Button } from "./button.js";

export interface ErrorCardAction {
  label: string;
  onClick: () => void;
}

export interface ErrorCardProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  attempted: readonly string[];
  explanation: ReactNode;
  preservedMessage?: ReactNode;
  recommendedAction: ErrorCardAction;
  title: ReactNode;
}

export function ErrorCard({
  attempted,
  className,
  explanation,
  preservedMessage = "Your work is preserved.",
  recommendedAction,
  title,
  ...props
}: ErrorCardProps) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={clsx("morrow-error-card", className)}
      role="alert"
      {...props}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="morrow-error-card__explanation">{explanation}</div>
      <p className="morrow-error-card__preserved">{preservedMessage}</p>
      {attempted.length > 0 ? (
        <div>
          <h3>Recovery attempted</h3>
          <ul>
            {attempted.map((attempt) => (
              <li key={attempt}>{attempt}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button onClick={recommendedAction.onClick} variant="primary">
        {recommendedAction.label}
      </Button>
    </section>
  );
}

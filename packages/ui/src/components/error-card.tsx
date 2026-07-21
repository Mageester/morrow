import { clsx } from "clsx";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

import { Button } from "./button.js";

export interface ErrorCardAction {
  label: string;
  onClick: () => void;
}

export interface ErrorCardProps
  extends Omit<ComponentPropsWithRef<"section">, "title"> {
  alternativeActions?: readonly ErrorCardAction[];
  attempted: readonly string[];
  continuation: ReactNode;
  explanation: ReactNode;
  preservedMessage?: ReactNode;
  recommendedAction: ErrorCardAction;
  title: ReactNode;
}

export function ErrorCard({
  alternativeActions = [],
  attempted,
  className,
  continuation,
  explanation,
  preservedMessage = "Your work is preserved.",
  recommendedAction,
  ref,
  title,
  ...props
}: ErrorCardProps) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={clsx("morrow-error-card", className)}
      ref={ref}
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
      <div className="morrow-error-card__continuation">
        <h3>What happens next</h3>
        <div>{continuation}</div>
      </div>
      <div className="morrow-error-card__actions">
        <Button onClick={recommendedAction.onClick} variant="primary">
          {recommendedAction.label}
        </Button>
        {alternativeActions.length > 0 ? (
          <div
            aria-label="Alternative actions"
            className="morrow-error-card__alternative-actions"
            role="group"
          >
            {alternativeActions.map((action) => (
              <Button
                key={action.label}
                onClick={action.onClick}
                variant="secondary"
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

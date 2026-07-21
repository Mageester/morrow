import { clsx } from "clsx";
import { useId, type HTMLAttributes, type ReactNode } from "react";

export interface ArtifactFrameProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  children: ReactNode;
  metadata?: ReactNode;
  title: ReactNode;
}

export function ArtifactFrame({
  actions,
  children,
  className,
  metadata,
  title,
  ...props
}: ArtifactFrameProps) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={clsx("morrow-artifact-frame", className)}
      {...props}
    >
      <header className="morrow-artifact-frame__header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {metadata ? (
            <div className="morrow-artifact-frame__metadata">{metadata}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="morrow-artifact-frame__actions">{actions}</div>
        ) : null}
      </header>
      <div className="morrow-artifact-frame__content">{children}</div>
    </section>
  );
}

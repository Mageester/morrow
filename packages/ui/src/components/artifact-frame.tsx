import { clsx } from "clsx";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

export interface ArtifactFrameProps
  extends Omit<ComponentPropsWithRef<"section">, "title"> {
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
  ref,
  title,
  ...props
}: ArtifactFrameProps) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={clsx("morrow-artifact-frame", className)}
      ref={ref}
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

import { clsx } from "clsx";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

export interface ArtifactFrameProps
  extends Omit<ComponentPropsWithRef<"section">, "title"> {
  actions?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  metadata?: ReactNode;
  title: ReactNode;
}

export function ArtifactFrame({
  actions,
  children,
  className,
  headingLevel = 2,
  metadata,
  ref,
  title,
  ...props
}: ArtifactFrameProps) {
  const titleId = useId();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6";

  return (
    <section
      aria-labelledby={titleId}
      className={clsx("morrow-artifact-frame", className)}
      ref={ref}
      {...props}
    >
      <header className="morrow-artifact-frame__header">
        <div>
          <Heading id={titleId}>{title}</Heading>
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

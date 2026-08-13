import type { ReactNode } from "react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function AmbientMark({ variant = "orb" }: { variant?: "orb" | "arc" }) {
  return (
    <span
      aria-hidden="true"
      className="morrow-product-mark"
      data-variant={variant}
    >
      <span />
    </span>
  );
}

export function ProductHeader({
  action,
  description,
  eyebrow,
  status,
  title,
}: {
  action?: ReactNode;
  description?: string;
  eyebrow?: string;
  status?: ReactNode;
  title: string;
}) {
  return (
    <header className="morrow-product-header">
      <div className="morrow-product-header__copy">
        {eyebrow ? <p className="morrow-product-eyebrow">{eyebrow}</p> : null}
        <div className="morrow-product-header__title-line">
          <h1>{title}</h1>
          {status ? <div className="morrow-product-header__status">{status}</div> : null}
        </div>
        {description ? <p className="morrow-product-header__description">{description}</p> : null}
      </div>
      {action ? <div className="morrow-product-header__action">{action}</div> : null}
    </header>
  );
}

export function SectionFrame({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className={classes("morrow-product-section", className)}
    >
      {children}
    </section>
  );
}

export function StateScene({
  action,
  children,
  description,
  title,
  tone = "quiet",
}: {
  action?: ReactNode;
  children?: ReactNode;
  description: string;
  title: string;
  tone?: "quiet" | "error" | "success";
}) {
  return (
    <section className="morrow-product-state" data-tone={tone}>
      <AmbientMark variant={tone === "quiet" ? "arc" : "orb"} />
      <div className="morrow-product-state__copy">
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
      </div>
      {action ? <div className="morrow-product-state__action">{action}</div> : null}
    </section>
  );
}

import { clsx } from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

export interface TimelineItem {
  description?: ReactNode;
  id: string;
  timeLabel?: string;
  timestamp?: string;
  title: ReactNode;
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  items: readonly TimelineItem[];
  label: string;
}

export function Timeline({
  className,
  items,
  label,
  ...props
}: TimelineProps) {
  return (
    <ol
      aria-label={label}
      className={clsx("morrow-timeline", className)}
      {...props}
    >
      {items.map((item) => (
        <li key={item.id}>
          <div className="morrow-timeline__heading">
            <strong>{item.title}</strong>
            {item.timestamp && item.timeLabel ? (
              <time dateTime={item.timestamp}>{item.timeLabel}</time>
            ) : null}
          </div>
          {item.description ? (
            <div className="morrow-timeline__description">
              {item.description}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

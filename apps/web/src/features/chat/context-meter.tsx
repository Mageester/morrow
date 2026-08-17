import { useQuery } from "@tanstack/react-query";
import { contextUsageQueries } from "../../api/context-usage.js";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export type UsageTone = "normal" | "warning" | "critical";

export function usageTone(ratio: number): UsageTone {
  return ratio >= 0.9 ? "critical" : ratio >= 0.75 ? "warning" : "normal";
}

/**
 * Pure ring markup, shared by the composer's quiet glance-only meter and the
 * capability status trigger — one SVG so the two never draw the ratio
 * differently. `ratio` is pre-clamped to [0, 1] by the caller.
 *
 * Tone/estimated styling is applied via CSS attribute selectors scoped to
 * `.morrow-context-meter[data-tone=…]` — callers that reuse this ring outside
 * that wrapper class carry the same `data-tone`/`data-estimated` attributes
 * on their own outer element for the styling to apply.
 */
export function UsageRing({ ratio }: { ratio: number }) {
  return (
    <svg aria-hidden="true" height="18" viewBox="0 0 18 18" width="18">
      <circle className="morrow-context-meter__track" cx="9" cy="9" r={RADIUS} />
      <circle
        className="morrow-context-meter__fill"
        cx="9"
        cy="9"
        r={RADIUS}
        strokeDasharray={`${ratio * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        // Start the arc at 12 o'clock so it reads as a gauge, not a spinner.
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

export interface ContextMeterProps {
  /** The most recent task in this conversation, or undefined before the first
   * turn — there is no usage to report until a request has been made. */
  taskId?: string | undefined;
}

/**
 * A compact ring showing how much of the model's context window the last turn
 * used.
 *
 * Renders nothing at all rather than guessing. The orchestrator returns null
 * token counts when a provider did not report usage, and many gateway models
 * (every OpenCode Zen model on this install, for instance) advertise a null
 * context window — so "0%" would frequently be fiction. An absent meter is
 * honest; a full-looking one that is actually unknown is not.
 */
export function ContextMeter({ taskId }: ContextMeterProps) {
  const usage = useQuery({ ...contextUsageQueries.forTask(taskId ?? ""), enabled: Boolean(taskId) });

  const capacity = usage.data?.contextWindowTokens ?? null;
  const used = usage.data?.currentRequestTokens ?? null;
  if (!taskId || !capacity || capacity <= 0 || used == null || used < 0) return null;

  const ratio = Math.min(used / capacity, 1);
  const percent = Math.round(ratio * 100);
  // "estimated" is the orchestrator's own word for a count it derived rather
  // than received; carry that distinction through instead of flattening it.
  const estimated = usage.data?.exact === false;
  const label = `${percent}% of context used — ${formatTokens(used)} of ${formatTokens(capacity)} tokens${estimated ? ", estimated" : ""}`;
  const tone = usageTone(ratio);

  return (
    <span
      className="morrow-context-meter"
      data-estimated={estimated ? "true" : undefined}
      data-tone={tone}
      title={label}
    >
      <UsageRing ratio={ratio} />
      <span className="morrow-visually-hidden">{label}</span>
    </span>
  );
}

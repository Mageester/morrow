/**
 * Formatting shared across command handlers.
 *
 * Kept here rather than in the surface because these are content decisions, not
 * presentation ones: whether a duration reads as "2m 14s" is the same answer for
 * the Ink shell, a piped run, and a test assertion.
 */

export function formatTokens(count: number | null | undefined): string {
  if (count == null) return "—";
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "3 minutes ago" — for lists of sessions, tasks and checkpoints. */
export function relativeTime(iso: string | number | Date | null | undefined): string {
  if (iso == null) return "—";
  const then = iso instanceof Date ? iso.getTime() : typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = Date.now() - then;
  if (delta < 0) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Shorten an id for display without making two different ids look the same. */
export function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8);
}

/** Collapse a long list into "a, b, c and 4 more". */
export function summarizeList(items: readonly string[], keep = 3): string {
  if (items.length === 0) return "none";
  if (items.length <= keep) return items.join(", ");
  return `${items.slice(0, keep).join(", ")} and ${items.length - keep} more`;
}

/** Percent, or null when the denominator is unknown or nothing is used yet. */
export function percent(used: number | null | undefined, total: number | null | undefined): string | null {
  if (used == null || total == null || total <= 0 || used <= 0) return null;
  const ratio = Math.min(1, used / total);
  return ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`;
}

/** A message for an error that reached the user, never a raw stack. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}

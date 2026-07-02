/**
 * Provider rate-limit guard.
 *
 * Tracks rate-limit signals (HTTP 429 / provider "rate_limit" errors) per
 * provider and answers "should we even try this provider right now?". The
 * fallback opener consults it to deprioritize providers that are cooling
 * down, so a burst of retries doesn't hammer an already-throttled endpoint
 * while a healthy fallback candidate exists.
 *
 * Semantics (deliberate):
 * - Advisory, never blocking: a rate-limited provider is *deprioritized*, not
 *   forbidden. If it is the only candidate, it is still tried — refusing work
 *   outright would be worse than a second 429.
 * - `Retry-After` wins when the provider supplied one; otherwise cooldown
 *   grows exponentially with consecutive hits (base 2s, doubling, capped at
 *   5 minutes) and resets on the first success.
 * - Pure in-memory state with an injectable clock so tests are deterministic.
 *   Rate-limit state is transient by nature; persisting it would only revive
 *   stale cooldowns after a restart.
 */

const BASE_COOLDOWN_MS = 2_000;
const MAX_COOLDOWN_MS = 300_000;

interface GuardEntry {
  limitedUntil: number;
  consecutive: number;
  lastRetryAfterMs?: number;
}

export interface RateGuardStatus {
  providerId: string;
  limited: boolean;
  /** Milliseconds until the cooldown expires (0 when not limited). */
  remainingMs: number;
  /** Consecutive rate-limit hits without an intervening success. */
  consecutive: number;
}

export class RateGuard {
  private readonly entries = new Map<string, GuardEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Record a rate-limit hit. `retryAfterMs` (from a Retry-After header) wins over backoff. */
  reportRateLimit(providerId: string, retryAfterMs?: number): void {
    const prev = this.entries.get(providerId);
    const consecutive = (prev?.consecutive ?? 0) + 1;
    const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (consecutive - 1), MAX_COOLDOWN_MS);
    const cooldown =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, MAX_COOLDOWN_MS)
        : backoff;
    this.entries.set(providerId, {
      limitedUntil: this.now() + cooldown,
      consecutive,
      ...(retryAfterMs !== undefined ? { lastRetryAfterMs: retryAfterMs } : {}),
    });
  }

  /** Record a successful stream open; clears the provider's cooldown and streak. */
  reportSuccess(providerId: string): void {
    this.entries.delete(providerId);
  }

  isLimited(providerId: string): boolean {
    return this.remainingMs(providerId) > 0;
  }

  /** Milliseconds until this provider's cooldown expires (0 when not limited). */
  remainingMs(providerId: string): number {
    const entry = this.entries.get(providerId);
    if (!entry) return 0;
    return Math.max(0, entry.limitedUntil - this.now());
  }

  /** Observability snapshot for every provider the guard has seen. */
  snapshot(): RateGuardStatus[] {
    const out: RateGuardStatus[] = [];
    for (const [providerId, entry] of this.entries) {
      const remainingMs = Math.max(0, entry.limitedUntil - this.now());
      out.push({ providerId, limited: remainingMs > 0, remainingMs, consecutive: entry.consecutive });
    }
    return out;
  }
}

/**
 * Shared process-wide guard. Provider throttling is a per-process, per-endpoint
 * concern, so one instance serves every task in this orchestrator.
 */
export const globalRateGuard = new RateGuard();

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 * Supports delta-seconds and HTTP-date forms; returns undefined when unusable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds >= 0 ? seconds * 1000 : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - nowMs;
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/**
 * Single ownership boundary for "have we already processed this source
 * event." Every consumer of raw orchestrator `TaskEvent`s — the interactive
 * session's live-subscribe loop and the `/output full` report builder alike
 * — routes through this module instead of maintaining its own identity
 * tracking, so there is exactly one definition of event identity and one
 * place a reconnect/replay/history-overlap bug could hide.
 *
 * Identity is the persisted event id when present (stable across history
 * load, SSE replay, and reconnect — the orchestrator assigns it once at
 * `appendEvent` time and never regenerates it), falling back to
 * `type:sequence` only for the rare pre-identity record.
 */

export interface IdentifiableEvent {
  id?: string;
  type: string;
  sequence?: number;
}

export function eventIdentity(event: IdentifiableEvent): string {
  return typeof event.id === "string" && event.id ? event.id : `${event.type}:${event.sequence ?? "?"}`;
}

/** Filter a batch of raw events to first-occurrence-only, preserving order. */
export function dedupeRawEvents<T extends IdentifiableEvent>(events: T[]): T[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const id = eventIdentity(event);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Stateful idempotency gate for a streaming consumer (persisted history
 * followed by live replay, or a reconnect that resumes from a cursor that
 * may legitimately overlap what was already seen). `ingest` returns `true`
 * exactly once per distinct source event id, in the order first seen.
 */
export class EventLedger {
  private readonly seen = new Set<string>();

  has(event: IdentifiableEvent): boolean {
    return this.seen.has(eventIdentity(event));
  }

  /** Returns true if this is the first time this event id has been ingested. */
  ingest(event: IdentifiableEvent): boolean {
    const id = eventIdentity(event);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

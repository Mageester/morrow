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
 * `appendEvent` time and never regenerates it, and is unique across every
 * task, so it is never scoped by task), falling back to `type:sequence` only
 * for the rare pre-identity record. The fallback is scoped by task identity
 * (`taskScope`) when the caller provides one: `task-records.ts` computes
 * sequence numbers per task (`WHERE task_id = ?`), so an id-less event's
 * `type:sequence` pair is only unique *within* a task — a second, distinct
 * task can legitimately reuse the same pair (e.g. both tasks' first turn is
 * `assistant.turn_started:1`), and without task scoping the second task's
 * event would be silently dropped as if it were a replay of the first.
 */

export interface IdentifiableEvent {
  id?: string;
  type: string;
  sequence?: number;
}

export function eventIdentity(event: IdentifiableEvent, taskScope?: string): string {
  if (typeof event.id === "string" && event.id) return event.id;
  const fallback = `${event.type}:${event.sequence ?? "?"}`;
  return taskScope !== undefined ? `${taskScope}:${fallback}` : fallback;
}

/** Filter a batch of raw events to first-occurrence-only, preserving order.
 *  Callers pass events for a single task (e.g. one task's persisted
 *  aggregate), so no task scope is needed here — the fallback identity is
 *  already unambiguous within that one task's event list. */
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
 *
 * One ledger instance spans the whole interactive session — multiple tasks
 * in sequence (a new prompt after a prior task finished) share it, as does
 * `/continue` resuming the same task. Pass `taskScope` (the current task id)
 * on every call so the id-less fallback identity is scoped correctly: it
 * stays stable across a `/continue` of the *same* task (same scope, so a
 * resent id-less event is still recognized as already seen) while never
 * colliding with a *different* task's id-less events (different scope).
 * Persisted event ids ignore `taskScope` entirely and stay deduped across
 * the whole session, since they are already globally unique.
 */
export class EventLedger {
  private readonly seen = new Set<string>();

  has(event: IdentifiableEvent, taskScope?: string): boolean {
    return this.seen.has(eventIdentity(event, taskScope));
  }

  /** Returns true if this is the first time this event id has been ingested. */
  ingest(event: IdentifiableEvent, taskScope?: string): boolean {
    const id = eventIdentity(event, taskScope);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

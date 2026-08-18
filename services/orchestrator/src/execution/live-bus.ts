import { EventEmitter } from "node:events";

/**
 * The ephemeral event bus: what a watching client sees, but nothing remembers.
 *
 * Every other task event goes through `records.appendEvent`, which writes it to
 * `task_events` and is then polled by the SSE route. That is the right design
 * for anything a session must be able to replay — and the wrong one for a
 * model's chain of thought, which Morrow deliberately does not store.
 *
 * Reasoning text arrives from the provider as `providerContinuation.
 * reasoningContent`, carrying an explicit rule: persist it only in the
 * restricted continuation store, never as a task event. That rule stands. This
 * bus is how the same text can still be shown *while it is happening* without
 * ever reaching the database: it is held only in memory, only for as long as a
 * client is attached, and it is dropped the moment the turn ends.
 *
 * The consequences are deliberate and worth stating, because they are the price
 * of not storing it:
 *
 *   - Reasoning is not replayable. Reconnecting mid-turn resumes the persisted
 *     stream and silently misses whatever thinking happened while detached.
 *   - `/output`, `/export` and the task report contain no reasoning, because
 *     there is none to contain.
 *   - A second client attaching sees reasoning only from the moment it attaches.
 *
 * Ephemeral frames carry no sequence number. The client must yield them without
 * advancing its resume cursor, or a reconnect would try to replay something
 * that was never written.
 */

export interface EphemeralEvent {
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Bounded so a pathological turn cannot pin memory through a slow consumer. */
const MAX_LISTENERS_PER_TASK = 32;

class LiveBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    // One emitter for every task; the default cap of 10 is a per-event-name
    // cap, and a task with several watchers is normal, not a leak.
    this.#emitter.setMaxListeners(MAX_LISTENERS_PER_TASK);
  }

  publish(event: EphemeralEvent): void {
    // No listeners is the common case (nobody is watching this task), and it
    // must stay free — this is called once per reasoning token.
    if (this.#emitter.listenerCount(event.taskId) === 0) return;
    this.#emitter.emit(event.taskId, event);
  }

  subscribe(taskId: string, listener: (event: EphemeralEvent) => void): () => void {
    this.#emitter.on(taskId, listener);
    return () => {
      this.#emitter.off(taskId, listener);
    };
  }

  /** Listener count for a task. Exposed for tests and diagnostics. */
  watchers(taskId: string): number {
    return this.#emitter.listenerCount(taskId);
  }
}

/**
 * Process-wide instance.
 *
 * A singleton because the agent loop and the HTTP route are in the same
 * process and neither is constructed by the other. If Morrow ever runs the
 * agent out-of-process this becomes a real transport, and the shape above is
 * what it would have to implement.
 */
export const liveBus = new LiveBus();

/** The one ephemeral event type that exists today. */
export const REASONING_DELTA = "assistant.reasoning_delta";

export function publishReasoningDelta(taskId: string, text: string): void {
  if (!text) return;
  liveBus.publish({ taskId, type: REASONING_DELTA, payload: { text } });
}

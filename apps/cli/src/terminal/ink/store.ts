import { initialState, reduce, type TerminalState } from "../state.js";
import type { TerminalEvent } from "../events.js";

/**
 * The bridge between the terminal event core and the Ink view layer.
 *
 * The event model, the reducer, and `TerminalState` are the part of the old
 * terminal runtime worth keeping: producers emit `TerminalEvent`s and never
 * format output, and `reduce` is pure. That contract is what makes a different
 * renderer possible at all, so this store changes none of it — it holds the
 * reduced state and lets React subscribe to it.
 *
 * Deliberately not React state, and deliberately not a context: events arrive
 * from SSE and command producers outside the React tree, at rates far above
 * frame rate. The store absorbs them synchronously and notifies subscribers,
 * which lets the view coalesce renders instead of one render per token.
 */
export type Unsubscribe = () => void;

export class TerminalStore {
  #state: TerminalState = initialState();
  #listeners = new Set<() => void>();
  /** Bumped on every applied event, so `useSyncExternalStore` sees a change
   * even when a reduction returns a structurally equal object. */
  #version = 0;

  get state(): TerminalState {
    return this.#state;
  }

  getVersion = (): number => this.#version;

  apply(event: TerminalEvent, now: () => number = Date.now): void {
    const next = reduce(this.#state, event, now);
    if (next === this.#state) return;
    this.#state = next;
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

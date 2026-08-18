import type { ApprovalView } from "../session.js";

/**
 * The pending approval, held outside the reducer.
 *
 * `approval.requested` is deliberately not a `TerminalEvent` — it is an input
 * the shell must answer, not an observation to fold into state, and the event
 * adapter says so explicitly. Keeping it out of `TerminalState` preserves that
 * boundary: the reducer still describes only what happened.
 *
 * It gets its own tiny store rather than React state in the shell driver so the
 * runtime loop can raise one from outside the React tree, exactly as the
 * terminal store does for events.
 */
export class ApprovalStore {
  #pending: ApprovalView | null = null;
  #listeners = new Set<() => void>();
  #version = 0;

  get pending(): ApprovalView | null {
    return this.#pending;
  }

  getVersion = (): number => this.#version;

  set(approval: ApprovalView | null): void {
    this.#pending = approval;
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

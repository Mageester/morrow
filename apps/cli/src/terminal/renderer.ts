/**
 * The renderer contract. Two implementations consume the same events and the
 * same reducer/views: `LineRenderer` (non-interactive, append-only) and
 * `InteractiveRenderer` (bounded-FPS frame renderer). A renderer owns ALL
 * visible output for its mode; producers only emit events.
 */
import type { TerminalEvent } from "./events.js";

export interface Renderer {
  /** Fold an event into state and surface whatever the mode shows for it. */
  apply(event: TerminalEvent): void;
  /** Flush/teardown. Idempotent. Returns the final plain-text answer (if any). */
  end(): string;
}

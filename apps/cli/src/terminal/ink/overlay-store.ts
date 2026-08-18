import type { ModelPickerItem } from "../model-picker.js";

/**
 * The active full-surface overlay, held outside the reducer.
 *
 * An overlay is an input the shell must answer — the same category as a pending
 * approval, and deliberately not a `TerminalEvent`. Folding "a picker is open"
 * into `TerminalState` would make the reducer describe intent rather than what
 * happened, which is the boundary `ApprovalStore` already protects.
 *
 * It lives in its own store rather than React state so a command handler
 * running outside the React tree can raise one, exactly as the runtime loop
 * raises an approval.
 */

/** A model picker awaiting a choice. `onChoose` receives null on cancel. */
export interface ModelOverlay {
  kind: "model";
  items: ModelPickerItem[];
  /** The id currently in effect, so the list can mark it. */
  currentId: string | undefined;
  onChoose: (item: ModelPickerItem | null) => void;
}

export interface SelectItem {
  id: string;
  label: string;
  /** Dimmed trailing detail — an id, a timestamp, a reason. */
  hint?: string;
  /** Marks the row that is already in effect. */
  current?: boolean;
  /** Rows that cannot be chosen still appear, with the reason why. */
  disabled?: boolean;
}

/**
 * A generic filterable list.
 *
 * One overlay type serves every "pick one of these" moment — sessions,
 * providers, presets, checkpoints, worktrees — because the alternative is a
 * bespoke picker per command, which is how the previous shell ended up with
 * exactly one working picker and a dozen commands that printed a list and told
 * you to retype the id.
 */
export interface SelectOverlay {
  kind: "select";
  title: string;
  subtitle?: string;
  items: SelectItem[];
  onChoose: (id: string | null) => void;
}

export type Overlay = ModelOverlay | SelectOverlay;

/** The value an overlay answers with. */
export type OverlayChoice = ModelPickerItem | string | null;

export class OverlayStore {
  #active: Overlay | null = null;
  #listeners = new Set<() => void>();
  #version = 0;

  get active(): Overlay | null {
    return this.#active;
  }

  getVersion = (): number => this.#version;

  set(overlay: Overlay | null): void {
    this.#active = overlay;
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  /** Closes the overlay and answers it, so a caller awaiting a choice can
   *  never be left hanging when the surface is dismissed. */
  close(choice: OverlayChoice): void {
    const current = this.#active;
    this.set(null);
    if (!current) return;
    if (current.kind === "model") {
      current.onChoose(typeof choice === "string" || choice === null ? null : choice);
      return;
    }
    current.onChoose(typeof choice === "string" ? choice : null);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

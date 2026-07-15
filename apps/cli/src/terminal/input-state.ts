/**
 * The input editor as a pure state machine.
 *
 * All keystroke handling for the interactive session lives here so it is fully
 * unit-testable without a TTY: `reduceKey(state, key, ctx)` returns the next
 * `InputState` and an `InputAction` for the controller to act on (submit a line,
 * exit, cancel/interrupt, repaint, clear the screen). The controller owns side
 * effects; this module owns behavior.
 */
import type { SlashCommand } from "./commands.js";
import { clampSelection, completionCandidates } from "./completion.js";
import { fuzzyPalette, type PaletteItem } from "./palette.js";
import { filterModelItems, type ModelPickerItem } from "./model-picker.js";

export type Overlay = "none" | "palette" | "output" | "history" | "tasktree" | "mission" | "model";

export interface InputState {
  buffer: string;
  cursor: number;
  /** Submitted lines, oldest→newest, for ↑/↓ recall. */
  history: string[];
  /** -1 means "editing a fresh line"; otherwise an index into history. */
  historyIndex: number;
  /** Saved in-progress buffer while recalling history. */
  draft: string;
  overlay: Overlay;
  completionSelected: number;
  completionDismissed: boolean;
  paletteQuery: string;
  paletteSelected: number;
  /** Search text typed inside the /model picker overlay. */
  modelQuery: string;
  /** Selection index into the picker's currently *filtered* item list. */
  modelSelected: number;
  /** True once Ctrl+C was pressed on an empty idle line (press again to exit). */
  confirmExit: boolean;
}

export interface KeyInput {
  str?: string | undefined;
  name?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  shift?: boolean | undefined;
}

export type InputAction =
  | { type: "none" }
  | { type: "repaint" }
  | { type: "submit"; value: string }
  | { type: "clear-screen" }
  | { type: "exit" }
  | { type: "interrupt" };

export interface KeyContext {
  commands: SlashCommand[];
  paletteItems: PaletteItem[];
  /** Items the /model picker overlay is currently showing. Mutated in place
   *  by the session controller when the picker opens or its data refreshes
   *  (never rebuilt per keystroke — filtering/navigation stays pure here).
   *  Optional/defaults to empty so callers that never open the picker (most
   *  existing test fixtures) don't need to know about it. */
  modelItems?: ModelPickerItem[];
}

export function initialInputState(history: string[] = []): InputState {
  return {
    buffer: "",
    cursor: 0,
    history,
    historyIndex: -1,
    draft: "",
    overlay: "none",
    completionSelected: 0,
    completionDismissed: false,
    paletteQuery: "",
    paletteSelected: 0,
    modelQuery: "",
    modelSelected: 0,
    confirmExit: false,
  };
}

/** Whether the slash-completion menu is currently active. */
export function completionActive(s: InputState): boolean {
  return s.overlay === "none" && s.buffer.startsWith("/") && /^\/\S*(?:\s+\S*)?$/.test(s.buffer) && !s.completionDismissed;
}

export function completionMatches(s: InputState, ctx: KeyContext): SlashCommand[] {
  return completionActive(s) ? completionCandidates(s.buffer, ctx.commands) : [];
}

export function paletteMatches(s: InputState, ctx: KeyContext): PaletteItem[] {
  return s.overlay === "palette" ? fuzzyPalette(s.paletteQuery, ctx.paletteItems) : [];
}

/** The /model picker's currently filtered, selectable rows (including any
 *  synthetic "auto"/custom-id rows) — the single computation the reducer,
 *  the renderer, and the acceptance tests all share. */
export function modelPickerMatches(s: InputState, ctx: KeyContext): ModelPickerItem[] {
  return s.overlay === "model" ? filterModelItems(s.modelQuery, ctx.modelItems ?? []) : [];
}

const r = (state: InputState, action: InputAction = { type: "repaint" }): { state: InputState; action: InputAction } => ({ state, action });

/** Fold one keypress into the next state + an action for the controller. */
export function reduceKey(state: InputState, key: KeyInput, ctx: KeyContext): { state: InputState; action: InputAction } {
  const s: InputState = { ...state };
  const name = key.name;

  // Any key other than Ctrl+C cancels a pending exit confirmation.
  if (!(key.ctrl && name === "c")) s.confirmExit = false;

  // ── Control chords ────────────────────────────────────────────────────────
  if (key.ctrl && name === "c") return handleInterrupt(s);
  if (key.ctrl && name === "l") return r(s, { type: "clear-screen" });
  if (key.ctrl && name === "k") {
    s.overlay = s.overlay === "palette" ? "none" : "palette";
    s.paletteQuery = "";
    s.paletteSelected = 0;
    return r(s);
  }
  if (key.ctrl && name === "r") {
    // Ctrl+R: toggle history search overlay
    s.overlay = s.overlay === "history" ? "none" : "history";
    s.paletteQuery = "";
    s.paletteSelected = 0;
    return r(s);
  }
  if (key.ctrl && name === "o") {
    // Ctrl+O: toggle output overlay (view last command output)
    s.overlay = s.overlay === "output" ? "none" : "output";
    return r(s);
  }
  if (key.ctrl && name === "t") {
    // Ctrl+T: toggle task tree / Mission Control overlay
    s.overlay = s.overlay === "tasktree" ? "none" : "tasktree";
    return r(s);
  }
  if (key.ctrl && name === "u") {
    if (s.overlay === "palette") {
      s.paletteQuery = "";
      s.paletteSelected = 0;
    } else if (s.overlay === "model") {
      s.modelQuery = "";
      s.modelSelected = 0;
    } else {
      s.buffer = s.buffer.slice(s.cursor);
      s.cursor = 0;
    }
    return r(s);
  }

  // ── Palette overlay ──────────────────────────────────────────────────────
  if (s.overlay === "palette") return reducePalette(s, key, ctx);
  if (s.overlay === "model") return reduceModelPicker(s, key, ctx);
  if (s.overlay === "output" || s.overlay === "tasktree" || s.overlay === "mission") {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      s.overlay = "none";
      return r(s);
    }
    return r(s, { type: "none" });
  }
  if (s.overlay === "history") return reduceHistorySearch(s, key);

  // ── Editor + completion ──────────────────────────────────────────────────
  switch (name) {
    case "return":
    case "enter": {
      if (key.shift || key.meta) {
        // Newline (multiline input).
        s.buffer = s.buffer.slice(0, s.cursor) + "\n" + s.buffer.slice(s.cursor);
        s.cursor++;
        return r(s);
      }
      const ms = completionMatches(s, ctx);
      const value = completionActive(s) && ms.length > 0 ? "/" + ms[clampSelection(s.completionSelected, ms.length)]!.name : s.buffer;
      return r(commitHistory(s, value), { type: "submit", value });
    }
    case "tab": {
      const ms = completionMatches(s, ctx);
      if (ms.length > 0) {
        const sel = clampSelection(s.completionSelected, ms.length);
        const completed = "/" + ms[sel]!.name;
        if (s.buffer !== completed || ms[sel]!.subcommands?.length) {
          s.buffer = completed + " ";
          s.cursor = s.buffer.length;
          s.completionDismissed = true;
        } else {
          s.completionSelected = clampSelection(sel + 1, ms.length);
        }
        return r(s);
      }
      return r(s, { type: "none" });
    }
    case "up":
      if (completionActive(s)) {
        s.completionSelected = clampSelection(s.completionSelected - 1, completionMatches(s, ctx).length);
        return r(s);
      }
      return r(historyPrev(s));
    case "down":
      if (completionActive(s)) {
        s.completionSelected = clampSelection(s.completionSelected + 1, completionMatches(s, ctx).length);
        return r(s);
      }
      return r(historyNext(s));
    case "escape":
      if (completionActive(s)) {
        s.completionDismissed = true;
        return r(s);
      }
      return r(s, { type: "none" });
    case "backspace":
      if (s.cursor > 0) {
        s.buffer = s.buffer.slice(0, s.cursor - 1) + s.buffer.slice(s.cursor);
        s.cursor--;
        s.completionDismissed = false;
        return r(s);
      }
      return r(s, { type: "none" });
    case "delete":
      if (s.cursor < s.buffer.length) {
        s.buffer = s.buffer.slice(0, s.cursor) + s.buffer.slice(s.cursor + 1);
        return r(s);
      }
      return r(s, { type: "none" });
    case "left":
      if (s.cursor > 0) {
        s.cursor--;
        return r(s);
      }
      return r(s, { type: "none" });
    case "right":
      if (s.cursor < s.buffer.length) {
        s.cursor++;
        return r(s);
      }
      return r(s, { type: "none" });
    case "home":
      s.cursor = 0;
      return r(s);
    case "end":
      s.cursor = s.buffer.length;
      return r(s);
    default:
      break;
  }

  // Printable insertion (including pasted runs; control bytes are ignored).
  if (key.str && !key.ctrl && !key.meta) {
    const clean = sanitizePrintable(key.str);
    if (clean.length > 0) {
      s.buffer = s.buffer.slice(0, s.cursor) + clean + s.buffer.slice(s.cursor);
      s.cursor += clean.length;
      s.completionSelected = 0;
      s.completionDismissed = false;
      return r(s);
    }
  }
  return r(s, { type: "none" });
}

function handleInterrupt(s: InputState): { state: InputState; action: InputAction } {
  if (s.overlay === "palette") {
    s.overlay = "none";
    s.paletteQuery = "";
    return r(s);
  }
  if (s.overlay === "model") {
    s.overlay = "none";
    s.modelQuery = "";
    s.modelSelected = 0;
    return r(s);
  }
  if (completionActive(s)) {
    s.completionDismissed = true;
    return r(s);
  }
  if (s.buffer.length > 0) {
    s.buffer = "";
    s.cursor = 0;
    return r(s);
  }
  if (s.confirmExit) return r(s, { type: "exit" });
  s.confirmExit = true;
  return r(s);
}

function reducePalette(s: InputState, key: KeyInput, ctx: KeyContext): { state: InputState; action: InputAction } {
  const items = fuzzyPalette(s.paletteQuery, ctx.paletteItems);
  switch (key.name) {
    case "escape":
      s.overlay = "none";
      s.paletteQuery = "";
      return r(s);
    case "return":
    case "enter": {
      if (items.length === 0) return r(s, { type: "none" });
      const sel = clampSelection(s.paletteSelected, items.length);
      const value = items[sel]!.run;
      s.overlay = "none";
      s.paletteQuery = "";
      s.paletteSelected = 0;
      return r(commitHistory(s, value), { type: "submit", value });
    }
    case "up":
      s.paletteSelected = clampSelection(s.paletteSelected - 1, items.length);
      return r(s);
    case "down":
    case "tab":
      s.paletteSelected = clampSelection(s.paletteSelected + 1, items.length);
      return r(s);
    case "backspace":
      s.paletteQuery = s.paletteQuery.slice(0, -1);
      s.paletteSelected = 0;
      return r(s);
    default:
      if (key.str && !key.ctrl && !key.meta) {
        const clean = sanitizePrintable(key.str);
        if (clean) {
          s.paletteQuery += clean;
          s.paletteSelected = 0;
          return r(s);
        }
      }
      return r(s, { type: "none" });
  }
}

/**
 * The /model picker: search/filter, arrow navigation, Enter to select, Escape
 * to cancel without changing anything. Enter never mutates settings directly
 * — it synthesizes the exact `/model <id>` (or `/model auto`) command line
 * and submits it through the normal input pipeline, so a picker selection
 * and a manually typed `/model <id>` are provably the same code path. An
 * unavailable (unconfigured-provider) model can be highlighted and inspected
 * but Enter on it is a no-op — it can never be "falsely selected."
 */
function reduceModelPicker(s: InputState, key: KeyInput, ctx: KeyContext): { state: InputState; action: InputAction } {
  const items = filterModelItems(s.modelQuery, ctx.modelItems ?? []);
  switch (key.name) {
    case "escape":
      s.overlay = "none";
      s.modelQuery = "";
      s.modelSelected = 0;
      return r(s);
    case "return":
    case "enter": {
      if (items.length === 0) return r(s, { type: "none" });
      const sel = clampSelection(s.modelSelected, items.length);
      const item = items[sel]!;
      if (item.kind === "model" && !item.available) return r(s, { type: "none" });
      const value = item.kind === "auto" ? "/model auto" : `/model ${item.id}`;
      s.overlay = "none";
      s.modelQuery = "";
      s.modelSelected = 0;
      return r(commitHistory(s, value), { type: "submit", value });
    }
    case "up":
      s.modelSelected = clampSelection(s.modelSelected - 1, items.length);
      return r(s);
    case "down":
    case "tab":
      s.modelSelected = clampSelection(s.modelSelected + 1, items.length);
      return r(s);
    case "backspace":
      s.modelQuery = s.modelQuery.slice(0, -1);
      s.modelSelected = 0;
      return r(s);
    default:
      if (key.str && !key.ctrl && !key.meta) {
        const clean = sanitizePrintable(key.str);
        if (clean) {
          s.modelQuery += clean;
          s.modelSelected = 0;
          return r(s);
        }
      }
      return r(s, { type: "none" });
  }
}

function reduceHistorySearch(s: InputState, key: KeyInput): { state: InputState; action: InputAction } {
  switch (key.name) {
    case "escape":
    case "c": if (key.ctrl) { s.overlay = "none"; s.paletteQuery = ""; return r(s); }
      s.overlay = "none"; s.paletteQuery = ""; return r(s);
    case "return":
    case "enter": {
      const matches = s.history.filter(h => h.toLowerCase().includes(s.paletteQuery.toLowerCase()));
      if (matches.length > 0) {
        const value = matches[matches.length - 1]!; // most recent match
        s.overlay = "none";
        s.paletteQuery = "";
        return r(commitHistory(s, value), { type: "submit", value });
      }
      return r(s, { type: "none" });
    }
    case "backspace":
      s.paletteQuery = s.paletteQuery.slice(0, -1);
      return r(s);
    default:
      if (key.str && !key.ctrl && !key.meta) {
        const clean = sanitizePrintable(key.str);
        if (clean) { s.paletteQuery += clean; return r(s); }
      }
      return r(s, { type: "none" });
  }
}

function commitHistory(s: InputState, value: string): InputState {
  const next = { ...s, buffer: "", cursor: 0, historyIndex: -1, draft: "", completionDismissed: false, completionSelected: 0 };
  const trimmed = value.trim();
  if (trimmed && s.history[s.history.length - 1] !== trimmed) next.history = [...s.history, trimmed];
  return next;
}

function historyPrev(s: InputState): InputState {
  if (s.history.length === 0) return s;
  const idx = s.historyIndex === -1 ? s.history.length - 1 : Math.max(0, s.historyIndex - 1);
  const draft = s.historyIndex === -1 ? s.buffer : s.draft;
  const buffer = s.history[idx]!;
  return { ...s, historyIndex: idx, draft, buffer, cursor: buffer.length };
}

function historyNext(s: InputState): InputState {
  if (s.historyIndex === -1) return s;
  const idx = s.historyIndex + 1;
  if (idx >= s.history.length) {
    return { ...s, historyIndex: -1, buffer: s.draft, cursor: s.draft.length };
  }
  const buffer = s.history[idx]!;
  return { ...s, historyIndex: idx, buffer, cursor: buffer.length };
}

/** Strip control characters from pasted/typed input but keep newlines/tabs out. */
function sanitizePrintable(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Insert already-normalized paste text (newlines preserved) at the cursor. This
 * is the multi-line counterpart to printable insertion: a bracketed paste is one
 * atomic edit, so it never triggers submit and never collapses its line breaks.
 */
export function insertPaste(state: InputState, text: string): InputState {
  if (!text) return state;
  const s: InputState = { ...state, confirmExit: false };
  s.buffer = s.buffer.slice(0, s.cursor) + text + s.buffer.slice(s.cursor);
  s.cursor += text.length;
  s.completionSelected = 0;
  s.completionDismissed = false;
  return s;
}

/**
 * The composer, as a pure state machine.
 *
 * Every keystroke that reaches the input line folds through `applyKey` and
 * produces a new `EditorState` plus, occasionally, an `EditorAction` for the
 * shell to act on. Nothing here touches a terminal, React, or the network, so
 * the entire editing surface — cursor motion, word boundaries, multiline
 * navigation, history recall, kill/yank, paste capture — is testable without a
 * TTY.
 *
 * The previous Ink composer held a bare `draft: string` and appended to it. That
 * is why left-arrow did nothing, why Home/End did nothing, why history did
 * nothing, and why a multiline paste destroyed the line: there was no cursor to
 * move and no structure to move it through. This module is the missing model.
 *
 * Text is stored as one string with embedded newlines rather than an array of
 * lines. A caret is then a single integer, which makes every operation below a
 * slice — and makes it impossible to hold a cursor that points at a line which
 * no longer exists.
 */

/** Graphemes, not code units: one arrow press must cross a whole emoji. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Any line break, in either convention. */
const NEWLINE = /[\r\n]/;
/** CR or CRLF, normalised to LF on the way in. */
const CRLF = /\r\n?/g;

/** Pastes at least this tall are held aside behind a placeholder token rather
 *  than dumped into the composer. Matches the threshold Pi uses, for the same
 *  reason: a 400-line paste is a fact about the message, not something anyone
 *  wants to scroll past while writing the sentence around it. */
export const PASTE_LINE_THRESHOLD = 8;

export interface PastedBlock {
  id: number;
  text: string;
  lines: number;
}

export interface EditorState {
  /** The visible text. Placeholders for large pastes appear here literally. */
  text: string;
  /** Caret offset into `text`, in UTF-16 code units. */
  cursor: number;
  /** Column the caret "wants" while moving vertically; null once it moves
   *  horizontally. Without this, up/down through a short line permanently
   *  loses the column, which is the single most irritating editor bug. */
  goalColumn: number | null;
  /** Submitted entries, oldest → newest. */
  history: readonly string[];
  /** Index into `history` while recalling; -1 means "editing fresh text". */
  historyIndex: number;
  /** The in-progress text set aside while browsing history. */
  stash: string;
  /** Emacs kill ring; most recent last. */
  kill: readonly string[];
  /** True when the last action was itself a kill, so consecutive kills
   *  accumulate into one entry instead of many. */
  killing: boolean;
  /** Large pastes, keyed by the id embedded in their placeholder. */
  pastes: readonly PastedBlock[];
  /** Next placeholder id. Monotonic so a deleted placeholder's number is
   *  never reused inside one session — a stale `[#2]` must never resolve. */
  nextPasteId: number;
}

export type EditorAction =
  | { type: "none" }
  /** The composer wants to send `text` (placeholders already expanded). */
  | { type: "submit"; text: string }
  /** Nothing left to delete and nothing typed — the shell decides what an
   *  empty backspace/Ctrl+D means in its current mode. */
  | { type: "empty" };

export interface KeyPress {
  /** Printable text for this keypress, or "" for pure control keys. */
  input: string;
  name?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  shift?: boolean | undefined;
}

const NONE: EditorAction = { type: "none" };

export function initialEditorState(history: readonly string[] = []): EditorState {
  return {
    text: "",
    cursor: 0,
    goalColumn: null,
    history,
    historyIndex: -1,
    stash: "",
    kill: [],
    killing: false,
    pastes: [],
    nextPasteId: 1,
  };
}

// ── Grapheme / word boundaries ───────────────────────────────────────────────

/** Offset one grapheme left of `at`. */
export function prevGrapheme(text: string, at: number): number {
  if (at <= 0) return 0;
  let last = 0;
  for (const { index } of segmenter.segment(text.slice(0, at))) {
    if (index >= at) break;
    last = index;
  }
  return last;
}

/** Offset one grapheme right of `at`. */
export function nextGrapheme(text: string, at: number): number {
  if (at >= text.length) return text.length;
  for (const { index, segment } of segmenter.segment(text.slice(at))) {
    if (index === 0) return at + segment.length;
  }
  return text.length;
}

const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char);

/**
 * Offset at the start of the word left of `at`.
 *
 * Skips any run of separators first, then consumes one run of word characters —
 * the behaviour Ctrl+Left and Alt+B have everywhere else, so `foo/bar baz|`
 * stops at `baz`, then `bar`, then `foo`, rather than jumping the whole path.
 */
export function wordLeft(text: string, at: number): number {
  let index = at;
  while (index > 0 && !isWordChar(text[index - 1]!)) index -= 1;
  while (index > 0 && isWordChar(text[index - 1]!)) index -= 1;
  return index;
}

/** Offset at the end of the word right of `at`. */
export function wordRight(text: string, at: number): number {
  let index = at;
  while (index < text.length && !isWordChar(text[index]!)) index += 1;
  while (index < text.length && isWordChar(text[index]!)) index += 1;
  return index;
}

// ── Logical line geometry ────────────────────────────────────────────────────

/** Offset of the start of the logical line containing `at`. */
export function lineStart(text: string, at: number): number {
  const found = text.lastIndexOf("\n", Math.max(0, at - 1));
  return found === -1 ? 0 : found + 1;
}

/** Offset of the end of the logical line containing `at` (before its newline). */
export function lineEnd(text: string, at: number): number {
  const found = text.indexOf("\n", at);
  return found === -1 ? text.length : found;
}

/** Zero-based column of `at` within its logical line. */
export function columnOf(text: string, at: number): number {
  return at - lineStart(text, at);
}

// ── Mutation helpers ─────────────────────────────────────────────────────────

function withText(state: EditorState, text: string, cursor: number): EditorState {
  return {
    ...state,
    text,
    cursor: Math.max(0, Math.min(cursor, text.length)),
    goalColumn: null,
    killing: false,
  };
}

function move(state: EditorState, cursor: number, keepGoal = false): EditorState {
  return {
    ...state,
    cursor: Math.max(0, Math.min(cursor, state.text.length)),
    goalColumn: keepGoal ? state.goalColumn : null,
    killing: false,
  };
}

/** Push `text` onto the kill ring, merging with the previous entry when the
 *  last action was also a kill (so three Ctrl+W's yank back three words). */
function pushKill(state: EditorState, text: string, prepend: boolean): readonly string[] {
  if (!text) return state.kill;
  if (state.killing && state.kill.length > 0) {
    const last = state.kill[state.kill.length - 1]!;
    return [...state.kill.slice(0, -1), prepend ? text + last : last + text];
  }
  return [...state.kill, text];
}

export function insert(state: EditorState, chunk: string): EditorState {
  if (!chunk) return state;
  const text = state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor);
  return withText(state, text, state.cursor + chunk.length);
}

/**
 * Insert pasted content.
 *
 * Short pastes go in as text. A tall one is stored whole and represented in the
 * composer by a single placeholder, so the line you are writing stays legible
 * and the payload is still sent verbatim on submit.
 */
export function insertPaste(state: EditorState, chunk: string): EditorState {
  const normalized = chunk.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length;
  if (lines < PASTE_LINE_THRESHOLD) return insert(state, normalized);
  const id = state.nextPasteId;
  const placeholder = pastePlaceholder(id, lines);
  const next = insert(
    { ...state, pastes: [...state.pastes, { id, text: normalized, lines }], nextPasteId: id + 1 },
    placeholder,
  );
  return next;
}

export function pastePlaceholder(id: number, lines: number): string {
  return `[#${id} pasted ${lines} lines]`;
}

/**
 * The pastes whose placeholder is still in the composer.
 *
 * Deleting the placeholder deletes the paste. Anything else would let the
 * composer claim "1 pasted block held" after the text referencing it is gone —
 * and, worse, silently attach that payload to whatever is sent next.
 */
export function activePastes(state: EditorState): PastedBlock[] {
  return state.pastes.filter((block) => state.text.includes(pastePlaceholder(block.id, block.lines)));
}

/** Replace every placeholder with the text it stands for. */
export function expandPastes(state: EditorState): string {
  let out = state.text;
  for (const block of activePastes(state)) {
    out = out.split(pastePlaceholder(block.id, block.lines)).join(block.text);
  }
  return out;
}

// ── History ──────────────────────────────────────────────────────────────────

function recall(state: EditorState, delta: number): EditorState {
  const { history } = state;
  if (history.length === 0) return state;
  // -1 is "fresh"; 0 is the most recent entry; history.length - 1 the oldest.
  const next = state.historyIndex + delta;
  if (next < 0) {
    if (state.historyIndex === -1) return state;
    return { ...withText(state, state.stash, state.stash.length), historyIndex: -1 };
  }
  if (next >= history.length) return state;
  const stash = state.historyIndex === -1 ? state.text : state.stash;
  const entry = history[history.length - 1 - next]!;
  return { ...withText(state, entry, entry.length), historyIndex: next, stash };
}

/** Record a submitted line, newest last, without adjacent duplicates. */
export function remember(state: EditorState, line: string): EditorState {
  const trimmed = line.trim();
  if (!trimmed) return state;
  const history =
    state.history[state.history.length - 1] === trimmed ? state.history : [...state.history, trimmed];
  return { ...state, history, historyIndex: -1, stash: "" };
}

/** Clear the composer, keeping history and the kill ring. */
export function clearText(state: EditorState): EditorState {
  return { ...state, text: "", cursor: 0, goalColumn: null, historyIndex: -1, stash: "", pastes: [] };
}

// ── Vertical movement across wrapped rows ────────────────────────────────────

/**
 * Visual rows for `text` at `width`, and where the caret sits among them.
 *
 * Wrapping has to be computed here rather than left to Ink because the caret's
 * up/down behaviour must match what the reader sees: pressing Up on a line that
 * wrapped three times moves one *visual* row, not one logical line. The composer
 * renders these same rows, so the two can never disagree.
 */
export interface VisualLayout {
  rows: string[];
  /** Caret's row index within `rows`. */
  row: number;
  /** Caret's column within its row. */
  column: number;
  /** Offset in `text` at which each row starts. */
  starts: number[];
}

export function layout(text: string, cursor: number, width: number): VisualLayout {
  const usable = Math.max(1, width);
  const rows: string[] = [];
  const starts: number[] = [];
  let row = 0;
  let column = 0;

  let offset = 0;
  for (const logical of text.split("\n")) {
    let consumed = 0;
    do {
      const slice = logical.slice(consumed, consumed + usable);
      const start = offset + consumed;
      // The caret belongs to this row when it falls inside it, or when it sits
      // exactly at the row's end and this is the row's final chunk — otherwise
      // a caret at a wrap boundary would render one row too high.
      const end = start + slice.length;
      const isLastChunk = consumed + usable >= logical.length;
      if (cursor >= start && (cursor < end || (cursor === end && isLastChunk))) {
        row = rows.length;
        column = cursor - start;
      }
      rows.push(slice);
      starts.push(start);
      consumed += usable;
    } while (consumed < logical.length);
    offset += logical.length + 1; // + the newline
  }

  return { rows, row, column, starts };
}

function moveVertical(state: EditorState, delta: number, width: number): EditorState {
  const view = layout(state.text, state.cursor, width);
  const target = view.row + delta;
  if (target < 0 || target >= view.rows.length) return state;
  const goal = state.goalColumn ?? view.column;
  const start = view.starts[target]!;
  const length = view.rows[target]!.length;
  return {
    ...state,
    cursor: start + Math.min(goal, length),
    goalColumn: goal,
    killing: false,
  };
}

/** True when the caret is on the first visual row — where Up means "history". */
export function onFirstRow(state: EditorState, width: number): boolean {
  return layout(state.text, state.cursor, width).row === 0;
}

/** True when the caret is on the last visual row. */
export function onLastRow(state: EditorState, width: number): boolean {
  const view = layout(state.text, state.cursor, width);
  return view.row === view.rows.length - 1;
}

// ── The reducer ──────────────────────────────────────────────────────────────

export interface EditorContext {
  /** Render width available to the composer, for vertical movement. */
  width: number;
  /** When false, Enter inserts a newline instead of submitting. Used while a
   *  completion menu owns the Enter key. */
  submitOnEnter?: boolean;
}

export interface EditorStep {
  state: EditorState;
  action: EditorAction;
  /** False when the key was not an editing key at all, so the caller can try
   *  its own bindings without the editor swallowing the keystroke. */
  handled: boolean;
}

const step = (state: EditorState, action: EditorAction = NONE, handled = true): EditorStep => ({
  state,
  action,
  handled,
});

/**
 * Fold one keypress into the composer.
 *
 * Bindings follow readline, because that is what a terminal user's fingers
 * already know: Ctrl+A/E for line ends, Ctrl+W to rub out a word, Ctrl+U/K to
 * kill to either end, Ctrl+Y to yank it back, Alt+B/F to walk by word.
 */
export function applyKey(state: EditorState, key: KeyPress, context: EditorContext): EditorStep {
  const { text, cursor } = state;
  const width = Math.max(1, context.width);
  const submitOnEnter = context.submitOnEnter !== false;

  // ── Batched input ──────────────────────────────────────────────────────────
  // A terminal does not promise one keypress per read. Type quickly, or let a
  // terminal without bracketed paste hand over a block, and several characters
  // arrive together — carriage return included. Ink passes that through as one
  // string, so without this the whole line (Enter and all) was inserted as
  // literal text and nothing was ever sent.
  if (key.input.length > 1 && NEWLINE.test(key.input)) {
    const normalized = key.input.replace(CRLF, "\n");
    const sends = normalized.endsWith("\n");
    const body = sends ? normalized.slice(0, -1) : normalized;
    const next = body ? insert(state, body) : state;
    if (!sends || !submitOnEnter) return step(next);
    const payload = expandPastes(next);
    return payload.trim() ? step(next, { type: "submit", text: payload }) : step(next);
  }

  // ── Submission and newlines ────────────────────────────────────────────────
  if (key.name === "return") {
    // Shift/Alt/Ctrl+Enter always opens a line. Terminals disagree wildly about
    // which of those they can even report, so all three are accepted; a
    // backslash continuation is the fallback that works everywhere.
    if (key.shift || key.meta || key.ctrl || !submitOnEnter) {
      return step(insert(state, "\n"));
    }
    if (text.endsWith("\\")) {
      return step(insert(withText(state, text.slice(0, -1), Math.min(cursor, text.length - 1)), "\n"));
    }
    const payload = expandPastes(state);
    if (!payload.trim()) return step(state, NONE, true);
    return step(state, { type: "submit", text: payload });
  }

  // ── Deletion ───────────────────────────────────────────────────────────────
  if (key.name === "backspace" || (key.ctrl && key.input === "h")) {
    if (key.meta || key.ctrl) {
      const from = wordLeft(text, cursor);
      if (from === cursor) return step(state);
      const killed = text.slice(from, cursor);
      const next = withText(state, text.slice(0, from) + text.slice(cursor), from);
      return step({ ...next, kill: pushKill(state, killed, true), killing: true });
    }
    if (cursor === 0) return step(state, text ? NONE : { type: "empty" });
    const from = prevGrapheme(text, cursor);
    return step(withText(state, text.slice(0, from) + text.slice(cursor), from));
  }

  if (key.name === "delete") {
    if (key.meta || key.ctrl) {
      const to = wordRight(text, cursor);
      if (to === cursor) return step(state);
      const killed = text.slice(cursor, to);
      const next = withText(state, text.slice(0, cursor) + text.slice(to), cursor);
      return step({ ...next, kill: pushKill(state, killed, false), killing: true });
    }
    if (cursor >= text.length) return step(state);
    const to = nextGrapheme(text, cursor);
    return step(withText(state, text.slice(0, cursor) + text.slice(to), cursor));
  }

  if (key.ctrl && key.input === "w") {
    const from = wordLeft(text, cursor);
    if (from === cursor) return step(state);
    const killed = text.slice(from, cursor);
    const next = withText(state, text.slice(0, from) + text.slice(cursor), from);
    return step({ ...next, kill: pushKill(state, killed, true), killing: true });
  }

  if (key.meta && (key.input === "d" || key.name === "delete")) {
    const to = wordRight(text, cursor);
    if (to === cursor) return step(state);
    const killed = text.slice(cursor, to);
    const next = withText(state, text.slice(0, cursor) + text.slice(to), cursor);
    return step({ ...next, kill: pushKill(state, killed, false), killing: true });
  }

  if (key.ctrl && key.input === "u") {
    const from = lineStart(text, cursor);
    if (from === cursor) return step(state);
    const killed = text.slice(from, cursor);
    const next = withText(state, text.slice(0, from) + text.slice(cursor), from);
    return step({ ...next, kill: pushKill(state, killed, true), killing: true });
  }

  if (key.ctrl && key.input === "k") {
    const to = lineEnd(text, cursor);
    // Ctrl+K at the end of a line eats the newline, joining the next line up —
    // otherwise it appears to do nothing on an already-empty line end.
    const target = to === cursor && to < text.length ? to + 1 : to;
    if (target === cursor) return step(state);
    const killed = text.slice(cursor, target);
    const next = withText(state, text.slice(0, cursor) + text.slice(target), cursor);
    return step({ ...next, kill: pushKill(state, killed, false), killing: true });
  }

  if (key.ctrl && key.input === "y") {
    const yank = state.kill[state.kill.length - 1];
    return yank ? step(insert(state, yank)) : step(state);
  }

  // ── Horizontal movement ────────────────────────────────────────────────────
  if (key.name === "left") {
    if (key.ctrl || key.meta) return step(move(state, wordLeft(text, cursor)));
    return step(move(state, prevGrapheme(text, cursor)));
  }
  if (key.name === "right") {
    if (key.ctrl || key.meta) return step(move(state, wordRight(text, cursor)));
    return step(move(state, nextGrapheme(text, cursor)));
  }
  if (key.meta && key.input === "b") return step(move(state, wordLeft(text, cursor)));
  if (key.meta && key.input === "f") return step(move(state, wordRight(text, cursor)));

  if (key.name === "home" || (key.ctrl && key.input === "a")) {
    return step(move(state, lineStart(text, cursor)));
  }
  if (key.name === "end" || (key.ctrl && key.input === "e")) {
    return step(move(state, lineEnd(text, cursor)));
  }

  // ── Vertical movement and history ──────────────────────────────────────────
  if (key.name === "up") {
    if (!onFirstRow(state, width)) return step(moveVertical(state, -1, width));
    return step(recall(state, +1));
  }
  if (key.name === "down") {
    if (!onLastRow(state, width)) return step(moveVertical(state, +1, width));
    return step(recall(state, -1));
  }

  // ── Literal text ───────────────────────────────────────────────────────────
  // Control chords never reach here as text: `input` for Ctrl+X is the bare
  // letter, and inserting it would type a stray character on every unbound
  // chord. Anything genuinely printable — including pasted chunks Ink hands
  // over as one string — is inserted whole.
  if (key.ctrl || key.meta) return step(state, NONE, false);
  if (key.input && !key.name) return step(insert(state, key.input));
  if (key.input && key.input.length > 1) return step(insert(state, key.input));

  return step(state, NONE, false);
}

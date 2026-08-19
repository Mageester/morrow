/**
 * The keyboard contract, declared once.
 *
 * `/shortcuts` renders this table and the composer binds against the same
 * entries, so a binding cannot drift from its documentation. The previous shell
 * printed a hand-written one-line summary that listed four bindings the Ink
 * shell had never implemented.
 */

export interface KeyBinding {
  group: string;
  keys: string;
  description: string;
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { group: "Composing", keys: "Enter", description: "send the message" },
  { group: "Composing", keys: "Alt+Enter / Shift+Enter", description: "start a new line" },
  { group: "Composing", keys: "\\ then Enter", description: "new line, on terminals that cannot report the above" },
  { group: "Composing", keys: "↑ ↓", description: "move a line, or recall history at the edges" },
  { group: "Composing", keys: "← →", description: "move by character" },
  { group: "Composing", keys: "Ctrl/Alt + ← →", description: "move by word" },
  { group: "Composing", keys: "Home / Ctrl+A", description: "start of line" },
  { group: "Composing", keys: "End / Ctrl+E", description: "end of line" },
  { group: "Composing", keys: "Ctrl+W", description: "delete the word before the cursor" },
  { group: "Composing", keys: "Alt+D", description: "delete the word after the cursor" },
  { group: "Composing", keys: "Ctrl+U", description: "delete to start of line" },
  { group: "Composing", keys: "Ctrl+K", description: "delete to end of line" },
  { group: "Composing", keys: "Ctrl+Y", description: "paste back what you deleted" },

  { group: "Composing", keys: "Ctrl+X", description: "edit the draft in $EDITOR" },

  { group: "Commands", keys: "/", description: "open the command palette" },
  { group: "Commands", keys: "@", description: "reference a file" },
  { group: "Commands", keys: "Tab", description: "complete the highlighted suggestion" },
  { group: "Commands", keys: "↑ ↓", description: "move through suggestions" },
  { group: "Commands", keys: "Enter", description: "run the highlighted command" },
  { group: "Commands", keys: "Esc", description: "dismiss suggestions, keeping what you typed" },

  { group: "Running work", keys: "Ctrl+C", description: "stop the running task" },
  { group: "Running work", keys: "Ctrl+C twice", description: "when idle, leave Morrow" },
  { group: "Running work", keys: "Esc", description: "stop the running task" },
  { group: "Running work", keys: "type while working", description: "queued and sent when the task ends" },

  { group: "Screen", keys: "Ctrl+O", description: "expand or collapse tool detail" },
  { group: "Screen", keys: "Ctrl+R", description: "read the model's full reasoning" },
  { group: "Screen", keys: "Ctrl+L", description: "clear the screen" },
  { group: "Screen", keys: "Ctrl+G", description: "this reference" },
] as const;

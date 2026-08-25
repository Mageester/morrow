import { Box, Static, Text, useInput, usePaste, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { approvalDecisionForKey, type ApprovalDecision } from "../approvals.js";
import type { Command } from "../commands/registry.js";
import type { ConversationEntry, TerminalState } from "../state.js";
import { ActivityLine } from "./activity-line.js";
import { ApprovalPrompt } from "./approval.js";
import type { ApprovalStore } from "./approval-store.js";
import { Composer } from "./composer.js";
import {
  applyKey,
  clearText,
  initialEditorState,
  insert,
  insertPaste,
  remember,
  type EditorState,
} from "./editor.js";
import { Markdown } from "./markdown.js";
import { ModelPicker } from "./model-picker.js";
import { Outcome } from "./outcome.js";
import { PlanView } from "./plan-view.js";
import type { OverlayStore } from "./overlay-store.js";
import { CommandPalette, filterCommands, type Scored } from "./palette.js";
import { ReasoningView } from "./reasoning-view.js";
import { ReportView } from "./report-view.js";
import { SelectOverlay } from "./select-overlay.js";
import { TranscriptOverlay } from "./transcript-overlay.js";
import { StatusLine } from "./status-line.js";
import type { TerminalStore } from "./store.js";
import { glyphs, theme } from "./theme.js";
import { WorkSummary } from "./work-summary.js";

/**
 * The Morrow terminal shell.
 *
 * Hierarchy, top to bottom: the conversation, the work happening right now, the
 * composer. Detail is reachable, never resident.
 *
 * Two structural rules keep this fast and keep the composer intact:
 *
 * Settled turns render inside Ink's `<Static>`. They are written once, scroll
 * into native scrollback, and are never re-rendered on a later frame — so a
 * thousand-line session costs the same per frame as an empty one.
 *
 * The composer is a pure editor model, not a string. Streaming output cannot
 * corrupt it because the two never share state: tokens land in the store, the
 * caret lives in `EditorState`, and the only thing they have in common is the
 * frame they are both drawn into.
 */

export interface AppProps {
  store: TerminalStore;
  cwdLabel: string;
  unicode: boolean;
  /** Submits a composed message to the runtime. */
  onSubmit: (text: string) => void;
  /** Requests cancellation of the running task. Returns false when idle. */
  onInterrupt: () => boolean;
  /** Every command, for the palette and completion. */
  commands?: readonly Command[] | undefined;
  /** Resolves `@` file references. Returns candidate paths for a prefix. */
  onCompleteFile?: ((prefix: string) => string[]) | undefined;
  /** Pending approval, raised by the runtime loop outside the React tree. */
  approvals?: ApprovalStore | undefined;
  /** Answers the pending approval. */
  onApprovalDecision?: ((decision: ApprovalDecision) => void) | undefined;
  /** Full-surface overlay, raised by a command handler. */
  overlays?: OverlayStore | undefined;
  /** Lines recalled with ↑, oldest first. */
  history?: readonly string[] | undefined;
  /** Hands the draft to an external editor and returns the edited text, or
   *  null if the edit was cancelled or failed. The shell owns this because it
   *  owns the terminal: raw mode has to come off before a child can have it. */
  onExternalEdit?: ((text: string) => string | null) | undefined;
  /** Persists a submitted line. */
  onHistoryAppend?: ((line: string) => void) | undefined;
  /** Leaves the shell. Never `process.exit` from a component. */
  onExit?: (() => void) | undefined;
  /** Live send options, for the status line. Mutated by commands. */
  settings?: import("../session-types.js").SendOptions | undefined;
}

/** Everything the composer owns, held together so one batch of keypresses
 *  cannot see half of it updated. */
interface ComposerState {
  editor: EditorState;
  selected: number;
  suggestionsClosed: boolean;
  exitArmed: boolean;
}

function useTerminalState(store: TerminalStore): TerminalState {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.state;
}

const NO_VERSION = () => 0;

function useOverlay(overlays: OverlayStore | undefined) {
  useSyncExternalStore(
    overlays?.subscribe ?? (() => () => {}),
    overlays?.getVersion ?? NO_VERSION,
    overlays?.getVersion ?? NO_VERSION,
  );
  return overlays?.active ?? null;
}

function useApproval(approvals: ApprovalStore | undefined) {
  useSyncExternalStore(
    approvals?.subscribe ?? (() => () => {}),
    approvals?.getVersion ?? NO_VERSION,
    approvals?.getVersion ?? NO_VERSION,
  );
  return approvals?.pending ?? null;
}

/** A finished transcript entry. Rendered once, then owned by scrollback. */
function SettledTurn({ entry, unicode, width }: { entry: ConversationEntry; unicode: boolean; width: number }) {
  const g = glyphs(unicode);

  if (entry.role === "user") {
    // Deliberately not the composer's "> ": a settled message and the prompt
    // you are typing into must not look identical, or the transcript reads as
    // though the last line is still editable.
    return (
      <Box marginTop={1}>
        <Text backgroundColor={theme.userBg} color={theme.accent}>{unicode ? " │ " : " | "}</Text>
        <Text backgroundColor={theme.userBg} color={theme.soft}>{`${entry.text} `}</Text>
      </Box>
    );
  }

  if (entry.role === "command") {
    return (
      <Box marginTop={1}>
        <Text color={theme.faint}>{`${g.chevron} ${entry.text}`}</Text>
      </Box>
    );
  }

  if (entry.role === "report") {
    return entry.report ? <ReportView report={entry.report} width={width} /> : null;
  }

  if (entry.role === "work") {
    return entry.tools && entry.tools.length > 0 ? (
      <Box marginTop={1}>
        <WorkSummary expanded={false} settled tools={entry.tools} unicode={unicode} />
      </Box>
    ) : null;
  }

  return (
    <Box flexDirection="column">
      {entry.reasoning ? (
        // Always collapsed here. `<Static>` draws a settled turn once and never
        // redraws it, so an expanded copy would freeze at whatever state it had
        // when it scrolled past. Ctrl+R opens the live copy below instead.
        <ReasoningView
          elapsedMs={entry.reasoningMs}
          expanded={false}
          text={entry.reasoning}
          unicode={unicode}
          width={width}
        />
      ) : null}
      <Box marginTop={1} flexDirection="row">
        <Text color={theme.accent}>{g.mark} </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown text={entry.text} unicode={unicode} width={width - 2} />
        </Box>
      </Box>
    </Box>
  );
}

export function App({
  store,
  cwdLabel,
  unicode,
  onSubmit,
  onInterrupt,
  commands = [],
  onCompleteFile,
  approvals,
  onApprovalDecision,
  overlays,
  history = [],
  onHistoryAppend,
  onExit,
  onExternalEdit,
  settings,
}: AppProps) {
  const state = useTerminalState(store);
  const pendingApproval = useApproval(approvals);
  const overlay = useOverlay(overlays);
  const { stdout } = useStdout();

  const [expanded, setExpanded] = useState(false);
  /** Ctrl+R: read the whole of the model's thinking. */
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Composer state lives in a ref, with a counter to trigger renders.
   *
   * Not `useState`. A terminal delivers several keypresses in one chunk
   * whenever a key repeats or someone types quickly, and Ink's parser hands
   * each one to this handler inside a single React tick. With `useState`, every
   * event in that batch computes from the same stale snapshot, so holding ←
   * moved the caret exactly one column and a fast `abc` could lose characters.
   * A ref is read fresh on every event, which is what makes the composer
   * correct under real input rather than only under one-key-at-a-time input.
   */
  const composerRef = useRef<ComposerState>({
    editor: initialEditorState(history),
    selected: 0,
    /** Dismisses the palette without deleting what was typed. */
    suggestionsClosed: false,
    /** Set after one Ctrl+C on an idle empty line; a second one leaves. */
    exitArmed: false,
  });
  const [, bumpComposer] = useReducer((version: number) => version + 1, 0);
  const composer = composerRef.current;
  const { editor, selected, suggestionsClosed, exitArmed } = composer;

  /** Applies a change to composer state and schedules exactly one render. */
  const updateComposer = useCallback(
    (patch: Partial<ComposerState>) => {
      Object.assign(composerRef.current, patch);
      bumpComposer();
    },
    [],
  );

  const g = glyphs(unicode);

  // `?? 80` is not enough: a terminal that reports zero columns (a pty with no
  // winsize, a CI capture, some multiplexers) would set the frame width to 0
  // and wrap every character onto its own line.
  const width = Math.max(40, stdout?.columns || 80);
  const streaming = state.status === "streaming";
  // `task.progress_warning` is the only transient notice the adapter emits.
  // Rendered as its own amber line it sat directly under the activity line and
  // flatly contradicted it — one line reporting the elapsed time and the tool
  // in flight, the next announcing that nothing observable was happening. The
  // signal is real, so it moves onto that line rather than being dropped.
  const quiet = streaming && state.notices.some((notice) => notice.transient === true);
  const notices = streaming ? state.notices.filter((notice) => notice.transient !== true) : state.notices;

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  // ── Suggestions ────────────────────────────────────────────────────────────
  // Both menus are derived from the text rather than held as modes, so there is
  // no state to get stuck in — deleting the character closes them.
  const text = editor.text;
  const beforeCursor = text.slice(0, editor.cursor);
  const slashQuery = /^\/([^\s]*)$/.exec(beforeCursor)?.[1] ?? null;
  const paletteOpen = slashQuery !== null && !suggestionsClosed;
  const fileToken = paletteOpen ? null : (/(?:^|\s)@([^\s]*)$/.exec(beforeCursor)?.[1] ?? null);

  const paletteMatches: Scored[] = useMemo(
    () => (paletteOpen ? filterCommands(commands, slashQuery ?? "") : []),
    [paletteOpen, commands, slashQuery],
  );
  const fileMatches = useMemo(
    () => (fileToken !== null && onCompleteFile && !suggestionsClosed ? onCompleteFile(fileToken).slice(0, 8) : []),
    [fileToken, onCompleteFile, suggestionsClosed],
  );

  const suggestionCount = paletteOpen ? paletteMatches.length : fileMatches.length;
  const suggestionsOpen = suggestionCount > 0;

  // A command typed out in full is a command someone means to run. Without
  // this, Enter on `/model` only completed it to `/model ` and a second Enter
  // was needed — which read as "the picker needs a trailing space".
  const exactCommand = useMemo(
    () => (slashQuery ? (commands.find((command) => command.name === slashQuery || command.aliases?.includes(slashQuery)) ?? null) : null),
    [commands, slashQuery],
  );

  const submit = useCallback(
    (payload: string) => {
      const trimmed = payload.trim();
      if (!trimmed) return;
      onHistoryAppend?.(trimmed);
      updateComposer({
        editor: clearText(remember(composerRef.current.editor, trimmed)),
        selected: 0,
        suggestionsClosed: false,
      });
      onSubmit(trimmed);
    },
    [onSubmit, onHistoryAppend, updateComposer],
  );

  /**
   * Completes the open menu into the composer. Returns false when nothing is
   * open. `intent: "run"` means Enter rather than Tab: a highlighted command
   * that takes no arguments is run immediately instead of being completed and
   * waiting for a second Enter, which reads as the menu ignoring you.
   */
  const accept = useCallback((intent: "complete" | "run" = "complete"): boolean => {
    const current = composerRef.current;
    if (paletteOpen && paletteMatches.length > 0) {
      const chosen = paletteMatches[Math.min(current.selected, paletteMatches.length - 1)]!.command;
      const takesArguments = Boolean(chosen.usage ?? chosen.subcommands?.length);
      if (intent === "run" && !takesArguments) {
        submit(`/${chosen.name}`);
        return true;
      }
      const completion = `/${chosen.name}${takesArguments ? " " : ""}`;
      updateComposer({
        editor: { ...current.editor, text: completion, cursor: completion.length, goalColumn: null },
        selected: 0,
      });
      return true;
    }
    if (fileToken !== null && fileMatches.length > 0) {
      const chosen = fileMatches[Math.min(current.selected, fileMatches.length - 1)]!;
      const editorState = current.editor;
      const replaced = editorState.text.slice(0, editorState.cursor).replace(/@[^\s]*$/, `@${chosen} `);
      const rest = editorState.text.slice(editorState.cursor);
      updateComposer({
        editor: { ...editorState, text: replaced + rest, cursor: replaced.length, goalColumn: null },
        selected: 0,
      });
      return true;
    }
    return false;
  }, [paletteOpen, paletteMatches, fileToken, fileMatches, updateComposer, submit]);

  // Bracketed paste arrives whole, so a multiline paste can never be mistaken
  // for a sequence of Enter presses. Tall pastes collapse to a placeholder and
  // are expanded verbatim on submit.
  usePaste((pasted) => {
    if (pendingApproval || overlay) return;
    updateComposer({ editor: insertPaste(composerRef.current.editor, pasted), suggestionsClosed: false });
  });

  useInput(
    (input, key) => {
      // A pending approval takes the keyboard entirely. Nothing else may consume
      // a keystroke while Morrow waits on a decision — least of all the
      // composer, which would swallow the "y".
      if (pendingApproval) {
        const decision = approvalDecisionForKey({
          str: input,
          ...(key.ctrl ? { ctrl: true, name: input === "c" ? "c" : input } : {}),
        });
        if (decision) onApprovalDecision?.(decision);
        return;
      }

      if (key.ctrl && input === "c") {
        // First Ctrl+C stops the work; with nothing running it clears the line;
        // twice on an empty line leaves. A single keystroke never discards a
        // session someone is mid-way through.
        if (onInterrupt()) {
          updateComposer({ exitArmed: false });
          return;
        }
        if (composerRef.current.editor.text) {
          updateComposer({ editor: clearText(composerRef.current.editor), suggestionsClosed: false });
          return;
        }
        if (composerRef.current.exitArmed) {
          onExit?.();
          return;
        }
        updateComposer({ exitArmed: true });
        clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => updateComposer({ exitArmed: false }), 2000);
        return;
      }

      if (key.ctrl && input === "d" && !composerRef.current.editor.text) {
        onExit?.();
        return;
      }

      if (key.ctrl && input === "o") {
        setExpanded((value) => !value);
        return;
      }

      if (key.ctrl && input === "r") {
        setReasoningOpen((value) => !value);
        return;
      }

      if (key.ctrl && input === "l") {
        store.apply({ type: "session.cleared" });
        return;
      }

      if (key.ctrl && input === "g") {
        submit("/shortcuts");
        return;
      }

      if (key.ctrl && input === "p") {
        submit("/transcript");
        return;
      }

      if (key.ctrl && input === "x" && onExternalEdit) {
        // The draft goes out to the editor and whatever comes back replaces
        // it. A cancelled edit returns null and the composer is left exactly
        // as it was — an editor someone quit out of must never eat the draft.
        const edited = onExternalEdit(composerRef.current.editor.text);
        if (edited !== null) {
          updateComposer({ editor: insert(clearText(composerRef.current.editor), edited), suggestionsClosed: false });
        }
        return;
      }

      if (key.escape) {
        // Escape closes a menu, then stops work. It never destroys the draft —
        // losing a half-written paragraph to a stray keypress is unforgivable,
        // and Ctrl+C already clears the line deliberately.
        if (suggestionsOpen) {
          updateComposer({ suggestionsClosed: true, selected: 0 });
          return;
        }
        onInterrupt();
        return;
      }

      if (suggestionsOpen && (key.upArrow || key.downArrow)) {
        const next = composerRef.current.selected + (key.downArrow ? 1 : -1);
        updateComposer({ selected: Math.max(0, Math.min(next, suggestionCount - 1)) });
        return;
      }

      if (key.tab) {
        accept();
        return;
      }

      if (key.return && !key.shift && !key.meta && !key.ctrl) {
        // With a menu open, Enter acts on the highlighted row: it runs a
        // command that needs no arguments and completes one that does. A
        // command already typed in full falls through and is simply sent.
        if (suggestionsOpen && !exactCommand && accept("run")) return;
      }

      const before = composerRef.current.editor;
      const step = applyKey(
        before,
        {
          input,
          ...(keyName(key, input) ? { name: keyName(key, input) } : {}),
          ...(key.ctrl ? { ctrl: true } : {}),
          ...(key.meta ? { meta: true } : {}),
          ...(key.shift ? { shift: true } : {}),
        },
        { width: width - 2 },
      );

      if (step.action.type === "submit") {
        submit(step.action.text);
        return;
      }
      if (step.handled) {
        // Typing re-opens a menu that was dismissed, but only on real editing —
        // otherwise Escape would be undone by the next arrow key.
        const edited = step.state.text !== before.text;
        updateComposer({
          editor: step.state,
          exitArmed: false,
          ...(edited ? { suggestionsClosed: false, selected: 0 } : {}),
        });
      }
    },
    { isActive: overlay === null },
  );

  // ── Transcript split ───────────────────────────────────────────────────────
  const { settled, live } = useMemo(() => {
    const entries = state.conversation;
    const lastIsLive = entries.length > 0 && entries[entries.length - 1]!.streaming;
    const last = lastIsLive ? entries[entries.length - 1]! : null;
    const priorEntries = lastIsLive ? entries.slice(0, -1) : entries;
    return {
      // An intermediate turn that produced no prose is bookkeeping, not an
      // answer. Drawing its mark leaves a bare "✦" floating above the real
      // reply, which reads as Morrow having said nothing and meant it.
      settled: priorEntries.filter(
        (entry) => entry.role !== "assistant" || entry.text.trim().length > 0,
      ),
      // A turn that has started but produced no text yet is not something to
      // draw. Rendering the assistant's mark above an empty line reads as an
      // empty answer, which is worse than showing nothing while it thinks.
      live: last && last.text.length > 0 ? last : null,
    };
  }, [state.conversation]);

  const liveTools = useMemo(
    () => state.tools.slice(state.settledTools),
    [state.tools, state.settledTools],
  );

  // `<Static>` keys on identity, and a cleared transcript reuses indices. The
  // epoch makes a clear produce genuinely new keys so old rows are not replayed.
  const staticItems = useMemo(
    () => settled.map((entry, index) => ({ entry, key: `${state.epoch}:${index}` })),
    [settled, state.epoch],
  );

  const placeholder = streaming
    ? "  send a follow-up — it goes next"
    : exitArmed
      ? "  press ctrl+c again to exit"
      : "  ask, or / for commands, @ for files";

  return (
    <Box flexDirection="column" width={width}>
      <Static items={staticItems}>
        {(item) => (
          <SettledTurn entry={item.entry} key={item.key} unicode={unicode} width={width} />
        )}
      </Static>

      {state.plan.length > 0 && overlay === null && !pendingApproval ? (
        <PlanView expanded={expanded} plan={state.plan} unicode={unicode} width={width} />
      ) : null}

      {/* Only the work not yet written into scrollback. Earlier turns settled
          at their own boundaries and are in <Static> above; drawing them here
          too would show every tool of the run twice. */}
      {streaming && liveTools.length > 0 ? (
        <Box marginTop={1}>
          <WorkSummary expanded={expanded} streaming tools={liveTools} unicode={unicode} />
        </Box>
      ) : null}

      {state.reasoning ? (
        <ReasoningView
          elapsedMs={state.reasoningMs}
          expanded={reasoningOpen}
          text={state.reasoning}
          unicode={unicode}
          width={width}
        />
      ) : null}

      {!state.reasoning && reasoningOpen && state.lastReasoning ? (
        <ReasoningView
          elapsedMs={state.lastReasoningMs}
          expanded
          text={state.lastReasoning}
          unicode={unicode}
          width={width}
        />
      ) : null}

      {live ? (
        <Box flexDirection="column">
          {live.reasoning ? (
            <ReasoningView
              elapsedMs={live.reasoningMs}
              expanded={reasoningOpen}
              text={live.reasoning}
              unicode={unicode}
              width={width}
            />
          ) : null}
          <Box marginTop={1} flexDirection="row">
            <Text color={theme.accent}>{g.mark} </Text>
            <Box flexDirection="column" flexGrow={1}>
              <Markdown text={live.text} unicode={unicode} width={width - 2} />
            </Box>
          </Box>
        </Box>
      ) : null}

      {streaming && overlay === null && !pendingApproval ? (
        <Box marginTop={1}>
          <ActivityLine quiet={quiet} state={state} unicode={unicode} width={width} />
        </Box>
      ) : null}

      {!streaming && overlay === null && !pendingApproval ? (
        <Outcome state={state} unicode={unicode} width={width} />
      ) : null}

      {state.queuedMessages.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {state.queuedMessages.map((message, index) => (
            <Text color={theme.faint} key={index}>
              {`${g.pending} queued: ${message.slice(0, width - 12)}`}
            </Text>
          ))}
        </Box>
      ) : null}

      {pendingApproval ? (
        <Box marginTop={1}>
          <ApprovalPrompt approval={pendingApproval} />
        </Box>
      ) : null}

      {overlay?.kind === "model" ? (
        <ModelPicker
          currentId={overlay.currentId}
          items={overlay.items}
          onChoose={(item) => overlays?.close(item)}
          unicode={unicode}
          width={width}
        />
      ) : null}

      {overlay?.kind === "transcript" ? (
        <TranscriptOverlay
          entries={overlay.entries}
          onClose={() => overlays?.close(null)}
          unicode={unicode}
          width={width}
        />
      ) : null}

      {overlay?.kind === "select" ? (
        <SelectOverlay
          items={overlay.items}
          onChoose={(id) => overlays?.close(id)}
          subtitle={overlay.subtitle}
          title={overlay.title}
          unicode={unicode}
          width={width}
        />
      ) : null}

      {notices.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {notices.slice(-3).map((notice, index) => {
            const color =
              notice.level === "error" ? theme.danger : notice.level === "warn" ? theme.warning : theme.soft;
            const mark = notice.level === "error" ? g.fail : notice.level === "warn" ? "!" : g.pending;
            return (
              <Box key={index}>
                <Text color={color}>{`${mark} `}</Text>
                <Box flexGrow={1}>
                  <Text color={color} wrap="wrap">
                    {notice.text}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {overlay === null && !pendingApproval ? (
        <>
          <Box marginTop={1}>
            <StatusLine cwdLabel={cwdLabel} settings={settings} state={state} />
          </Box>

          <Composer
            busy={streaming}
            focused
            placeholder={placeholder}
            state={editor}
            width={width}
          />

          {paletteOpen ? (
            <Box marginTop={1}>
              <CommandPalette
                matches={paletteMatches}
                query={slashQuery ?? ""}
                selectedIndex={selected}
                width={width}
              />
            </Box>
          ) : null}

          {!paletteOpen && fileMatches.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {fileMatches.map((path, index) => (
                <Box key={path}>
                  <Text color={index === selected ? theme.accent : theme.faint}>
                    {index === selected ? `${g.chevron} ` : "  "}
                  </Text>
                  <Text color={index === selected ? theme.copy : theme.soft}>{path}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}

/**
 * Ink's key flags, as the editor's single `name`.
 *
 * Ink reports which key was pressed as a set of booleans; the editor wants one
 * name so its bindings read as a table. Anything without a name is literal text.
 */
function keyName(key: Parameters<Parameters<typeof useInput>[0]>[1], input: string): string | undefined {
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.return) return "return";
  if (key.backspace) return "backspace";
  // Ink's parser already separates these correctly: 0x7f and 0x08 are
  // `backspace`, and only the CSI `[3~` form is `delete`. Trusting that is
  // what makes Backspace delete leftwards on every terminal tested.
  if (key.delete) return "delete";
  if (key.tab) return "tab";
  if (key.escape) return "escape";
  return undefined;
}

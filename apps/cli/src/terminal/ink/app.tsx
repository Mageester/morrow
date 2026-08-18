import { Box, Static, Text, useInput, useStdout } from "ink";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { SlashCommand } from "../commands.js";
import type { ConversationEntry, TerminalState } from "../state.js";
import { CommandPalette, filterCommands } from "./palette.js";
import { StatusLine } from "./status-line.js";
import type { TerminalStore } from "./store.js";
import { glyphs, theme } from "./theme.js";
import { WorkSummary } from "./work-summary.js";

/**
 * The Morrow terminal shell.
 *
 * Hierarchy, top to bottom: the conversation, the work happening right now, the
 * composer. Detail is reachable, never resident. This is the same ordering the
 * web chat uses, for the same reason — the previous renderer gave tool cards,
 * activity lines and the answer equal weight, so a long turn buried its own
 * result.
 *
 * Settled turns render inside Ink's `<Static>`: they are written once, scroll
 * into native scrollback, and are never re-rendered on a later frame. Only the
 * live region below is repainted as tokens arrive, which is what keeps a
 * thousand-line session at a constant per-frame cost.
 */

export interface AppProps {
  store: TerminalStore;
  cwdLabel: string;
  unicode: boolean;
  /** Submits a composed message to the runtime. */
  onSubmit: (text: string) => void;
  /** Requests cancellation of the running task. */
  onInterrupt: () => void;
  /** The full slash-command surface, for the palette. */
  commands?: readonly SlashCommand[] | undefined;
  /** Resolves `@` file references. Returns candidate paths for a prefix. */
  onCompleteFile?: ((prefix: string) => string[]) | undefined;
}

function useTerminalState(store: TerminalStore): TerminalState {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.state;
}

/** A finished turn. Rendered once, then owned by the terminal's scrollback. */
function SettledTurn({ entry, unicode }: { entry: ConversationEntry; unicode: boolean }) {
  const g = glyphs(unicode);
  if (entry.role === "user") {
    // Deliberately not the composer's "> ": a settled message and the prompt
    // you are typing into must not look identical, or the transcript reads as
    // though the last line is still editable.
    return (
      <Box marginTop={1}>
        <Text color={theme.faint}>{unicode ? "│ " : "| "}</Text>
        <Text color={theme.soft}>{entry.text}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.accent}>{g.mark} </Text>
      <Box flexDirection="column">
        <Text color={theme.copy}>{entry.text}</Text>
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
}: AppProps) {
  const state = useTerminalState(store);
  const { stdout } = useStdout();
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(0);
  /** Two consecutive Ctrl+C exits; one only interrupts. */
  const [interruptArmed, setInterruptArmed] = useState(false);
  const g = glyphs(unicode);

  // The palette opens on a leading "/" and the file picker on the token after
  // an "@". Both are derived from the draft rather than held as modes, so there
  // is no state to get stuck in — deleting the character closes them.
  const slashQuery = draft.startsWith("/") ? draft.slice(1) : null;
  const paletteOpen = slashQuery !== null && !slashQuery.includes(" ");
  const fileToken = /(?:^|\s)@([^\s]*)$/.exec(draft)?.[1] ?? null;
  const fileMatches = useMemo(
    () => (fileToken !== null && onCompleteFile ? onCompleteFile(fileToken).slice(0, 10) : []),
    [fileToken, onCompleteFile],
  );
  const paletteMatches = useMemo(
    () => (paletteOpen ? filterCommands(commands, slashQuery ?? "") : []),
    [paletteOpen, commands, slashQuery],
  );

  const streaming = state.status === "streaming";

  // Everything except a still-streaming assistant turn is settled and can be
  // handed to <Static>. Splitting here is what stops finished turns from
  // re-rendering on every token.
  const { settled, live } = useMemo(() => {
    const entries = state.conversation;
    const lastIsLive = entries.length > 0 && entries[entries.length - 1]!.streaming;
    return {
      settled: lastIsLive ? entries.slice(0, -1) : entries,
      live: lastIsLive ? entries[entries.length - 1]! : null,
    };
  }, [state.conversation]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setSelected(0);
    onSubmit(text);
  }, [draft, onSubmit]);

  /** Completes the open palette or file picker into the draft. */
  const accept = useCallback((): boolean => {
    if (paletteOpen && paletteMatches.length > 0) {
      const chosen = paletteMatches[Math.min(selected, paletteMatches.length - 1)]!.command;
      setDraft(`/${chosen.name}${chosen.arg ? " " : ""}`);
      setSelected(0);
      return true;
    }
    if (fileToken !== null && fileMatches.length > 0) {
      const chosen = fileMatches[Math.min(selected, fileMatches.length - 1)]!;
      setDraft((value) => value.replace(/@[^\s]*$/, `@${chosen} `));
      setSelected(0);
      return true;
    }
    return false;
  }, [paletteOpen, paletteMatches, fileToken, fileMatches, selected]);

  const suggestionCount = paletteOpen ? paletteMatches.length : fileMatches.length;

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      setExpanded((value) => !value);
      return;
    }
    if (key.ctrl && input === "c") {
      // First Ctrl+C stops the work; a second, with nothing running, exits.
      // A single keystroke never discards a session someone is mid-way through.
      if (streaming) {
        onInterrupt();
        setInterruptArmed(false);
        return;
      }
      if (draft) {
        setDraft("");
        return;
      }
      if (interruptArmed) {
        process.exit(0);
      }
      setInterruptArmed(true);
      setTimeout(() => setInterruptArmed(false), 1500);
      return;
    }
    if (key.escape) {
      setDraft("");
      setSelected(0);
      return;
    }
    if (suggestionCount > 0 && (key.upArrow || key.downArrow)) {
      setSelected((value) => {
        const next = key.downArrow ? value + 1 : value - 1;
        return Math.max(0, Math.min(next, suggestionCount - 1));
      });
      return;
    }
    if (key.tab) {
      accept();
      return;
    }
    if (key.return) {
      // Enter completes an open suggestion first, then sends on the next press.
      if (accept()) return;
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((value) => value.slice(0, -1));
      setSelected(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft((value) => value + input);
      setSelected(0);
    }
  });

  // `?? 80` is not enough: a terminal that reports zero columns (a pty with no
  // winsize, a CI capture, some multiplexers) would set the frame width to 0
  // and wrap every single character onto its own line. Anything falsy falls
  // back, and the floor keeps a hostile width from collapsing the layout.
  const width = Math.max(40, stdout?.columns || 80);

  return (
    <Box flexDirection="column" width={width}>
      <Static items={settled}>
        {(entry, index) => <SettledTurn entry={entry} key={index} unicode={unicode} />}
      </Static>

      {state.tools.length > 0 ? (
        <Box marginTop={1}>
          <WorkSummary expanded={expanded} tools={state.tools} unicode={unicode} />
        </Box>
      ) : null}

      {live ? (
        <Box marginTop={1} flexDirection="row">
          <Text color={theme.accent}>{g.mark} </Text>
          <Box flexDirection="column">
            <Text color={theme.copy}>{live.text}</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <StatusLine cwdLabel={cwdLabel} state={state} />
      </Box>

      <Box>
        <Text color={streaming ? theme.faint : theme.accent}>{"> "}</Text>
        <Text color={theme.copy}>{draft}</Text>
        <Text color={theme.faint}>
          {draft
            ? ""
            : streaming
              ? "working — ctrl+c to stop"
              : interruptArmed
                ? "press ctrl+c again to exit"
                : "message Morrow   / commands   @ files"}
        </Text>
      </Box>

      {paletteOpen ? (
        <Box marginTop={1}>
          <CommandPalette commands={commands} query={slashQuery ?? ""} selectedIndex={selected} width={width} />
        </Box>
      ) : null}

      {!paletteOpen && fileToken !== null && fileMatches.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {fileMatches.map((path, index) => (
            <Box key={path}>
              <Text color={index === selected ? theme.accent : theme.faint}>
                {index === selected ? "❯ " : "  "}
              </Text>
              <Text color={index === selected ? theme.copy : theme.soft}>{path}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

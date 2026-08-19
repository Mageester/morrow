import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { ConversationEntry } from "../state.js";
import { rows } from "./reasoning-view.js";
import { glyphs, theme } from "./theme.js";

/**
 * Look back through this conversation, and search it.
 *
 * Settled turns are written into Ink's `<Static>`, which hands them to the
 * terminal's own scrollback and never redraws them. That is what keeps a
 * thousand-turn session as cheap to render as an empty one, and it is also why
 * the shell has no scroll of its own: there is nothing in the app holding the
 * transcript in a form it could scroll.
 *
 * Rather than give that up — virtualizing the live transcript is the trade,
 * and it is a large one — the reading surface is an overlay. Overlays are
 * ordinary live-rendered components, so scrolling and searching inside one
 * costs nothing while it is closed, which is almost always.
 *
 * It opens at the bottom, on the most recent turn, because that is where
 * someone reading back starts from.
 */

interface Line {
  text: string;
  /** Marks the header row that opens a turn. */
  speaker?: "you" | "morrow";
}

/** Flatten the transcript into the rows a reader actually scrolls through. */
export function transcriptLines(
  entries: readonly ConversationEntry[],
  width: number,
): Line[] {
  const out: Line[] = [];
  for (const entry of entries) {
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const body = entry.text.trim();
    if (!body) continue;
    if (out.length > 0) out.push({ text: "" });
    out.push({ text: entry.role === "user" ? "you" : "morrow", speaker: entry.role === "user" ? "you" : "morrow" });
    for (const row of rows(body, Math.max(20, width - 2))) out.push({ text: row });
  }
  return out;
}

/** Row indexes containing the query, in order. */
export function matchRows(lines: readonly Line[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.speaker === undefined && line.text.toLowerCase().includes(needle)) hits.push(index);
  }
  return hits;
}

/** Keep an index inside a list, wrapping at both ends. */
export function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}

const VISIBLE_ROWS = 16;

export function TranscriptOverlay({
  entries,
  unicode,
  width,
  onClose,
}: {
  entries: readonly ConversationEntry[];
  unicode: boolean;
  width: number;
  onClose: () => void;
}) {
  const g = glyphs(unicode);
  const lines = useMemo(() => transcriptLines(entries, width), [entries, width]);
  const bottom = Math.max(0, lines.length - VISIBLE_ROWS);

  const [offset, setOffset] = useState(bottom);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hit, setHit] = useState(0);

  const hits = useMemo(() => matchRows(lines, query), [lines, query]);

  const clamp = (value: number) => Math.max(0, Math.min(bottom, value));
  /** Put a matched row a third of the way down, so its context is visible. */
  const centre = (row: number) => clamp(row - Math.floor(VISIBLE_ROWS / 3));

  const jump = (delta: number) => {
    if (hits.length === 0) return;
    const next = wrapIndex(hit + delta, hits.length);
    setHit(next);
    setOffset(centre(hits[next]!));
  };

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setQuery("");
        return;
      }
      if (key.return) {
        setSearching(false);
        if (hits.length > 0) {
          setHit(0);
          setOffset(centre(hits[0]!));
        }
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((value) => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setQuery((value) => value + input);
      return;
    }

    if (key.escape || (key.ctrl && input === "c") || input === "q") {
      onClose();
      return;
    }
    if (input === "/") {
      setSearching(true);
      setQuery("");
      return;
    }
    if (input === "n") {
      jump(1);
      return;
    }
    if (input === "N") {
      jump(-1);
      return;
    }
    if (key.upArrow || input === "k") setOffset((value) => clamp(value - 1));
    else if (key.downArrow || input === "j") setOffset((value) => clamp(value + 1));
    else if (key.pageUp) setOffset((value) => clamp(value - VISIBLE_ROWS));
    else if (key.pageDown) setOffset((value) => clamp(value + VISIBLE_ROWS));
    else if (input === "g") setOffset(0);
    else if (input === "G") setOffset(bottom);
  });

  const visible = lines.slice(offset, offset + VISIBLE_ROWS);
  const atTop = offset === 0;
  const atBottom = offset >= bottom;
  const position = lines.length === 0
    ? "empty"
    : atTop && atBottom
      ? "all of it"
      : `${Math.min(lines.length, offset + VISIBLE_ROWS)} of ${lines.length} lines`;

  return (
    <Box borderColor={theme.border} borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Box>
        <Text bold color={theme.accent}>
          Conversation
        </Text>
        <Text color={theme.faint}>{`  ${position}`}</Text>
        {query && !searching ? (
          <Text color={hits.length > 0 ? theme.soft : theme.warning}>
            {`  ${hits.length > 0 ? `${hit + 1}/${hits.length}` : "no"} match${hits.length === 1 ? "" : "es"} for "${query}"`}
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="column" paddingY={1}>
        {visible.map((line, index) => {
          const row = offset + index;
          const isHit = hits.includes(row);
          if (line.speaker) {
            return (
              <Text bold color={line.speaker === "you" ? theme.soft : theme.accent} key={row}>
                {line.speaker === "you" ? `${g.quote} you` : `${g.mark} morrow`}
              </Text>
            );
          }
          return (
            <Text
              color={isHit ? theme.copy : theme.soft}
              key={row}
              {...(isHit ? { backgroundColor: theme.selectedBg } : {})}
            >
              {line.text || " "}
            </Text>
          );
        })}
        {lines.length === 0 ? <Text color={theme.faint}>Nothing has been said in this session yet.</Text> : null}
      </Box>

      <Box>
        {searching ? (
          <Text color={theme.copy}>{`/${query}`}</Text>
        ) : (
          <Text color={theme.faint}>
            {`${g.chevron} ↑↓ scroll  · / search  · n next  · g top  · esc close`}
          </Text>
        )}
      </Box>
    </Box>
  );
}

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { SelectItem } from "./overlay-store.js";
import { fuzzyScore } from "./palette.js";
import { glyphs, theme } from "./theme.js";

/**
 * The one list picker.
 *
 * Sessions, providers, presets — anything a command needs a choice from.
 * Having one of these rather than one per command is what stops half the
 * commands from degenerating into "here is a list, now retype the id", which
 * is what the previous shell did everywhere except `/model`.
 *
 * Disabled rows stay visible with the reason attached. Hiding a provider
 * because it has no credentials answers the wrong question: the person is
 * looking for it precisely because they expect it to be there.
 */

const VISIBLE_ROWS = 10;

export interface SelectOverlayProps {
  title: string;
  subtitle?: string | undefined;
  items: readonly SelectItem[];
  unicode: boolean;
  width: number;
  onChoose: (id: string | null) => void;
}

export function SelectOverlay({ title, subtitle, items, unicode, width, onChoose }: SelectOverlayProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => Math.max(0, items.findIndex((item) => item.current)));
  const g = glyphs(unicode);

  const matches = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [...items];
    return items
      .map((item) => ({
        item,
        score: Math.max(fuzzyScore(trimmed, item.label), fuzzyScore(trimmed, item.hint ?? "") / 4),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item);
  }, [items, query]);

  const index = Math.min(selected, Math.max(0, matches.length - 1));
  const active = matches[index];

  const start = Math.max(0, Math.min(index - Math.floor(VISIBLE_ROWS / 2), matches.length - VISIBLE_ROWS));
  const visible = matches.slice(start, start + VISIBLE_ROWS);

  useInput((input, key) => {
    if (key.escape) return void onChoose(null);
    if (key.return) {
      // A disabled row is shown for context, not for choosing. Answering with
      // it would apply a route that cannot work.
      if (!active || active.disabled) return;
      return void onChoose(active.id);
    }
    if (key.upArrow) return setSelected(() => Math.max(0, index - 1));
    if (key.downArrow) return setSelected(() => Math.min(matches.length - 1, index + 1));
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setSelected(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((value) => value + input);
      setSelected(0);
    }
  });

  const labelWidth = Math.min(30, Math.max(8, ...visible.map((item) => item.label.length)));

  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box>
        <Text color={theme.accent}>{g.mark} </Text>
        <Text color={theme.copy}>{title}</Text>
        <Text color={theme.faint}>
          {"   "}
          {matches.length} of {items.length}
        </Text>
      </Box>
      {subtitle ? (
        <Box paddingLeft={2}>
          <Text color={theme.faint}>{subtitle}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.faint}>{g.chevron} </Text>
        <Text color={theme.copy}>{query}</Text>
        {query.length === 0 ? <Text color={theme.faint}>type to filter</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {visible.map((item, offset) => {
          const absolute = start + offset;
          const isSelected = absolute === index;
          return (
            <Box key={item.id}>
              <Text color={isSelected ? theme.accent : theme.faint}>{isSelected ? `${g.chevron} ` : "  "}</Text>
              <Text
                bold={isSelected}
                color={item.disabled ? theme.faint : isSelected ? theme.copy : theme.soft}
              >
                {item.label.padEnd(labelWidth)}
              </Text>
              {item.current ? <Text color={theme.success}> {g.done}</Text> : <Text>{"  "}</Text>}
              {item.hint ? <Text color={theme.faint}>{`  ${item.hint}`}</Text> : null}
            </Box>
          );
        })}
        {matches.length === 0 ? <Text color={theme.faint}>{"  nothing matches that filter"}</Text> : null}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.faint}>↑↓ move   ⏎ select   esc cancel</Text>
      </Box>
    </Box>
  );
}

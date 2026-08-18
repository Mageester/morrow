import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { filterModelItems, formatContextWindow, type ModelPickerItem } from "../model-picker.js";
import { glyphs, theme } from "./theme.js";

/**
 * The `/model` picker.
 *
 * The selection logic is not reimplemented here: `filterModelItems` and
 * `formatContextWindow` are the same pure functions the previous renderer used
 * and the existing suite covers. This file owns presentation only, which is the
 * split that let the shell be replaced without re-litigating what a model row
 * means.
 *
 * A detail panel tracks the highlighted row rather than waiting for a commit,
 * because the decision people actually make here — "is this one available, how
 * big is its window, what does it cost" — is the thing an id-only list hides.
 */

const VISIBLE_ROWS = 10;

export interface ModelPickerProps {
  items: ModelPickerItem[];
  currentId: string | undefined;
  unicode: boolean;
  width: number;
  onChoose: (item: ModelPickerItem | null) => void;
}

/** Provider · context · price, each omitted when genuinely unknown rather than
 *  filled with a plausible-looking placeholder. */
function factLine(item: ModelPickerItem): string {
  const facts: string[] = [];
  if (item.providerId) facts.push(item.providerId);
  const window = item.budget?.contextWindowTokens ?? item.status?.model.contextWindow ?? null;
  if (window !== null) facts.push(formatContextWindow(window));
  const pricing = item.status?.model.pricing;
  if (pricing) facts.push(`$${pricing.inputUsdPerMillion}/$${pricing.outputUsdPerMillion} per M`);
  else if (item.status?.model.costClass) facts.push(item.status.model.costClass);
  return facts.join("  ·  ");
}

function Detail({ item, unicode }: { item: ModelPickerItem; unicode: boolean }) {
  const g = glyphs(unicode);
  if (item.kind === "custom") {
    return (
      <Text color={theme.faint}>
        Sends this id to the provider as typed. Unknown ids fail on the next request, not here.
      </Text>
    );
  }
  if (item.kind === "auto") {
    return <Text color={theme.faint}>Lets the active preset choose the route for each request.</Text>;
  }
  const model = item.status?.model;
  const window = item.budget?.contextWindowTokens ?? model?.contextWindow ?? null;
  const confidence = item.budget?.contextWindowConfidence;
  const reasoning = item.reasoning.control === "none" ? null : item.reasoning.control;
  return (
    <Box flexDirection="column">
      {!item.available && (
        <Text color={theme.warning}>
          {g.fail} Unavailable — {item.status?.availabilityReason ?? `provider "${item.providerId}" is not configured`}
        </Text>
      )}
      <Text color={theme.soft}>
        {item.id}
        {item.isDefault ? "   (provider default)" : ""}
      </Text>
      <Text color={theme.faint}>
        context {window === null ? "unknown" : formatContextWindow(window)}
        {confidence ? ` (${confidence})` : ""}
        {reasoning ? `   ·   reasoning: ${reasoning}` : ""}
      </Text>
    </Box>
  );
}

export function ModelPicker({ items, currentId, unicode, width, onChoose }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const g = glyphs(unicode);

  const matches = useMemo(() => filterModelItems(query, items), [query, items]);
  const active = matches[Math.min(selected, Math.max(0, matches.length - 1))];

  // A window that follows the cursor: the registry runs to dozens of models and
  // a list that scrolls off the top of a terminal cannot be navigated.
  const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), matches.length - VISIBLE_ROWS));
  const visible = matches.slice(start, start + VISIBLE_ROWS);

  useInput((input, key) => {
    if (key.escape) return void onChoose(null);
    if (key.return) return void (active ? onChoose(active) : onChoose(null));
    if (key.upArrow) return setSelected((v) => Math.max(0, v - 1));
    if (key.downArrow) return setSelected((v) => Math.min(matches.length - 1, v + 1));
    if (key.backspace || key.delete) {
      setQuery((v) => v.slice(0, -1));
      setSelected(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((v) => v + input);
      setSelected(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box>
        <Text color={theme.accent}>{g.mark} </Text>
        <Text color={theme.copy}>Select a model</Text>
        <Text color={theme.faint}>
          {"   "}
          {matches.length} of {items.length}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.faint}>{g.chevron} </Text>
        <Text color={theme.copy}>{query}</Text>
        {query.length === 0 && <Text color={theme.faint}>type to filter</Text>}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {visible.map((item, offset) => {
          // Position, not identity. The same model id legitimately appears
          // under two providers (deepseek-v4-flash is served by both deepseek
          // and opencode-zen), so keying on the id printed React duplicate-key
          // warnings straight into the terminal and dropped one of the rows.
          // `indexOf` had the same flaw: it found the first match, so the
          // second copy could never be highlighted.
          const index = start + offset;
          const isSelected = index === Math.min(selected, matches.length - 1);
          const isCurrent = item.id === currentId || (item.kind === "auto" && currentId === undefined);
          return (
            <Box key={`${item.kind}:${item.providerId ?? "-"}:${item.id}:${index}`}>
              <Text color={isSelected ? theme.accent : theme.faint}>{isSelected ? `${g.chevron} ` : "  "}</Text>
              <Text
                bold={isSelected}
                color={!item.available ? theme.faint : isSelected ? theme.copy : theme.soft}
              >
                {item.label}
              </Text>
              {isCurrent && <Text color={theme.success}> {g.done}</Text>}
              <Text color={theme.faint}>{"  "}{factLine(item)}</Text>
            </Box>
          );
        })}
        {matches.length === 0 && <Text color={theme.faint}>  No model matches that filter.</Text>}
      </Box>

      {active && (
        <Box marginTop={1} flexDirection="column">
          <Detail item={active} unicode={unicode} />
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.faint}>↑↓ move   ⏎ select   esc cancel</Text>
      </Box>
    </Box>
  );
}

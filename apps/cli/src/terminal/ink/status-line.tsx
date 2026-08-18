import { Box, Text } from "ink";
import type { TerminalState } from "../state.js";
import { theme } from "./theme.js";

/**
 * One quiet line above the composer: where you are, what you're talking to, and
 * how much of the window is gone.
 *
 * Every figure here is one the runtime actually reported. Nothing is estimated
 * to fill the line — an unknown context window renders as nothing rather than
 * as a reassuring percentage Morrow cannot stand behind.
 */
export function StatusLine({ state, cwdLabel }: { state: TerminalState; cwdLabel: string }) {
  const routing = state.routing;
  const context = state.contextUsage;

  const model = routing?.model ?? null;
  const used = context?.usedTokens ?? null;
  // `contextLimitTokens: null` is the registry saying it could not assert the
  // window. That is not the same as a large window, and it must not fall back
  // to `maxTokens` (a budget, not a capacity) — an unknown window renders as
  // nothing rather than as a percentage Morrow cannot stand behind.
  const capacity = context?.contextLimitTokens ?? null;
  // Before a request has consumed anything there is nothing to report, and
  // "0% context" reads as a measurement rather than as the absence of one.
  // Same rule as the window itself: say nothing rather than something hollow.
  const ratio = used !== null && used > 0 && capacity !== null && capacity > 0
    ? Math.min(1, used / capacity)
    : null;
  // Real usage that rounds to zero is shown as "<1%", never as "0%" — the
  // latter reads as "nothing consumed", which is the one thing it is not.
  const percentLabel = ratio === null
    ? null
    : ratio < 0.01
      ? "<1%"
      : `${Math.round(ratio * 100)}%`;

  const branch = state.git?.branch ?? null;
  const dirty = state.git?.dirty === true;

  return (
    <Box>
      <Text color={theme.faint}>{cwdLabel}</Text>
      {branch ? (
        <Text color={theme.faint}>
          {"  "}
          {branch}
          {dirty ? "*" : ""}
        </Text>
      ) : null}
      {model ? <Text color={theme.faint}>{"  "}{model}</Text> : null}
      {percentLabel !== null ? (
        <Text color={(ratio ?? 0) >= 0.9 ? theme.warning : theme.faint}>
          {"  "}
          {percentLabel} context
        </Text>
      ) : null}
    </Box>
  );
}

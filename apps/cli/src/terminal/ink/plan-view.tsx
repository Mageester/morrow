import { Box, Text } from "ink";
import type { PlanEntry } from "../state.js";
import { glyphs, theme } from "./theme.js";

/**
 * The checklist for the task in flight.
 *
 * Only ever a plan the model wrote, through `write_plan`. The reducer's `plan`
 * used to be fed by an internal three-step scaffold — "Analyze & Plan / Read
 * Workspace / Generate Answer" — created identically on every task, and the
 * adapter dropped it precisely because painting those three rows over every
 * piece of work says nothing. A panel is worth the space only when its
 * contents are about *this* job.
 *
 * A long plan is windowed rather than truncated: what is done collapses to a
 * count, what is next stays visible. The running step is always on screen,
 * because it is the row the whole panel exists to show.
 */

/** Steps shown after the running one. Enough to see where this is going. */
const LOOKAHEAD = 3;

function marker(status: PlanEntry["status"], unicode: boolean): { glyph: string; colour: string } {
  const g = glyphs(unicode);
  switch (status) {
    case "completed":
      return { glyph: g.done, colour: theme.success };
    case "running":
      return { glyph: g.run, colour: theme.accent };
    case "failed":
      return { glyph: g.fail, colour: theme.danger };
    case "skipped":
      return { glyph: unicode ? "–" : "-", colour: theme.faint };
    default:
      return { glyph: unicode ? "○" : "o", colour: theme.faint };
  }
}

export interface PlanWindow {
  /** Finished steps folded away above the window. */
  doneBefore: number;
  visible: PlanEntry[];
  /** Steps not yet reached, below the window. */
  moreAfter: number;
}

/** Choose the slice worth drawing: the active step, with a little context. */
export function planWindow(plan: readonly PlanEntry[], expanded: boolean): PlanWindow {
  if (expanded || plan.length === 0) {
    return { doneBefore: 0, visible: [...plan], moreAfter: 0 };
  }
  const active = plan.findIndex((step) => step.status === "running" || step.status === "failed");
  // No step is running: the plan is either untouched or finished. Either way
  // the head of the list is the useful end.
  const start = active <= 0 ? 0 : active;
  const end = Math.min(plan.length, start + 1 + LOOKAHEAD);
  return {
    doneBefore: start,
    visible: plan.slice(start, end),
    moreAfter: plan.length - end,
  };
}

export function PlanView({
  plan,
  expanded,
  unicode,
  width,
}: {
  plan: readonly PlanEntry[];
  /** Ctrl+O also opens the plan: one key for "show me the detail". */
  expanded: boolean;
  unicode: boolean;
  width: number;
}) {
  if (plan.length === 0) return null;
  const { doneBefore, visible, moreAfter } = planWindow(plan, expanded);
  const done = plan.filter((step) => step.status === "completed").length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.soft}>Plan</Text>
        <Text color={theme.faint}>{`  ${done}/${plan.length}`}</Text>
        {!expanded && (doneBefore > 0 || moreAfter > 0) ? (
          <Text color={theme.faint}>{`  ${glyphs(unicode).chevron} ctrl+o for all`}</Text>
        ) : null}
      </Box>
      {doneBefore > 0 ? (
        <Box paddingLeft={2}>
          <Text color={theme.faint}>{`${doneBefore} done`}</Text>
        </Box>
      ) : null}
      {visible.map((step) => {
        const { glyph, colour } = marker(step.status, unicode);
        return (
          <Box key={step.id} paddingLeft={2} width={width}>
            <Text color={colour}>{`${glyph} `}</Text>
            <Text color={step.status === "running" ? theme.copy : theme.soft} wrap="truncate-end">
              {step.title}
            </Text>
          </Box>
        );
      })}
      {moreAfter > 0 ? (
        <Box paddingLeft={2}>
          <Text color={theme.faint}>{`+${moreAfter} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

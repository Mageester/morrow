import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { ActivityKind } from "../events.js";
import type { TerminalState, ToolCard } from "../state.js";
import { theme } from "./theme.js";
import { phrase } from "./tool-verbs.js";

/**
 * The one line that says Morrow is still alive.
 *
 * Before this existed the shell went visually dead the moment it mattered
 * most. Nothing rendered between hitting enter and the first token; once tools
 * started, the collapsed work summary fell through to a green tick and the
 * word "completed" whenever no tool happened to be mid-flight — which is every
 * second the model spends generating. A running task therefore read as a
 * finished one, and the only rational response was to assume it had hung.
 *
 * The division of labour with `WorkSummary` is deliberate and worth keeping:
 * this line is the present tense — what is happening *right now* — and the
 * work summary is the past tense, the record of what this turn has already
 * done. Neither should try to be the other.
 *
 * Every figure is one the runtime reported or the clock knows. Elapsed is wall
 * time since the turn began; tokens appear only once the provider has actually
 * reported some. Nothing here is estimated to keep the line looking busy.
 */


/** What each recorded activity means while it is still in progress. */
const PRESENT_ACTIVITY: Record<ActivityKind, string> = {
  inspecting: "Inspecting",
  reading: "Reading",
  searching: "Searching",
  planning: "Planning",
  running: "Running",
  applying_patch: "Editing",
  verifying: "Verifying",
  waiting: "Waiting",
  retrying: "Retrying",
  delegating: "Delegating",
  completing: "Finishing",
};

function runningLabel(tool: ToolCard): string {
  return phrase(tool.name, tool.purpose, "present");
}

/**
 * What to say Morrow is doing, in order of how specific the answer is: a tool
 * actually in flight, else the last thing it recorded doing, else "Thinking"
 * (nothing visible yet) or "Responding" (prose is on screen right now).
 *
 * Before this, the fallback was always "Thinking" — including while real
 * assistant text was actively streaming onto the screen below this very
 * line. That reads as a contradiction a reader can see for themselves: the
 * words are right there, so the line claiming Morrow is still thinking looks
 * stuck or wrong, even though nothing has actually failed.
 */
export function activityLabel(state: TerminalState, responding = false): string {
  for (let index = state.tools.length - 1; index >= 0; index -= 1) {
    const tool = state.tools[index];
    if (tool?.status === "running") return runningLabel(tool);
  }
  const latest = state.activity[state.activity.length - 1];
  if (latest) {
    const label = PRESENT_ACTIVITY[latest.kind] ?? "Working";
    return latest.detail ? `${label} ${latest.detail}` : label;
  }
  return responding ? "Responding" : "Thinking";
}

/** Output tokens per second, once there is enough elapsed time for a rate to
 *  mean anything — under a second, a token count divided by a fraction of a
 *  second swings wildly and reads as noise, not a measurement. */
export function tokenRateLabel(tokens: number | undefined, elapsedMs: number): string | null {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (elapsedMs < 1000) return null;
  const perSecond = tokens / (elapsedMs / 1000);
  return `${perSecond >= 10 ? Math.round(perSecond) : perSecond.toFixed(1)} tok/s`;
}

/** Wall time, at the granularity a person reads it. */
export function elapsedLabel(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Output tokens so far, as a figure that changes often enough to read as
 *  progress. Only ever what the provider reported. */
export function tokenLabel(tokens: number | undefined): string | null {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens < 1000) return `${tokens} tokens`;
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
}

const SPINNER_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_ASCII = ["|", "/", "-", "\\"];

/** Fast enough to read as motion, slow enough that a long turn is not a
 *  hundred re-renders a second. Only this subtree re-renders on a tick: the
 *  timer state is local, so the transcript and the composer are untouched. */
const TICK_MS = 120;

export function ActivityLine({
  state,
  unicode,
  width,
  /** The runtime has reported that it cannot see progress. Said here, softly,
   *  rather than as a separate amber notice contradicting this very line. */
  quiet = false,
  /** True once real assistant prose is visible on screen for this turn — see
   *  app.tsx's `live`. Distinguishes "Responding" from "Thinking" so the line
   *  never claims Morrow is still thinking while its words are on screen. */
  responding = false,
  /** Injected by tests so a frame can be asserted without waiting on a clock. */
  now = Date.now,
}: {
  state: TerminalState;
  unicode: boolean;
  width: number;
  quiet?: boolean;
  responding?: boolean;
  now?: () => number;
}) {
  const active = state.status === "streaming";
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // The turn's start is held in a ref rather than state: writing it during
  // render would loop, and it must survive the ticks it is measured against.
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setFrame(0);
      setElapsed(0);
      return;
    }
    startedAt.current = now();
    setElapsed(0);
    const timer = setInterval(() => {
      setFrame((value) => value + 1);
      if (startedAt.current !== null) setElapsed(now() - startedAt.current);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active, now]);

  if (!active) return null;

  const spinner = unicode ? SPINNER_UNICODE : SPINNER_ASCII;
  const dot = unicode ? "·" : "-";
  const hint = "esc to interrupt";
  const chips = [
    elapsedLabel(elapsed),
    tokenLabel(state.activeUsage?.outputTokens),
    tokenRateLabel(state.activeUsage?.outputTokens, elapsed),
    quiet ? "no new output yet" : null,
  ].filter((chip): chip is string => chip !== null);
  const meta = chips.length > 0 ? ` ${dot} ${chips.join(` ${dot} `)}` : "";

  // The label yields before the hint does. A long tool target must never push
  // "esc to interrupt" off the line — that hint is the one piece of the line a
  // stuck user is looking for.
  const room = Math.max(8, width - hint.length - meta.length - 4);
  const label = truncate(activityLabel(state, responding), room);

  return (
    <Box>
      <Text color={quiet ? theme.warning : theme.accent}>{spinner[frame % spinner.length]} </Text>
      <Text color={quiet ? theme.soft : theme.copy}>{label}</Text>
      {meta ? <Text color={theme.faint}>{meta}</Text> : null}
      <Text color={theme.faint}>
        {"  "}
        {hint}
      </Text>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

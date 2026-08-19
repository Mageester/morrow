import { Box, Text } from "ink";
import type { SessionStatus, TerminalState } from "../state.js";
import { glyphs, theme } from "./theme.js";

/**
 * How a turn ended, when it did not end with an answer.
 *
 * The shell used to render nothing at all here. `task.failed` set `status`
 * and `lastError` in the reducer and no component ever read either, so a task
 * that died on a provider error left the transcript showing a green tick from
 * the last tool that happened to succeed, and then the prompt back. The plain
 * line surface printed "Task failed: …" the whole time; the shell people
 * actually use printed nothing. A user's only signal was an answer that never
 * arrived.
 *
 * Every non-answer ending goes through here, because they are all the same
 * question from the reader's side — is it still going, and what do I do now?
 *
 * Cancelling is deliberately quiet. The user pressed the key; telling them
 * loudly what they just did is noise, and colouring their own choice like a
 * failure is worse.
 */

interface Ending {
  mark: "fail" | "warn" | "quiet";
  title: string;
  /** Commands worth offering, in the order they are likely wanted. */
  next: string[];
}

const ENDINGS: Partial<Record<SessionStatus, Ending>> = {
  failed: { mark: "fail", title: "Task failed", next: ["/retry to run it again", "/output for the full log"] },
  stalled: {
    mark: "warn",
    title: "Task stalled",
    next: ["/retry to run it again", "/output for the full log"],
  },
  "budget-reached": {
    mark: "warn",
    title: "Turn budget reached",
    next: ["/continue to carry on", "/output for the full log"],
  },
  cancelled: { mark: "quiet", title: "Stopped", next: ["/retry to run it again"] },
  interrupted: { mark: "quiet", title: "Stopped", next: ["/retry to run it again"] },
};

export function outcomeFor(status: SessionStatus): Ending | null {
  return ENDINGS[status] ?? null;
}

export function Outcome({
  state,
  unicode,
  width,
}: {
  state: TerminalState;
  unicode: boolean;
  width: number;
}) {
  const ending = outcomeFor(state.status);
  if (!ending) return null;
  const g = glyphs(unicode);
  const colour =
    ending.mark === "fail" ? theme.danger : ending.mark === "warn" ? theme.warning : theme.faint;
  const mark = ending.mark === "fail" ? g.fail : ending.mark === "warn" ? "!" : g.pending;
  // The reason the runtime gave. Never invented: an ending with no message
  // renders as the title alone rather than as a guess at what went wrong.
  const reason = state.lastError?.trim();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={colour}>{`${mark} `}</Text>
        <Text bold color={colour}>
          {ending.title}
        </Text>
      </Box>
      {reason ? (
        <Box paddingLeft={2} width={width}>
          <Text color={theme.soft} wrap="wrap">
            {reason}
          </Text>
        </Box>
      ) : null}
      <Box paddingLeft={2}>
        <Text color={theme.faint}>{ending.next.join(`  ${unicode ? "\u00b7" : "-"}  `)}</Text>
      </Box>
    </Box>
  );
}

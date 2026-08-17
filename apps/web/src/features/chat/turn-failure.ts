/**
 * Failure parsing for an assistant turn.
 *
 * When a run fails, the orchestrator appends the raw reason to the assistant
 * message as a trailing `[Error: …]` block and marks the message `failed`. That
 * is the right thing to persist — it is the truth, and it must not be lost —
 * but rendering it inline leaves the conversation ending on a bare stack-trace
 * fragment like `[Error: Provider emitted unsupported chunk type text-delta]`.
 *
 * This module separates the two halves so the transcript can show the prose the
 * model did produce, a plain-language headline for what went wrong, and the
 * exact technical text behind a disclosure. Nothing is discarded and nothing is
 * softened into a claim the runtime did not make: the headline is derived only
 * from the reason string, and the reason string is always shown verbatim under
 * Details.
 */

export type FailureCategory = "provider" | "tool" | "permission" | "network" | "runtime";

export interface ParsedTurnFailure {
  /** The message content with the trailing error block removed. */
  content: string;
  /** The raw reason exactly as the runtime recorded it. */
  reason: string;
  category: FailureCategory;
  /** Short plain-language statement of what failed. */
  headline: string;
}

/** Matches the trailing `[Error: …]` block the orchestrator appends. */
const TRAILING_ERROR = /\n*\[Error:\s*([\s\S]*?)\]\s*$/;

const PERMISSION = /\b(permission|approval|denied|not allowed|forbidden|unauthori[sz]ed|403)\b/i;
const NETWORK = /\b(network|offline|fetch failed|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed? ?out|dns)\b/i;
const PROVIDER = /\b(provider|upstream|stream|chunk|completion|rate limit|quota|api key|credential|model|token limit|context length|4\d\d|5\d\d)\b/i;
const TOOL = /\b(tool|command|patch|exit code|workspace|file not found)\b/i;

const HEADLINES: Record<FailureCategory, string> = {
  provider: "Provider response failed",
  tool: "A tool call failed",
  permission: "Blocked by a permission boundary",
  network: "Connection failed",
  runtime: "Morrow could not finish this response",
};

/**
 * Classifies a failure reason. Ordered most-specific first: a permission
 * refusal that happens to mention a provider is a permission problem, and a
 * transport failure is a network problem even though it surfaced on a provider
 * call. An unrecognised reason stays `runtime` rather than being guessed into a
 * category the text does not support.
 */
export function classifyFailure(reason: string): FailureCategory {
  if (PERMISSION.test(reason)) return "permission";
  if (NETWORK.test(reason)) return "network";
  if (PROVIDER.test(reason)) return "provider";
  if (TOOL.test(reason)) return "tool";
  return "runtime";
}

/**
 * Splits a failed assistant message into prose plus failure. Returns null when
 * the message carries no recorded reason — a turn can be marked failed with no
 * appended block (a cancellation mid-stream, for instance), and inventing a
 * cause for it would be worse than showing none.
 */
export function parseTurnFailure(content: string): ParsedTurnFailure | null {
  const match = TRAILING_ERROR.exec(content);
  if (!match) return null;
  const reason = (match[1] ?? "").trim();
  if (!reason) return null;
  const category = classifyFailure(reason);
  return {
    content: content.slice(0, match.index).trimEnd(),
    reason,
    category,
    headline: HEADLINES[category],
  };
}

/** Headline for a failed turn that recorded no reason text. */
export const UNSPECIFIED_FAILURE_HEADLINE = "This response did not finish";

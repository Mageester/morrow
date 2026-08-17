import { memo, useState } from "react";
import { UNSPECIFIED_FAILURE_HEADLINE, type ParsedTurnFailure } from "./turn-failure.js";

/**
 * The failure surface for an assistant turn.
 *
 * Compact by default, with the exact recorded reason one click away. The
 * technical text is never rewritten or omitted — a reader who needs the literal
 * string to search for it gets the literal string — it simply stops being the
 * last thing the conversation says.
 */

const CATEGORY_LABELS: Record<ParsedTurnFailure["category"], string> = {
  provider: "Provider",
  tool: "Tool",
  permission: "Permission",
  network: "Network",
  runtime: "Morrow",
};

export interface TurnFailureNoticeProps {
  failure: ParsedTurnFailure | null;
  /** Present only when this turn can actually be retried. */
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean | undefined;
}

export const TurnFailureNotice = memo(function TurnFailureNotice({
  failure,
  onRetry,
  retryDisabled = false,
}: TurnFailureNoticeProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="morrow-turn-failure" data-category={failure?.category ?? "runtime"} data-testid="turn-failure" role="group">
      <div className="morrow-turn-failure__head">
        <span aria-hidden="true" className="morrow-turn-failure__mark">⚠</span>
        <div className="morrow-turn-failure__text">
          <p className="morrow-turn-failure__headline">
            {failure ? failure.headline : UNSPECIFIED_FAILURE_HEADLINE}
          </p>
          {failure ? (
            <p className="morrow-turn-failure__category">{CATEGORY_LABELS[failure.category]} error</p>
          ) : null}
        </div>
        <div className="morrow-turn-failure__actions">
          {failure ? (
            <button
              aria-expanded={open}
              className="morrow-turn-failure__button"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              {open ? "Hide details" : "Details"}
            </button>
          ) : null}
          {onRetry ? (
            <button
              className="morrow-turn-failure__button morrow-turn-failure__button--primary"
              disabled={retryDisabled}
              onClick={onRetry}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
      {open && failure ? (
        <pre className="morrow-turn-failure__detail">{failure.reason}</pre>
      ) : null}
    </div>
  );
});

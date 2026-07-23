import type { WebMissionSummary, WebMissionUiState } from "@morrow/contracts";
import { Workflow } from "lucide-react";
import type { MissionStreamStatus } from "../../api/mission-stream.js";

const LIVE_PRESENTATION: Partial<Record<MissionStreamStatus, { label: string; tone: string }>> = {
  synchronized: { label: "Live", tone: "success" },
  reconnecting: { label: "Reconnecting…", tone: "warning" },
  offline: { label: "Offline", tone: "neutral" },
};

interface StatePresentation {
  label: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
}

export const MISSION_STATE_PRESENTATION: Record<WebMissionUiState, StatePresentation> = {
  draft: { label: "Preparing", tone: "neutral" },
  working: { label: "Working", tone: "accent" },
  reviewing: { label: "Reviewing", tone: "accent" },
  needs_input: { label: "Needs you", tone: "warning" },
  blocked: { label: "Needs you", tone: "warning" },
  failed_recoverable: { label: "Recovering", tone: "warning" },
  failed: { label: "Couldn’t finish", tone: "danger" },
  completed_verified: { label: "Done — verified", tone: "success" },
  completed_with_caveats: { label: "Done — with caveats", tone: "warning" },
  cancelled: { label: "Stopped", tone: "neutral" },
  superseded: { label: "Replaced", tone: "neutral" },
};

export interface MissionCardProps {
  summary: WebMissionSummary;
  expanded: boolean;
  onToggle: () => void;
  /** Live connection state of the mission event stream, when subscribed. */
  liveStatus?: MissionStreamStatus | undefined;
}

export function MissionCard({ summary, expanded, onToggle, liveStatus }: MissionCardProps) {
  const presentation = MISSION_STATE_PRESENTATION[summary.state];
  const live = liveStatus ? LIVE_PRESENTATION[liveStatus] : undefined;
  const total = summary.totalMilestones;
  const pct = total > 0 ? Math.round((summary.completedMilestones / total) * 100) : 0;
  // The state tag already says "Needs you" for needs_input/blocked; only add the
  // extra chip when an otherwise-running mission has a pending attention item.
  const needsAttention =
    summary.attentionCount > 0 && summary.state !== "needs_input" && summary.state !== "blocked";

  return (
    <article aria-label={`Mission: ${summary.title}`} className="morrow-mission-card" data-state={summary.state}>
      <div className="morrow-mission-card__head">
        <span aria-hidden="true" className="morrow-mission-card__icon">
          <Workflow size={16} strokeWidth={1.8} />
        </span>
        <div className="morrow-mission-card__title-wrap">
          <p className="morrow-mission-card__title">{summary.title}</p>
          <p className="morrow-mission-card__meta">
            {total > 0 ? `${summary.completedMilestones} of ${total} steps · ` : ""}
            {summary.currentPhase}
          </p>
        </div>
        <span className={`morrow-mission-tag morrow-mission-tag--${presentation.tone}`}>{presentation.label}</span>
      </div>

      {live ? (
        <p aria-live="polite" className={`morrow-mission-card__live morrow-mission-card__live--${live.tone}`}>
          <span aria-hidden="true" className="morrow-mission-card__live-dot" />
          {live.label}
        </p>
      ) : null}

      {total > 0 ? (
        <div aria-hidden="true" className="morrow-mission-card__bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      <div className="morrow-mission-card__actions">
        <button
          aria-expanded={expanded}
          className="morrow-mission-card__toggle"
          onClick={onToggle}
          type="button"
        >
          {expanded ? "Hide details" : "View details"}
        </button>
        {needsAttention ? <span className="morrow-mission-card__attention">Needs you</span> : null}
      </div>
    </article>
  );
}

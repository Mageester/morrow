import type { WebMissionMilestone, WebMissionSnapshot } from "@morrow/contracts";
import { Check, Circle, Loader, X } from "lucide-react";
import { AttentionCard, AttentionResolutionCoordinator } from "../missions/attention-card.js";
import { MISSION_STATE_PRESENTATION } from "./mission-card.js";

function milestoneIcon(state: WebMissionMilestone["state"]) {
  if (state === "completed") return <Check aria-hidden="true" size={14} />;
  if (state === "running") return <Loader aria-hidden="true" size={14} />;
  if (state === "failed") return <X aria-hidden="true" size={14} />;
  return <Circle aria-hidden="true" size={14} />;
}

export interface MissionPanelProps {
  snapshot: WebMissionSnapshot;
}

export function MissionPanel({ snapshot }: MissionPanelProps) {
  const { summary, milestones, currentWork, verification, recentActivity, attention } = snapshot;
  const presentation = MISSION_STATE_PRESENTATION[summary.state];

  return (
    <section aria-label="Mission detail" className="morrow-mission-panel">
      <div className="morrow-mission-panel__facts">
        <div className="morrow-mission-panel__row">
          <span>Status</span>
          <b>{presentation.label}</b>
        </div>
        <div className="morrow-mission-panel__row">
          <span>Step</span>
          <b>{summary.completedMilestones} of {summary.totalMilestones}</b>
        </div>
        <div className="morrow-mission-panel__row">
          <span>Model</span>
          <b>{summary.modelLabel}</b>
        </div>
      </div>

      {attention.length > 0 ? (
        <AttentionResolutionCoordinator missionId={summary.id}>
          <div className="morrow-mission-panel__block morrow-mission-panel__attention">
            {attention.map((request) => (
              <AttentionCard key={request.id} missionId={summary.id} request={request} />
            ))}
          </div>
        </AttentionResolutionCoordinator>
      ) : null}

      {currentWork ? <p className="morrow-mission-panel__current">{currentWork}</p> : null}

      {milestones.length > 0 ? (
        <div className="morrow-mission-panel__block">
          <p className="morrow-mission-panel__label">Plan</p>
          <ul className="morrow-mission-plan">
            {milestones.map((milestone) => (
              <li className="morrow-mission-plan__item" data-state={milestone.state} key={milestone.id}>
                <span className="morrow-mission-plan__icon" data-state={milestone.state}>
                  {milestoneIcon(milestone.state)}
                </span>
                {milestone.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="morrow-mission-panel__block">
        <p className="morrow-mission-panel__label">Verification</p>
        <p className="morrow-mission-panel__verification">
          {verification.summary || "Verification has not started."}
        </p>
        {verification.caveats.length > 0 ? (
          <ul className="morrow-mission-panel__caveats">
            {verification.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {recentActivity.length > 0 ? (
        <div className="morrow-mission-panel__block">
          <p className="morrow-mission-panel__label">Recent activity</p>
          <ul className="morrow-mission-panel__activity">
            {recentActivity.slice(-6).map((activity) => (
              <li key={activity.id}>{activity.summary}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

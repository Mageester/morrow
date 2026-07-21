import type { WebMissionArtifact, WebMissionSnapshot, WebMissionUiState } from "@morrow/contracts";
import { ArtifactList } from "./work-tab.js";

type WebVerificationSummary = WebMissionSnapshot["verification"];

function completionLabel(
  verificationState: WebVerificationSummary["state"],
  missionState: WebMissionUiState,
) {
  if (verificationState === "passed") {
    if (missionState === "completed_verified") return "Completed and verified";
    if (missionState === "completed_with_caveats") return "Completed with caveats";
    return "Verification passed; completion not confirmed";
  }
  if (verificationState === "passed_with_caveats") {
    if (
      missionState === "completed_verified" ||
      missionState === "completed_with_caveats"
    ) {
      return "Completed with caveats";
    }
    return "Verification passed with caveats; completion not confirmed";
  }
  if (verificationState === "failed") return "Verification failed";
  if (verificationState === "in_progress") return "Verification in progress";
  return "Verification not ready";
}

function evidenceLabel(evidenceCount: number) {
  if (evidenceCount === 0) return "No verification evidence is available.";
  return `${evidenceCount} ${evidenceCount === 1 ? "piece" : "pieces"} of verification evidence`;
}

export function ResultTab({
  artifacts,
  missionState,
  verification,
}: {
  artifacts: readonly WebMissionArtifact[];
  missionState: WebMissionUiState;
  verification: WebVerificationSummary;
}) {
  return (
    <section aria-labelledby="mission-result-heading" className="morrow-mission-result">
      <h2 id="mission-result-heading">
        {completionLabel(verification.state, missionState)}
      </h2>
      <p className="morrow-mission-result__summary">{verification.summary}</p>

      <section aria-labelledby="mission-result-artifacts-heading">
        <h2 id="mission-result-artifacts-heading">Primary deliverables</h2>
        <ArtifactList
          artifacts={artifacts}
          emptyMessage="No primary deliverables are available yet."
        />
      </section>

      <section aria-labelledby="mission-verification-heading">
        <h2 id="mission-verification-heading">Verification</h2>
        <ul className="morrow-mission-result__checklist">
          <li>Verification state: {verification.state.replaceAll("_", " ")}</li>
          <li>{evidenceLabel(verification.evidenceCount)}</li>
        </ul>
      </section>

      <section aria-labelledby="mission-caveats-heading">
        <h2 id="mission-caveats-heading">Caveats and unresolved risks</h2>
        {verification.caveats.length > 0 ? (
          <ul className="morrow-mission-result__caveats">
            {verification.caveats.map((caveat, index) => (
              <li key={`${index}-${caveat}`}>{caveat}</li>
            ))}
          </ul>
        ) : (
          <p>No caveats were reported.</p>
        )}
      </section>

      <p className="morrow-mission-result__actions">
        No additional verified actions are available.
      </p>
    </section>
  );
}

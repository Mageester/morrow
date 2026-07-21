import type { WebMissionArtifact, WebMissionSnapshot, WebMissionUiState } from "@morrow/contracts";
import { missionStateLabels } from "./mission-state.js";
import { ArtifactList } from "./work-tab.js";

type WebVerificationSummary = WebMissionSnapshot["verification"];

const verificationStateLabels: Record<WebVerificationSummary["state"], string> = {
  failed: "Failed",
  in_progress: "In progress",
  not_ready: "Not ready yet",
  passed: "Passed",
  passed_with_caveats: "Passed with caveats",
};

function completionLabel(
  verificationState: WebVerificationSummary["state"],
  missionState: WebMissionUiState,
) {
  if (missionState === "completed_verified") {
    if (verificationState === "passed") return "Completed and verified";
    if (verificationState === "passed_with_caveats") return "Completed with caveats";
    if (verificationState === "failed") return "Completed; verification failed";
    if (verificationState === "in_progress") return "Completed; verification in progress";
    return "Completed; verification not ready";
  }
  if (missionState === "completed_with_caveats") {
    if (verificationState === "failed") return "Completed with caveats; verification failed";
    if (verificationState === "in_progress") {
      return "Completed with caveats; verification in progress";
    }
    if (verificationState === "not_ready") {
      return "Completed with caveats; verification not ready";
    }
    return "Completed with caveats";
  }
  return missionStateLabels[missionState];
}

function evidenceLabel(evidenceCount: number) {
  if (evidenceCount === 0) return "No verification evidence is available.";
  return `${evidenceCount} ${evidenceCount === 1 ? "piece" : "pieces"} of verification evidence`;
}

function normalizedSummary(summary: string) {
  return summary.trim() || "No plain-language result summary was supplied.";
}

function normalizedCaveats(
  caveats: readonly string[],
  verificationState: WebVerificationSummary["state"],
  missionState: WebMissionUiState,
) {
  const values = caveats.map((caveat) => caveat.trim()).filter(Boolean);
  if (
    values.length === 0 &&
    (verificationState === "passed_with_caveats" ||
      missionState === "completed_with_caveats")
  ) {
    return ["Caveat details were not supplied."];
  }
  return values;
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
  const caveats = normalizedCaveats(
    verification.caveats,
    verification.state,
    missionState,
  );

  return (
    <section aria-labelledby="mission-result-heading" className="morrow-mission-result">
      <h2 id="mission-result-heading">
        {completionLabel(verification.state, missionState)}
      </h2>
      <p className="morrow-mission-result__summary">
        {normalizedSummary(verification.summary)}
      </p>

      <section aria-labelledby="mission-result-artifacts-heading">
        <h3 id="mission-result-artifacts-heading">Primary deliverables</h3>
        <ArtifactList
          artifacts={artifacts}
          emptyMessage="No primary deliverables are available yet."
          headingLevel={4}
        />
      </section>

      <section aria-labelledby="mission-verification-heading">
        <h3 id="mission-verification-heading">Verification</h3>
        <ul className="morrow-mission-result__checklist">
          <li>Verification: {verificationStateLabels[verification.state]}</li>
          <li>{evidenceLabel(verification.evidenceCount)}</li>
        </ul>
      </section>

      <section aria-labelledby="mission-caveats-heading">
        <h3 id="mission-caveats-heading">Caveats and unresolved risks</h3>
        {caveats.length > 0 ? (
          <ul className="morrow-mission-result__caveats">
            {caveats.map((caveat, index) => (
              <li key={`${index}-${caveat}`}>{caveat}</li>
            ))}
          </ul>
        ) : (
          <p>No caveats were reported.</p>
        )}
      </section>

    </section>
  );
}

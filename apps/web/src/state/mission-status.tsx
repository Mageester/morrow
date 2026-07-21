import type { WebMissionSnapshot } from "@morrow/contracts";
import { Surface } from "@morrow/ui";

interface StateCopy {
  detail: string;
  title: string;
}

function stateCopy(snapshot: WebMissionSnapshot): StateCopy | null {
  switch (snapshot.summary.state) {
    case "failed_recoverable":
      return {
        detail:
          "Synchronized mission state is preserved. Use an available recovery action explicitly; no retry is running in the background.",
        title: "Failed but recoverable",
      };
    case "failed":
      return {
        detail:
          "Morrow has no safe automatic continuation to report. Review the recorded failure before starting different work.",
        title: "Mission failed permanently",
      };
    case "completed_verified":
      return snapshot.verification.state === "passed"
        ? {
            detail: `${snapshot.verification.evidenceCount} evidence item${snapshot.verification.evidenceCount === 1 ? "" : "s"} support this result.`,
            title: "Completed and verified",
          }
        : {
            detail:
              "The mission reports completion, but required verification has not passed. Treat the result as unverified.",
            title: "Completed, verification incomplete",
          };
    case "completed_with_caveats":
      return {
        detail:
          snapshot.verification.state === "passed" ||
          snapshot.verification.state === "passed_with_caveats"
            ? "Review the recorded caveats before relying on this result."
            : "The mission reports completion, but required verification has not passed. Treat the result as unverified.",
        title:
          snapshot.verification.state === "passed" ||
          snapshot.verification.state === "passed_with_caveats"
            ? "Completed with caveats"
            : "Completed, verification incomplete",
      };
    default:
      return null;
  }
}

function verificationTrust(snapshot: WebMissionSnapshot): string {
  if (snapshot.verification.state === "passed") {
    return "Verification remains passed after the recorded recovery.";
  }
  if (snapshot.verification.state === "passed_with_caveats") {
    return "Verification retains recorded caveats after recovery.";
  }
  return "Verification has not passed after the recorded recovery.";
}

export function MissionStatusSummary({
  snapshot,
}: {
  snapshot: WebMissionSnapshot;
}) {
  const status = stateCopy(snapshot);
  let recovery: WebMissionSnapshot["recentActivity"][number] | undefined;
  for (let index = snapshot.recentActivity.length - 1; index >= 0; index -= 1) {
    const activity = snapshot.recentActivity[index];
    if (activity?.kind === "recovery") {
      recovery = activity;
      break;
    }
  }

  if (!status && !recovery) return null;

  return (
    <div className="morrow-mission-operational-state">
      {status ? (
        <Surface padding="large">
          <h2>{status.title}</h2>
          <p>{status.detail}</p>
          <p>{snapshot.verification.summary}</p>
        </Surface>
      ) : null}
      {recovery ? (
        <Surface padding="large">
          <h2>Recovery recorded</h2>
          <p>{recovery.summary}</p>
          <p>
            Checkpoint and replay details were not reported in browser-safe
            mission state. {verificationTrust(snapshot)}
          </p>
        </Surface>
      ) : null}
    </div>
  );
}

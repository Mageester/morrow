import type { WebMissionArtifact, WebMissionUiState } from "@morrow/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResultTab } from "./result-tab.js";

const artifact: WebMissionArtifact = {
  createdAt: "2026-07-21T13:20:00.000Z",
  id: "artifact-1",
  kind: "document",
  mimeType: "text/markdown",
  missionId: "mission-42",
  openPath: null,
  preview: "Delivered safely.",
  title: "Launch brief",
  version: 1,
};

function renderResult(
  verification: {
    caveats: string[];
    evidenceCount: number;
    state: "not_ready" | "in_progress" | "passed" | "passed_with_caveats" | "failed";
    summary: string;
  },
  missionState: WebMissionUiState = "completed_verified",
) {
  return render(
    <ResultTab
      artifacts={[artifact]}
      missionState={missionState}
      verification={verification}
    />,
  );
}

describe("ResultTab", () => {
  it("does not claim verified completion when verification failed and keeps caveats visible", () => {
    const { container } = renderResult({
      caveats: ["The publication step still needs owner approval."],
      evidenceCount: 1,
      state: "failed",
      summary: "The brief is drafted, but its final verification failed.",
    });

    expect(screen.getByRole("heading", { level: 2, name: "Verification failed" })).toBeVisible();
    expect(screen.queryByText("Completed and verified")).not.toBeInTheDocument();
    expect(screen.getByText("The brief is drafted, but its final verification failed.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Primary deliverables" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Launch brief" })).toBeVisible();
    expect(screen.getByText("1 piece of verification evidence")).toBeVisible();
    expect(screen.getByText("The publication step still needs owner approval.")).toBeVisible();
    expect(container.querySelector("details")).toBeNull();
  });

  it("labels passed verification as completed only when the mission snapshot supports it", () => {
    const verification = {
      caveats: [],
      evidenceCount: 2,
      state: "passed" as const,
      summary: "The brief passed its required checks.",
    };
    const { rerender } = renderResult(verification);

    expect(screen.getByRole("heading", { level: 2, name: "Completed and verified" })).toBeVisible();

    rerender(
      <ResultTab
        artifacts={[artifact]}
        missionState="working"
        verification={verification}
      />,
    );
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Verification passed; completion not confirmed",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Completed and verified")).not.toBeInTheDocument();
  });

  it("reports caveated and incomplete verification honestly with pluralized evidence", () => {
    const { rerender } = renderResult({
      caveats: [],
      evidenceCount: 0,
      state: "passed_with_caveats",
      summary: "The mission completed with limitations.",
    }, "completed_with_caveats");

    expect(screen.getByRole("heading", { level: 2, name: "Completed with caveats" })).toBeVisible();
    expect(screen.getByText("No verification evidence is available.")).toBeVisible();
    expect(screen.getByText("No caveats were reported.")).toBeVisible();

    rerender(
      <ResultTab
        artifacts={[]}
        missionState="reviewing"
        verification={{
          caveats: [],
          evidenceCount: 0,
          state: "in_progress",
          summary: "Verification is still running.",
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Verification in progress" })).toBeVisible();
    expect(screen.getByText("No primary deliverables are available yet.")).toBeVisible();
  });
});

import type { WebMissionArtifact, WebMissionUiState } from "@morrow/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResultPanel } from "./result-tab.js";

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
    <ResultPanel
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

    expect(screen.getByRole("heading", { level: 2, name: "Completed; verification failed" })).toBeVisible();
    expect(screen.queryByText("Completed and verified")).not.toBeInTheDocument();
    expect(screen.getByText("The brief is drafted, but its final verification failed.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Primary deliverables" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Launch brief" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Launch brief" })).toBeVisible();
    expect(screen.getByText("1 piece of verification evidence")).toBeVisible();
    expect(screen.getByText("The publication step still needs owner approval.")).toBeVisible();
    expect(container.querySelector("details")).toBeNull();
  });

  const verificationStates = [
    "not_ready",
    "in_progress",
    "passed",
    "passed_with_caveats",
    "failed",
  ] as const;
  const namedStates: ReadonlyArray<[WebMissionUiState, string]> = [
    ["draft", "Preparing"],
    ["needs_input", "Needs your input"],
    ["working", "Working"],
    ["reviewing", "Reviewing"],
    ["blocked", "Action needed"],
    ["failed_recoverable", "Failed, recoverable"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["superseded", "Superseded"],
  ];

  it.each(
    namedStates.flatMap(([missionState, expected]) =>
      verificationStates.map((verificationState) => [
        missionState,
        verificationState,
        expected,
      ] as const),
    ),
  )("preserves the %s mission outcome when verification is %s", (missionState, state, expected) => {
    renderResult({ caveats: [], evidenceCount: 0, state, summary: "Result summary." }, missionState);

    expect(screen.getByRole("heading", { level: 2, name: expected })).toBeVisible();
    expect(screen.queryByText("Completed and verified")).toBeNull();
  });

  it.each([
    ["completed_verified", "passed", "Completed and verified"],
    ["completed_verified", "passed_with_caveats", "Completed with caveats"],
    ["completed_verified", "failed", "Completed; verification failed"],
    ["completed_verified", "in_progress", "Completed; verification in progress"],
    ["completed_verified", "not_ready", "Completed; verification not ready"],
    ["completed_with_caveats", "passed", "Completed with caveats"],
    ["completed_with_caveats", "passed_with_caveats", "Completed with caveats"],
    ["completed_with_caveats", "failed", "Completed with caveats; verification failed"],
    ["completed_with_caveats", "in_progress", "Completed with caveats; verification in progress"],
    ["completed_with_caveats", "not_ready", "Completed with caveats; verification not ready"],
  ] as const)("maps %s and %s to %s", (missionState, state, expected) => {
    renderResult({ caveats: [], evidenceCount: 0, state, summary: "Result summary." }, missionState);

    expect(screen.getByRole("heading", { level: 2, name: expected })).toBeVisible();
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
    expect(screen.getByText("Caveat details were not supplied.")).toBeVisible();

    rerender(
      <ResultPanel
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
    expect(screen.getByRole("heading", { level: 2, name: "Reviewing" })).toBeVisible();
    expect(screen.getByText("No primary deliverables are available yet.")).toBeVisible();
  });

  it("normalizes the summary and caveats without hiding incomplete caveat details", () => {
    renderResult({
      caveats: ["  Keep the owner informed.  ", "   "],
      evidenceCount: 0,
      state: "passed_with_caveats",
      summary: "   ",
    }, "completed_with_caveats");

    expect(screen.getByText("No plain-language result summary was supplied.")).toBeVisible();
    expect(screen.getByText("Keep the owner informed.")).toBeVisible();
    expect(screen.queryByText("Caveat details were not supplied.")).toBeNull();
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";

import {
  ArtifactFrame,
  Button,
  EmptyState,
  ErrorCard,
  ProgressSteps,
  StatusPill,
  Surface,
  Timeline,
} from "../src/index.js";

describe("Button", () => {
  it("renders one accessible primary action", () => {
    render(<Button>Start mission</Button>);

    expect(
      screen.getByRole("button", { name: "Start mission" }),
    ).toBeVisible();
  });

  it("preserves ordinary button props", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="action" disabled onClick={onClick} type="submit">
        Continue
      </Button>,
    );

    const button = screen.getByTestId("action");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("type", "submit");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ErrorCard", () => {
  it("renders an actionable error contract", () => {
    const onReconnect = vi.fn();
    render(
      <ErrorCard
        title="GitHub connection expired"
        explanation="The mission is safe, but Morrow cannot open the pull request."
        attempted={["Refreshed the connection"]}
        recommendedAction={{
          label: "Reconnect GitHub",
          onClick: onReconnect,
        }}
      />,
    );

    const card = screen.getByRole("alert");
    expect(
      within(card).getByRole("heading", {
        name: "GitHub connection expired",
      }),
    ).toBeVisible();
    expect(within(card).getByText(/mission is safe/i)).toBeVisible();
    expect(within(card).getByText(/work is preserved/i)).toBeVisible();
    expect(within(card).getByText("Refreshed the connection")).toBeVisible();

    fireEvent.click(
      within(card).getByRole("button", { name: "Reconnect GitHub" }),
    );
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});

describe("semantic primitives", () => {
  it("renders status text as a polite status", () => {
    render(<StatusPill variant="success">Verified</StatusPill>);

    expect(screen.getByRole("status")).toHaveTextContent("Verified");
  });

  it("renders progress as an ordered list with a current step", () => {
    render(
      <ProgressSteps
        label="Mission progress"
        steps={[
          { id: "plan", label: "Plan", status: "complete" },
          { id: "work", label: "Work", status: "current" },
          { id: "verify", label: "Verify", status: "upcoming" },
        ]}
      />,
    );

    const progress = screen.getByRole("list", { name: "Mission progress" });
    expect(within(progress).getAllByRole("listitem")).toHaveLength(3);
    expect(within(progress).getByText("Work").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("renders timeline entries with machine-readable time", () => {
    render(
      <Timeline
        label="Mission activity"
        items={[
          {
            id: "research",
            title: "Research started",
            description: "Reviewing primary sources",
            timestamp: "2026-07-21T14:00:00.000Z",
            timeLabel: "10:00 AM",
          },
        ]}
      />,
    );

    const timeline = screen.getByRole("list", { name: "Mission activity" });
    expect(within(timeline).getByText("Research started")).toBeVisible();
    expect(within(timeline).getByText("Reviewing primary sources")).toBeVisible();
    expect(within(timeline).getByText("10:00 AM")).toHaveAttribute(
      "datetime",
      "2026-07-21T14:00:00.000Z",
    );
  });

  it("renders an empty state with a named action", () => {
    render(
      <EmptyState
        title="No missions yet"
        description="Delegate your first outcome to Morrow."
        action={{ label: "Create mission", onClick: vi.fn() }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No missions yet" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create mission" }),
    ).toBeVisible();
  });

  it("renders a labelled surface and preserves div props", () => {
    render(
      <Surface aria-label="Mission summary" data-testid="summary">
        Summary content
      </Surface>,
    );

    const surface = screen.getByRole("region", { name: "Mission summary" });
    expect(surface).toHaveAttribute("data-testid", "summary");
    expect(surface).toHaveTextContent("Summary content");
  });

  it("renders an artifact as a labelled region with actions", () => {
    render(
      <ArtifactFrame
        title="Competitor report"
        metadata="Markdown · 12 KB"
        actions={<Button variant="secondary">Download</Button>}
      >
        <p>Report preview</p>
      </ArtifactFrame>,
    );

    const artifact = screen.getByRole("region", {
      name: "Competitor report",
    });
    expect(within(artifact).getByText("Markdown · 12 KB")).toBeVisible();
    expect(
      within(artifact).getByRole("button", { name: "Download" }),
    ).toBeVisible();
    expect(within(artifact).getByText("Report preview")).toBeVisible();
  });
});

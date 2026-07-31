import { readFileSync } from "node:fs";
import { createRef } from "react";
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

  it("forwards refs through native and asChild composition", () => {
    const buttonRef = createRef<HTMLButtonElement>();
    const linkRef = createRef<HTMLAnchorElement>();

    render(
      <>
        <Button ref={buttonRef}>Continue</Button>
        <Button asChild ref={linkRef}>
          <a href="#details">View details</a>
        </Button>
      </>,
    );

    buttonRef.current?.focus();
    expect(buttonRef.current).toHaveFocus();
    linkRef.current?.focus();
    expect(linkRef.current).toHaveFocus();
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
        continuation="After reconnection, Morrow will resume from the saved checkpoint."
        recommendedAction={{
          label: "Reconnect GitHub",
          onClick: onReconnect,
        }}
        alternativeActions={[
          { label: "Download work", onClick: vi.fn() },
          { label: "Contact support", onClick: vi.fn() },
        ]}
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
    expect(
      within(card).getByText(/resume from the saved checkpoint/i),
    ).toBeVisible();
    const alternatives = within(card).getByRole("group", {
      name: "Alternative actions",
    });
    expect(within(alternatives).getAllByRole("button")).toHaveLength(2);

    fireEvent.click(
      within(card).getByRole("button", { name: "Reconnect GitHub" }),
    );
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});

describe("theme contrast", () => {
  const tokensCss = readFileSync("src/styles/tokens.css", "utf8");

  function declarations(selector: string) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = tokensCss.match(
      new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`),
    )?.[1];

    if (!block) {
      throw new Error(`Missing token block for ${selector}`);
    }

    return Object.fromEntries(
      [...block.matchAll(/(--[\w-]+)\s*:\s*(#[\da-f]{6})/gi)].map(
        ([, name, value]) => [name, value],
      ),
    );
  }

  function contrastRatio(foreground: string, background: string) {
    const luminance = (hex: string) => {
      const channels = hex
        .slice(1)
        .match(/.{2}/g)!
        .map((channel) => Number.parseInt(channel, 16) / 255)
        .map((channel) =>
          channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4,
        );

      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };

    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  it.each([":root", '[data-theme="dark"]'])(
    "%s primary normal and hover tokens meet WCAG AA",
    (selector) => {
      const theme = declarations(selector);
      const root = declarations(":root");
      const onAccent = theme["--morrow-on-accent"] ?? root["--morrow-on-accent"];

      expect(onAccent).toBeDefined();
      expect(
        contrastRatio(onAccent!, theme["--morrow-accent"] ?? root["--morrow-accent"]!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(
          onAccent!,
          theme["--morrow-accent-hover"] ?? root["--morrow-accent-hover"]!,
        ),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("semantic primitives", () => {
  it("forwards refs from every public component to its root element", () => {
    const surfaceRef = createRef<HTMLDivElement>();
    const statusRef = createRef<HTMLSpanElement>();
    const emptyRef = createRef<HTMLElement>();
    const errorRef = createRef<HTMLElement>();
    const progressRef = createRef<HTMLOListElement>();
    const timelineRef = createRef<HTMLOListElement>();
    const artifactRef = createRef<HTMLElement>();

    render(
      <>
        <Surface ref={surfaceRef}>Surface</Surface>
        <StatusPill ref={statusRef}>Ready</StatusPill>
        <EmptyState
          ref={emptyRef}
          title="Empty"
          description="Nothing here"
        />
        <ErrorCard
          ref={errorRef}
          title="Error"
          explanation="Something happened"
          preservedMessage="Work is safe"
          attempted={[]}
          continuation="Retry continues from the checkpoint."
          recommendedAction={{ label: "Retry", onClick: vi.fn() }}
        />
        <ProgressSteps ref={progressRef} label="Progress" steps={[]} />
        <Timeline ref={timelineRef} label="Timeline" items={[]} />
        <ArtifactFrame ref={artifactRef} title="Artifact">
          Preview
        </ArtifactFrame>
      </>,
    );

    expect(surfaceRef.current).toBe(screen.getByText("Surface"));
    expect(statusRef.current).toBe(screen.getByRole("status", { name: "" }));
    expect(emptyRef.current).toBe(
      screen.getByRole("region", { name: "Empty" }),
    );
    expect(errorRef.current).toBe(screen.getByRole("alert"));
    expect(progressRef.current).toBe(
      screen.getByRole("list", { name: "Progress" }),
    );
    expect(timelineRef.current).toBe(
      screen.getByRole("list", { name: "Timeline" }),
    );
    expect(artifactRef.current).toBe(
      screen.getByRole("region", { name: "Artifact" }),
    );
  });

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

  it("allows artifact titles to preserve the surrounding heading hierarchy", () => {
    render(
      <ArtifactFrame headingLevel={3} title="Nested artifact">
        Preview
      </ArtifactFrame>,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "Nested artifact" }),
    ).toBeVisible();
  });
});

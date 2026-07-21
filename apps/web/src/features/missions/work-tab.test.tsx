import type { WebMissionArtifact } from "@morrow/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkTab } from "./work-tab.js";

function artifact(
  overrides: Partial<WebMissionArtifact> = {},
): WebMissionArtifact {
  return {
    createdAt: "2026-07-21T13:20:00.000Z",
    id: "artifact-1",
    kind: "file",
    mimeType: "text/plain",
    missionId: "mission-42",
    openPath: "/private/workspace/brief.txt",
    preview: "Safe text preview.",
    title: "Artifact",
    version: 1,
    ...overrides,
  };
}

describe("WorkTab", () => {
  it("renders file, source, document, and code diff artifacts in the shared frame", () => {
    render(
      <WorkTab
        artifacts={[
          artifact({ id: "file", kind: "file", title: "Launch notes" }),
          artifact({ id: "source", kind: "source", title: "app.ts" }),
          artifact({ id: "document", kind: "document", title: "Brief" }),
          artifact({ id: "diff", kind: "code_diff", title: "Changes" }),
        ]}
      />,
    );

    for (const title of ["Launch notes", "app.ts", "Brief", "Changes"]) {
      const frame = screen.getByRole("region", { name: title });
      expect(frame).toHaveClass("morrow-artifact-frame");
      expect(within(frame).getByText("Safe text preview.")).toBeVisible();
    }
    expect(screen.getByText("File · text/plain · Version 1")).toBeVisible();
    expect(screen.getByText("Source · text/plain · Version 1")).toBeVisible();
    expect(screen.getByText("Document · text/plain · Version 1")).toBeVisible();
    expect(screen.getByText("Code diff · text/plain · Version 1")).toBeVisible();
  });

  it("falls back safely for an unexpected kind and renders previews as text", () => {
    const { container } = render(
      <WorkTab
        artifacts={[
          artifact({
            kind: "unrecognized" as WebMissionArtifact["kind"],
            mimeType: "   ",
            preview: '<img src=x onerror="alert(1)">',
            title: "Unrecognized artifact",
          }),
        ]}
      />,
    );

    const frame = screen.getByRole("region", { name: "Unrecognized artifact" });
    expect(within(frame).getByText("Other artifact · Unknown format · Version 1")).toBeVisible();
    expect(within(frame).getByText('<img src=x onerror="alert(1)">')).toBeVisible();
    expect(within(frame).queryByRole("img")).not.toBeInTheDocument();
    expect(within(frame).queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("explains when the mission has no artifacts or safe text preview", () => {
    const { rerender } = render(<WorkTab artifacts={[]} />);
    expect(screen.getByText("No mission artifacts are available yet.")).toBeVisible();

    rerender(<WorkTab artifacts={[artifact({ preview: "   " })]} />);
    expect(screen.getByText("No safe text preview is available.")).toBeVisible();
  });

  it("normalizes titles, offers a keyboard focusable preview, and keeps duplicate artifacts associated on rerender", () => {
    const duplicateId = "duplicate";
    const { rerender } = render(
      <WorkTab
        artifacts={[
          artifact({ id: duplicateId, preview: "First preview", title: " First artifact ", version: 1 }),
          artifact({ id: duplicateId, preview: "Second preview", title: "   ", version: 1 }),
        ]}
      />,
    );

    const firstPreview = screen.getByLabelText("Text preview for First artifact");
    expect(firstPreview).toHaveAttribute("tabindex", "0");
    firstPreview.focus();
    expect(firstPreview).toHaveFocus();
    expect(screen.getByRole("region", { name: "Untitled artifact" })).toHaveTextContent("Second preview");

    rerender(
      <WorkTab
        artifacts={[
          artifact({ id: duplicateId, preview: "Updated second preview", title: "Second artifact", version: 1 }),
          artifact({ id: duplicateId, preview: "Updated first preview", title: "First artifact", version: 1 }),
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "Second artifact" })).toHaveTextContent("Updated second preview");
    expect(screen.getByRole("region", { name: "First artifact" })).toHaveTextContent("Updated first preview");
  });
});

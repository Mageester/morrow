import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AmbientMark, ProductHeader, SectionFrame, StateScene } from "./product-frame.js";

describe("product frame primitives", () => {
  it("gives every route a semantic editorial header", () => {
    render(
      <ProductHeader
        action={<button type="button">Add memory</button>}
        description="Things Morrow remembers with you."
        eyebrow="Local intelligence"
        headingId="memory-heading"
        title="Memory"
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Memory" })).toHaveAttribute("id", "memory-heading");
    expect(screen.getByText("Local intelligence")).toBeVisible();
    expect(screen.getByText("Things Morrow remembers with you.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeVisible();
  });

  it("keeps an empty state actionable instead of presenting a dead primary control", () => {
    render(
      <StateScene
        action={<a href="/app/projects">Choose project</a>}
        description="Choose a local workspace so Morrow has a bounded place to work."
        title="A project gives Morrow context"
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "A project gives Morrow context" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Choose project" })).toHaveAttribute("href", "/app/projects");
  });

  it("provides labelled sections and decorative ambient marks without polluting the accessibility tree", () => {
    const { container } = render(
      <SectionFrame label="Recent work">
        <AmbientMark variant="arc" />
        <p>One conversation</p>
      </SectionFrame>,
    );

    expect(screen.getByRole("region", { name: "Recent work" })).toBeVisible();
    expect(screen.getByText("One conversation")).toBeVisible();
    expect(container.querySelector(".morrow-product-mark")).toHaveAttribute("aria-hidden", "true");
  });
});

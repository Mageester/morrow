import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TeammateAvatar, teammateInitials } from "./teammate-avatar.js";

describe("TeammateAvatar", () => {
  it("keeps local initials and deterministic tint identity while exposing live state", () => {
    render(<TeammateAvatar name="Research" status="working" />);

    const avatar = screen.getByText(teammateInitials("Research"));
    expect(avatar).toHaveAttribute("data-status", "working");
    expect(avatar).toHaveAttribute("data-tint");
  });
});

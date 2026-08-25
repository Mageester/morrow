import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TurnFailureNotice } from "./turn-failure-notice.js";

const failure = {
  content: "",
  reason: "The process was interrupted and can continue from its saved checkpoint.",
  category: "runtime" as const,
  headline: "This response did not finish",
};

describe("TurnFailureNotice recovery actions", () => {
  it("can expose resume separately from a fresh retry", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    const onRetry = vi.fn();
    render(<TurnFailureNotice failure={failure} onResume={onResume} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Resume saved work" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Retry from the beginning" })).toBeVisible();
  });
});

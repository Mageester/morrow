import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPage } from "./billing-page.js";

const useAuth = vi.fn();
vi.mock("@clerk/react", () => ({
  useAuth: () => useAuth(),
}));

describe("BillingPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("states the free plan honestly — no paid tier exists yet, so no Upgrade button", () => {
    useAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    render(<BillingPage />);
    expect(screen.getByText("free")).toBeVisible();
    expect(screen.getByText(/no paid plan exists yet/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /upgrade/i })).not.toBeInTheDocument();
  });
});

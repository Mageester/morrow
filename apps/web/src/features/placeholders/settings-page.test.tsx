import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../state/theme.js";
import { SettingsPage } from "./settings-page.js";

const now = "2026-08-11T12:00:00.000Z";
const profile = {
  version: 1, id: "default", displayName: "Aidan", assistantName: null, commsVerbosity: "concise",
  commsTone: "nontechnical", timezone: null, locale: null, defaultProviderId: null, defaultModel: null,
  defaultReasoning: { mode: "auto" }, defaultPrivacyMode: "local_only", defaultApprovalPosture: "ask_always",
  goals: [] as Array<{ id: string; text: string; enabled: boolean }>, createdAt: now, updatedAt: now,
};

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <SettingsPage />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("Settings page — assistant profile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the current profile and describes privacy as an enforced routing boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/assistant-profile") return Response.json(profile);
      return Response.json({});
    }));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("radio", { name: /Prefer local providers/ })).toBeChecked();
    expect(screen.getByText(/blocks remote model routes before a request leaves/i)).toBeVisible();
    expect(screen.queryByText(/No external model providers/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Personalization/ }));
    expect(await screen.findByDisplayValue("Aidan")).toBeVisible();
  });

  it("adds a goal as a definition only, never claiming it runs automatically", async () => {
    let currentProfile = profile;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/assistant-profile/goals") {
        currentProfile = { ...currentProfile, goals: [{ id: "g1", text: "Ping me about PRs", enabled: true }] };
        return Response.json(currentProfile);
      }
      return Response.json(currentProfile);
    }));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Personalization/ }));
    const input = await screen.findByLabelText("New goal");
    await user.type(input, "Ping me about PRs");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Ping me about PRs")).toBeVisible();
  });
});

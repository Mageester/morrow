import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "./activity-panel.js";

const now = "2026-08-25T12:00:00.000Z";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActivityPanel conversationId="conversation-1" onClose={vi.fn()} projectId="project-1" />
    </QueryClientProvider>,
  );
}

describe("ActivityPanel support bundle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads the strict project-scoped bundle on demand", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/activity")) {
        return Response.json({ version: 1, projectId: "project-1", conversationId: "conversation-1", entries: [] });
      }
      if (url.endsWith("/support-bundle")) {
        return Response.json({
          version: 1,
          projectId: "project-1",
          conversationId: "conversation-1",
          generatedAt: now,
          tasks: [],
          entries: [],
          privacyNotice: "Redacted support evidence.",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:support") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Download support bundle" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/conversations/conversation-1/support-bundle",
      expect.any(Object),
    ));
    expect(click).toHaveBeenCalled();
  });
});

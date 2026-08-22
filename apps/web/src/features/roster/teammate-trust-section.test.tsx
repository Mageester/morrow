import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeammateTrustSection } from "./teammate-trust-section.js";

const agent = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  version: 1, id, projectId: "p1", name, role: "researcher", instructions: null,
  providerOverride: null, modelOverride: null, enabled: true, teamId: null,
  memoryReadScopes: [], memoryWriteScopes: [], approvalRequired: true,
  maxProviderCalls: null, maxTokenBudget: null, maxWallClockMs: null, maxChildTasks: null,
  createdAt: "2026-08-21T09:00:00.000Z", updatedAt: "2026-08-21T09:00:00.000Z",
  ...overrides,
});

const grant = (id: string, targetAgentId: string, callerAgentId: string | null) => ({
  version: 1, id, projectId: "p1", callerAgentId, targetAgentId,
  targetProfileHash: "a".repeat(64), maxDepth: 1, maxChildren: 4,
  createdAt: "2026-08-21T09:00:00.000Z", revokedAt: null,
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TeammateTrustSection agentId="chief" agentName="Chief" projectId="p1" />
    </QueryClientProvider>,
  );
}

describe("TeammateTrustSection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.includes("/teammate-trust")) {
        return new Response(JSON.stringify({ version: 1, projectId: "p1", grants: [grant("g1", "research", "chief")] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([
        agent("chief", "Chief"),
        agent("research", "Research"),
        agent("comms", "Comms"),
        agent("off", "Retired", { enabled: false }),
        agent("teamed", "Team member", { teamId: "team-1" }),
      ]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("offers only eligible teammates and reflects existing trust", async () => {
    renderSection();
    const research = await screen.findByRole("checkbox", { name: /Research/ });
    expect(research).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: /Comms/ })).not.toBeChecked();
    // Self, disabled, and team-managed teammates are not offerable targets.
    expect(screen.queryByRole("checkbox", { name: /Chief/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Retired/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Team member/ })).toBeNull();
  });

  it("grants trust when a teammate is checked", async () => {
    renderSection();
    const comms = await screen.findByRole("checkbox", { name: /Comms/ });
    await userEvent.click(comms);
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(posted).toBeTruthy();
      expect(JSON.parse(String((posted?.[1] as RequestInit).body))).toMatchObject({
        callerAgentId: "chief", targetAgentId: "comms",
      });
    });
  });

  it("revokes trust when an allowed teammate is unchecked", async () => {
    renderSection();
    const research = await screen.findByRole("checkbox", { name: /Research/ });
    await userEvent.click(research);
    await waitFor(() => {
      const deleted = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
      expect(String(deleted?.[0])).toContain("/teammate-trust/g1");
    });
  });

  it("shows a project-wide grant as locked rather than silently editable", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.includes("/teammate-trust")) {
        return new Response(JSON.stringify({ version: 1, projectId: "p1", grants: [grant("g2", "research", null)] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([agent("chief", "Chief"), agent("research", "Research")]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    renderSection();
    const research = await screen.findByRole("checkbox", { name: /Research/ });
    expect(research).toBeChecked();
    expect(research).toBeDisabled();
    expect(screen.getByText(/every teammate in this project/i)).toBeInTheDocument();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSettingsSection } from "./mcp-settings-section.js";

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <McpSettingsSection />
    </QueryClientProvider>
  );
}

describe("McpSettingsSection component", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders 1-click starter templates and server lists", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/mcp/servers")) {
        return Response.json({
          servers: [
            {
              id: "sqlite",
              config: { transport: "stdio", command: "uvx", args: ["mcp-server-sqlite"] },
              trusted: true,
            },
          ],
        });
      }
      if (url.includes("/api/mcp/tools")) {
        return Response.json({
          tools: [
            {
              namespacedName: "mcp__sqlite__read_query",
              serverId: "sqlite",
              rawName: "read_query",
              description: "Execute a SELECT query on SQLite",
              autoApprove: true,
            },
          ],
        });
      }
      return Response.json({});
    }));

    renderComponent();

    expect(await screen.findByText("Model Context Protocol (MCP)")).toBeVisible();
    expect(screen.getByText(/1-Click Starter Templates/)).toBeVisible();
    expect(screen.getByText("GitHub (sse)")).toBeVisible();
    expect(screen.getByText("SQLite (stdio)")).toBeVisible();
    expect(await screen.findByText("mcp__sqlite__read_query")).toBeVisible();
  });

  it("triggers test ping and shows discovered tools", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/mcp/servers")) {
        return Response.json({
          servers: [
            {
              id: "github",
              config: { transport: "sse", url: "https://mcp.github.com/sse" },
              trusted: true,
            },
          ],
        });
      }
      if (url.includes("/api/mcp/tools")) {
        return Response.json({ tools: [] });
      }
      if (url.includes("/api/mcp/test") && init?.method === "POST") {
        return Response.json({
          ok: true,
          latencyMs: 42,
          tools: [{ name: "list_issues", description: "List GitHub issues" }],
          resources: [],
        });
      }
      return Response.json({});
    }));

    const user = userEvent.setup();
    renderComponent();

    const pingBtn = await screen.findByRole("button", { name: /Test Ping/ });
    await user.click(pingBtn);

    expect(await screen.findByText(/Connection OK \(42ms\)/)).toBeVisible();
    expect(screen.getByText("list_issues")).toBeVisible();
  });
});

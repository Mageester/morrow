import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./connections-page.js";

const secret = `synthetic-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function provider(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, id: "openrouter", label: "OpenRouter", kind: "api-key", configured: false,
    available: false, endpointType: "default", endpointHost: "openrouter.ai", authStatus: "missing",
    authMode: "openrouter-api-key", capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: false, local: false },
    models: [], defaultModel: null, note: null, setupHint: "Add an API key to connect OpenRouter.", ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return { id: "openrouter", ok: true, configured: true, status: 200, latencyMs: 12, checkedEndpoint: "openrouter.ai", detail: "Connected", errorKind: null, modelsSample: ["anthropic/claude-sonnet-4"], models: [], ...overrides };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><ConnectionsPage /></QueryClientProvider>);
  return queryClient;
}

function installApi(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200) { return Response.json(body, { status }); }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ConnectionsPage", () => {
  it("connects OpenRouter, clears the key, and never places it in query data or visible copy", async () => {
    const fetchMock = installApi((path) => {
      if (path === "/api/providers") return json([provider()]);
      if (path === "/api/providers/openrouter/configure") return json({ ok: true, provider: "openrouter", status: provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4"], defaultModel: "anthropic/claude-sonnet-4" }) });
      throw new Error(`Unexpected request: ${path}`);
    });
    const queryClient = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect OpenRouter" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(input).toHaveValue(""));
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ apiKey: secret }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(JSON.stringify(queryClient.getQueryData(["providers"]))).not.toContain(secret);
  });

  it("shows actionable invalid-key, rate-limit, and network failures without echoing a rejected replacement", async () => {
    let configured = true;
    installApi((path) => {
      if (path === "/api/providers") return json([provider({ configured, available: configured, authStatus: configured ? "configured" : "missing", defaultModel: "anthropic/claude-sonnet-4", models: ["anthropic/claude-sonnet-4"] })]);
      if (path === "/api/providers/openrouter/configure") return json({ version: 1, error: { code: "PROVIDER_VALIDATION_FAILED", message: "OpenRouter validation failed (auth). The previous credential was preserved." } }, 401);
      if (path === "/api/providers/openrouter/test") return json(result({ ok: false, errorKind: "rate_limit" }));
      if (path === "/api/providers/openrouter/models/refresh") throw new TypeError("network");
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Connected");
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    expect(await screen.findByText(/could not verify this key/i)).toBeVisible();
    expect(input).toHaveValue("");
    expect(screen.getByText("Connected")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/rate limit/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText(/could not reach the local Morrow runtime/i)).toBeVisible();
  });

  it("shows model health, supports refresh, and returns focus after cancelling disconnect", async () => {
    installApi((path) => {
      if (path === "/api/providers") return json([provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4", "openai/gpt-4.1"], defaultModel: "anthropic/claude-sonnet-4" })]);
      if (path.endsWith("/test") || path.endsWith("/refresh")) return json(result());
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("2 available models")).toBeVisible();
    expect(screen.getByText("Active model: anthropic/claude-sonnet-4")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/last successful health check/i)).toBeVisible();
    const disconnect = screen.getByRole("button", { name: "Disconnect OpenRouter" });
    await user.click(disconnect);
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect OpenRouter?" });
    expect(dialog).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(disconnect).toHaveFocus();
  });
});

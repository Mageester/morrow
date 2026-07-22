import { render, screen, waitFor, within } from "@testing-library/react";
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
    let configured = false;
    const fetchMock = installApi((path) => {
      if (path === "/api/providers") return json([provider({ configured, available: configured, authStatus: configured ? "configured" : "missing", models: configured ? ["anthropic/claude-sonnet-4"] : [], defaultModel: configured ? "anthropic/claude-sonnet-4" : null })]);
      if (path === "/api/providers/openrouter/configure") {
        configured = true;
        return json({ ok: true, provider: "openrouter", status: provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4"], defaultModel: "anthropic/claude-sonnet-4" }), securePermissions: true, credentialProtection: "posix-mode", shadowedByEnv: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const queryClient = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect OpenRouter" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(input).toHaveValue(""));
    expect(await screen.findByText("Connected", { exact: true })).toBeVisible();
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
    expect(await screen.findByText(/could not verify this replacement key/i)).toBeVisible();
    expect(input).toHaveValue("");
    expect(screen.getByText("Connected")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/rate limit/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText(/could not reach the local Morrow runtime/i)).toBeVisible();
  });

  it("explains an invalid first connection without claiming a prior credential remains", async () => {
    installApi((path) => {
      if (path === "/api/providers") return json([provider()]);
      if (path === "/api/providers/openrouter/configure") return json({ version: 1, error: { code: "PROVIDER_VALIDATION_FAILED", message: "OpenRouter validation failed (auth)." } }, 401);
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Connect OpenRouter" }));
    await user.type(screen.getByLabelText("OpenRouter API key"), secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(await screen.findByText(/could not verify this key/i)).toBeVisible();
    expect(screen.queryByText(/previous connection remains active/i)).not.toBeInTheDocument();
  });

  it("shows model health, supports refresh, and returns focus after cancelling disconnect", async () => {
    installApi((path) => {
      if (path === "/api/providers") return json([provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4", "openai/gpt-4.1"], defaultModel: "anthropic/claude-sonnet-4", lastSuccessAt: "2026-07-22T15:00:00.000Z" })]);
      if (path.endsWith("/test") || path.endsWith("/refresh")) return json(result());
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("2 available models")).toBeVisible();
    expect(screen.getByText("Active model: anthropic/claude-sonnet-4")).toBeVisible();
    expect(await screen.findByText(/last successful health check:.*2026/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const disconnect = screen.getByRole("button", { name: "Disconnect OpenRouter" });
    await user.click(disconnect);
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect OpenRouter?" });
    expect(dialog).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(disconnect).toHaveFocus();
  });

  it("uses the server health timestamp across reload and keeps mutation truth when reconciliation fails", async () => {
    let requests = 0;
    installApi((path) => {
      if (path === "/api/providers") {
        requests += 1;
        if (requests > 1) throw new TypeError("reconciliation offline");
        return json([provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4"], defaultModel: "anthropic/claude-sonnet-4", lastSuccessAt: "2026-07-22T15:00:00.000Z" })]);
      }
      if (path === "/api/providers/openrouter/configure") return json({ ok: true, provider: "openrouter", status: provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4"], defaultModel: "anthropic/claude-sonnet-4", lastSuccessAt: "2026-07-22T15:00:00.000Z" }), securePermissions: true, credentialProtection: "posix-mode", shadowedByEnv: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/last successful health check:.*2026/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    expect(await screen.findByText(/protected local credential file/i)).toBeVisible();
    expect(screen.getByText("Connected", { exact: true })).toBeVisible();
  });

  it("cancels a draft and confirms disconnect with authoritative disconnected state and focus", async () => {
    let disconnected = false;
    installApi((path) => {
      if (path === "/api/providers") return json([disconnected ? provider() : provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4"], defaultModel: "anthropic/claude-sonnet-4" })]);
      if (path === "/api/providers/openrouter/credentials") { disconnected = true; return json({ ok: true, provider: "openrouter", removed: ["OPENROUTER_API_KEY"], status: provider() }); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderPage();

    const replace = await screen.findByRole("button", { name: "Replace key" });
    await user.click(replace);
    const input = screen.getByLabelText("OpenRouter API key");
    expect(input).toHaveFocus();
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("OpenRouter API key")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace key" })).toHaveFocus());

    const disconnect = screen.getByRole("button", { name: "Disconnect OpenRouter" });
    await user.click(disconnect);
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect OpenRouter?" });
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect OpenRouter" })).toHaveFocus();
    expect(screen.getByText("Not connected", { exact: true })).toBeVisible();
  });
});

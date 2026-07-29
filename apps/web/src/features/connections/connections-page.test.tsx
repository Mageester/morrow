import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
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

// The page links to /pair (the only permanent route to the pairing screen), so
// it now needs a router in scope. A memory router with a stub /pair keeps every
// existing assertion untouched.
function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute();
  const connections = createRoute({ getParentRoute: () => root, path: "/", component: ConnectionsPage });
  const pair = createRoute({ getParentRoute: () => root, path: "/pair", component: () => null });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([connections, pair]),
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as unknown as AnyRouter} />
      </QueryClientProvider>,
    ),
  };
}

function installApi(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    // Account status is ambient page furniture, not the subject of any test
    // here — answer it once centrally so each case keeps its own tight handler.
    if (path === "/api/pairing/status") {
      return json({ version: 1, status: "unpaired", accountId: null, planId: null, checkedAt: null, lastError: null });
    }
    return handler(path, init);
  });
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
        return json({ ok: true, provider: "openrouter", status: provider({ configured: true, available: true, authStatus: "configured", models: ["anthropic/claude-sonnet-4"], defaultModel: "anthropic/claude-sonnet-4" }), securePermissions: false, credentialProtection: "posix-mode", shadowedByEnv: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const { queryClient } = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect OpenRouter" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(input).toHaveValue(""));
    expect(await screen.findByText("Connected", { exact: true })).toBeVisible();
    expect(await screen.findByText(/could not confirm owner-restricted permissions/i)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace key" })).toHaveFocus());
    // Matched by path, not call index: the page makes other ambient requests
    // (account status), and pinning this to position 1 made an unrelated added
    // request look like a credential regression.
    const configureCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/providers/openrouter/configure");
    expect(configureCall?.[1]?.body).toBe(JSON.stringify({ apiKey: secret }));
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace key" })).toHaveFocus());

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
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect OpenRouter" })).toHaveFocus());
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

  it("keeps the authoritative response across a failed reconciliation and a real remount", async () => {
    let providerReads = 0;
    const initial = provider({ configured: true, available: true, authStatus: "configured", models: ["vendor/old"], defaultModel: "vendor/old", lastSuccessAt: "2026-07-21T15:00:00.000Z" });
    const durable = provider({ configured: true, available: true, authStatus: "configured", models: ["vendor/new"], defaultModel: "vendor/new", lastSuccessAt: "2026-07-22T15:00:00.000Z" });
    installApi((path) => {
      if (path === "/api/providers") {
        providerReads += 1;
        if (providerReads === 1) return json([initial]);
        if (providerReads === 2) throw new TypeError("reconciliation offline");
        return json([durable]);
      }
      if (path === "/api/providers/openrouter/configure") return json({ ok: true, provider: "openrouter", status: durable, securePermissions: true, credentialProtection: "posix-mode", shadowedByEnv: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    const firstMount = renderPage();

    expect(await screen.findByText("Active model: vendor/old")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    const input = screen.getByLabelText("OpenRouter API key");
    await user.type(input, secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    expect(await screen.findByText("Active model: vendor/new")).toBeVisible();
    expect(await screen.findByText(/last successful health check:.*2026/i)).toBeVisible();
    expect(await screen.findByText(/protected local credential file/i)).toBeVisible();
    await waitFor(() => expect(providerReads).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace key" })).toHaveFocus());

    firstMount.unmount();
    renderPage();
    expect(await screen.findByText("Active model: vendor/new")).toBeVisible();
    expect(await screen.findByText(/last successful health check:.*2026/i)).toBeVisible();
    expect(providerReads).toBeGreaterThanOrEqual(3);
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

describe("ConnectionsPage — the full provider catalog", () => {
  const catalog = [
    provider({ id: "openrouter", label: "OpenRouter", category: "gateway", hasFreeTier: true, note: "Aggregates many upstream models behind one endpoint." }),
    provider({ id: "anthropic", label: "Anthropic", category: "assistant", supportsOAuth: true, authMode: "anthropic-api-key" }),
    provider({ id: "opencode-zen", label: "OpenCode Zen", category: "gateway", hasFreeTier: true, keyUrl: "https://opencode.ai/auth", note: "Curated model gateway from the OpenCode project." }),
    provider({ id: "groq", label: "Groq", category: "inference", hasFreeTier: true, note: "Open-weight models on Groq's LPU inference hardware." }),
    provider({
      id: "lmstudio", label: "LM Studio (local)", category: "local", kind: "local", endpointHost: null,
      capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: true },
      note: "Local inference through LM Studio's OpenAI-compatible server.",
    }),
    provider({ id: "mock", label: "Mock provider", category: "testing" }),
  ];

  function installCatalog(extra?: (path: string, init?: RequestInit) => Response | undefined) {
    return installApi((path, init) => {
      const override = extra?.(path, init);
      if (override) return override;
      if (path === "/api/providers") return json(catalog);
      throw new Error(`Unexpected request: ${path}`);
    });
  }

  /**
   * The page was hardcoded to OpenRouter — its API client literally asserted
   * `z.literal("openrouter")` — so 29 of the 30 providers the engine supports
   * could not be connected from the web app at all.
   */
  it("offers every supported provider, grouped so the list is navigable", async () => {
    installCatalog();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Major assistants" })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Gateways/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Fast inference hosts/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Local/ })).toBeVisible();

    for (const label of ["Anthropic", "OpenCode Zen", "Groq", "LM Studio (local)"]) {
      expect(screen.getByRole("button", { name: `Connect ${label}` })).toBeVisible();
    }
  });

  it("hides the internal testing provider from the catalog", async () => {
    installCatalog();
    renderPage();
    await screen.findByRole("button", { name: "Connect Groq" });
    expect(screen.queryByText("Mock provider")).not.toBeInTheDocument();
  });

  it("marks which providers offer subscription sign-in and a free tier", async () => {
    installCatalog();
    renderPage();

    const anthropic = (await screen.findByText("Anthropic")).closest("li")!;
    expect(within(anthropic).getByText("Sign in with a subscription")).toBeVisible();

    const groq = screen.getByText("Groq").closest("li")!;
    expect(within(groq).getByText("Free tier")).toBeVisible();
    // OpenCode Zen is API-key only; it must not advertise a sign-in that does
    // not exist for it.
    const zen = screen.getByText("OpenCode Zen").closest("li")!;
    expect(within(zen).queryByText("Sign in with a subscription")).not.toBeInTheDocument();
  });

  it("filters the catalog by name and description", async () => {
    installCatalog();
    renderPage();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Search providers"), "groq");
    expect(screen.getByRole("button", { name: "Connect Groq" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Anthropic" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search providers"));
    await user.type(screen.getByLabelText("Search providers"), "local inference");
    expect(screen.getByRole("button", { name: "Connect LM Studio (local)" })).toBeVisible();
  });

  it("configures a provider other than OpenRouter through its own endpoint", async () => {
    let configuredId: string | null = null;
    const fetchMock = installCatalog((path) => {
      if (path === "/api/providers/groq/configure") {
        configuredId = "groq";
        return json({ ok: true, provider: "groq", status: provider({ id: "groq", label: "Groq", category: "inference", configured: true, available: true, authStatus: "configured" }), securePermissions: true, credentialProtection: "posix-mode", shadowedByEnv: [] });
      }
      return undefined;
    });
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect Groq" }));
    await user.type(screen.getByLabelText("Groq API key"), secret);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(configuredId).toBe("groq"));
    const configureCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/groq/configure"));
    expect(configureCall?.[1]?.body).toBe(JSON.stringify({ apiKey: secret }));
    expect(await screen.findByText(/Groq is connected/i)).toBeVisible();
  });

  it("asks a local server for a URL and treats its key as optional", async () => {
    let body: string | undefined;
    installCatalog((path, init) => {
      if (path === "/api/providers/lmstudio/configure") {
        body = String(init?.body);
        return json({ ok: true, provider: "lmstudio", status: provider({ id: "lmstudio", label: "LM Studio (local)", configured: true, available: true }), securePermissions: true, credentialProtection: "posix-mode", shadowedByEnv: [] });
      }
      return undefined;
    });
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect LM Studio (local)" }));
    await user.type(screen.getByLabelText("LM Studio (local) base URL"), "http://127.0.0.1:1234/v1");
    // A local server usually needs no key, so saving without one must work.
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(body).toBe(JSON.stringify({ baseUrl: "http://127.0.0.1:1234/v1" })));
  });

  it("links to the provider's key page instead of leaving the user to find it", async () => {
    installCatalog();
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect OpenCode Zen" }));
    const link = screen.getByRole("link", { name: /Create one at opencode\.ai/i });
    expect(link).toHaveAttribute("href", "https://opencode.ai/auth");
    // Opening an external page must not hand it a window reference back.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("does not show two connect buttons for the provider being set up", async () => {
    installCatalog();
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Connect Groq" }));
    // The card is now on screen; the catalog entry for it must be gone, or the
    // same action is offered twice and is ambiguous to assistive technology.
    expect(screen.queryAllByRole("button", { name: /Connect Groq/ })).toHaveLength(0);
    expect(screen.getByLabelText("Groq API key")).toBeVisible();
  });

  it("says plainly when reachability could not prove the credential", async () => {
    installCatalog((path) => {
      if (path === "/api/providers/opencode-zen/test") {
        return json(result({ id: "opencode-zen", ok: true, credentialVerified: false, detail: "Reachable" }));
      }
      return undefined;
    });
    const connected = [...catalog];
    connected[2] = provider({ id: "opencode-zen", label: "OpenCode Zen", category: "gateway", configured: true, available: true, authStatus: "configured" });
    installApi((path) => {
      if (path === "/api/providers") return json(connected);
      if (path === "/api/providers/opencode-zen/test") return json(result({ id: "opencode-zen", ok: true, credentialVerified: false }));
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/lists models without a key/i)).toBeVisible();
  });
});

import { test, expect } from "@playwright/test";

const key = `synthetic-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const disconnected = {
  version: 1, id: "openrouter", label: "OpenRouter", kind: "api-key",
  configured: false, available: false, endpointType: "default", endpointHost: "openrouter.ai",
  authStatus: "missing", authMode: "openrouter-api-key",
  capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: false, local: false },
  models: [], defaultModel: null, note: null, setupHint: "Add an API key to connect OpenRouter.",
};

const connected = {
  ...disconnected, configured: true, available: true, authStatus: "configured",
  models: ["anthropic/claude-sonnet-4", "openai/gpt-4.1"], defaultModel: "anthropic/claude-sonnet-4",
};

test("Connections keeps the OpenRouter key out of the rendered page and supports keyboard-safe disconnect", async ({ page }) => {
  let current: typeof disconnected | typeof connected = disconnected;
  const bodies: string[] = [];
  await page.route("**/api/providers**", async (route) => {
    const request = route.request();
    bodies.push(request.postData() ?? "");
    const path = new URL(request.url()).pathname;
    if (path === "/api/providers") return route.fulfill({ json: [current] });
    if (path === "/api/providers/openrouter/configure") {
      current = connected;
      return route.fulfill({ json: { ok: true, provider: "openrouter", status: connected } });
    }
    if (path.endsWith("/test") || path.endsWith("/models/refresh")) {
      return route.fulfill({ json: { id: "openrouter", ok: true, configured: true, status: 200, latencyMs: 1, checkedEndpoint: "openrouter.ai", detail: "Connected", errorKind: null, modelsSample: [], models: [] } });
    }
    if (path.endsWith("/credentials")) {
      current = disconnected;
      return route.fulfill({ json: { ok: true, provider: "openrouter", removed: true, status: disconnected } });
    }
    throw new Error(`Unexpected provider route: ${path}`);
  });

  await page.goto("/app/connections");
  await expect(page.getByRole("button", { name: "Connect OpenRouter" })).toBeVisible();
  await page.getByRole("button", { name: "Connect OpenRouter" }).click();
  await page.getByLabel("OpenRouter API key").fill(key);
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("2 available models")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(key);
  expect(bodies.some((body) => body.includes(key))).toBe(true);

  const disconnect = page.getByRole("button", { name: "Disconnect OpenRouter" });
  await disconnect.click();
  const dialog = page.getByRole("alertdialog", { name: "Disconnect OpenRouter?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(disconnect).toBeFocused();
});

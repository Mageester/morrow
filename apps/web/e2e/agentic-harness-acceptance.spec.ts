import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

async function createConversation(request: APIRequestContext): Promise<string> {
  const response = await request.post(`/api/projects/${state.seed.projectId}/conversations`, {
    data: { title: "Agentic harness acceptance" },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/app/chats/${conversationId}?projectId=${encodeURIComponent(state.seed.projectId)}`);
}

test.describe("agentic harness acceptance", () => {
  test("shows the durable answer without refresh when chat SSE is silent", async ({ page, request }) => {
    const conversationId = await createConversation(request);
    await openConversation(page, conversationId);
    await expect(page.getByRole("heading", { name: "Agentic harness acceptance" })).toBeVisible();

    await page.route(/\/tasks\/[^/]+\/stream(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
        body: ": intentionally silent\n\n",
      });
    });
    let navigations = 0;
    page.on("framenavigated", () => { navigations += 1; });
    const beforeSubmit = navigations;

    await page.getByRole("textbox", { name: "Message Morrow" }).fill("Is the local mock runtime operational?");
    await page.getByRole("textbox", { name: "Message Morrow" }).press("Enter");

    await expect(page.getByText("Based on the evidence, the system is fully operational.")).toBeVisible({ timeout: 15_000 });
    expect(navigations).toBe(beforeSubmit);
    await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
  });

  test("keeps provider credentials and raw reasoning out of browser-safe projections", async ({ page }) => {
    const leaks: string[] = [];
    page.on("response", async (response) => {
      if (!response.url().startsWith(state.baseURL)) return;
      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.includes("json")) return;
      try {
        const body = await response.text();
        if (/sk-[A-Za-z0-9_-]{12,}|api[_-]?key|provider[_-]?reasoning|<thinking>/i.test(body)) {
          leaks.push(`${response.url()}: ${body.slice(0, 240)}`);
        }
      } catch {
        // A response can be closed while the page is navigating; that is not
        // evidence of a projection leak.
      }
    });

    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    await expect(page.getByRole("heading", { name: "Completed with caveats" })).toBeVisible();
    await page.waitForTimeout(250);
    expect(leaks).toEqual([]);
  });
});

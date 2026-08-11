import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

async function createConversation(request: APIRequestContext): Promise<string> {
  const response = await request.post(`/api/projects/${state.seed.projectId}/conversations`, {
    data: { title: "Silent chat recovery proof" },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/app/chats/${conversationId}?projectId=${encodeURIComponent(state.seed.projectId)}`);
}

test("recovers a completed answer from authoritative state when chat SSE stays silent", async ({ page, request }) => {
  const conversationId = await createConversation(request);
  await openConversation(page, conversationId);
  await expect(page.getByRole("heading", { name: "Silent chat recovery proof" })).toBeVisible();

  // Let the task finish durably, but give EventSource no task event to consume.
  await page.route(/\/tasks\/[^/]+\/stream(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
      body: ": silent\n\n",
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

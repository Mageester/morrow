import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

async function createConversation(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post(`/api/projects/${state.seed.projectId}/conversations`, {
    data: { title },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/app/chats/${conversationId}?projectId=${encodeURIComponent(state.seed.projectId)}`);
}

test.describe.configure({ mode: "serial" });

test.describe("durable conversation workspace", () => {
  test("desktop sends once, reconciles the canonical answer, and survives refresh", async ({ page, request }) => {
    const conversationId = await createConversation(request, "Desktop conversation proof");
    await openConversation(page, conversationId);

    await expect(page.getByRole("heading", { name: "Desktop conversation proof" })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message Morrow" });
    await composer.fill("Is the local mock runtime operational?");
    await composer.press("Enter");

    await expect(page.getByText("Is the local mock runtime operational?")).toBeVisible();
    await expect(page.getByText("Based on the evidence, the system is fully operational.")).toBeVisible();
    await expect(page.getByTestId("conversation-message-assistant")).toHaveCount(1);
    await expect(page.getByText(/Ask · mock-model via mock/i)).toBeVisible();

    await page.reload();
    await expect(page.getByText("Is the local mock runtime operational?")).toBeVisible();
    await expect(page.getByText("Based on the evidence, the system is fully operational.")).toBeVisible();
    await expect(page.getByTestId("conversation-message-assistant")).toHaveCount(1);
  });

  test("mobile touch path keeps Plan truthful, readable, and durable", async ({ browser, request }) => {
    const conversationId = await createConversation(request, "Mobile conversation proof");
    const context = await browser.newContext({
      ...devices["Pixel 7"],
      baseURL: state.baseURL,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await openConversation(page, conversationId);
      await expect(page.getByRole("heading", { name: "Mobile conversation proof" })).toBeVisible();
      await page.getByRole("button", { name: "Plan" }).click();
      await page.getByRole("textbox", { name: "Message Morrow" }).fill("Plan how to check the local runtime.");
      await page.getByRole("button", { name: "Send message" }).click();

      await expect(page.getByText("Plan how to check the local runtime.")).toBeVisible();
      await expect(page.getByText("Based on the evidence, the system is fully operational.")).toBeVisible();
      await expect(page.getByText(/Plan · mock-model via mock/i)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.reload();
      await expect(page.getByText("Plan how to check the local runtime.")).toBeVisible();
      await expect(page.getByTestId("conversation-message-assistant")).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});

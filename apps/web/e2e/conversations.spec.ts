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
    await expect(page.getByRole("list", { name: "Tool activity" }).getByRole("listitem")).toHaveCount(1);

    await page.reload();
    await expect(page.getByText("Is the local mock runtime operational?")).toBeVisible();
    await expect(page.getByText("Based on the evidence, the system is fully operational.")).toBeVisible();
    await expect(page.getByTestId("conversation-message-assistant")).toHaveCount(1);
    await expect(page.getByRole("list", { name: "Tool activity" }).getByRole("listitem")).toHaveCount(1);
  });

  test("active refresh and disconnect resume from the durable cursor before one cancellation", async ({ page, context }) => {
    const { projectId, activeConversationId: conversationId, activeTaskId: taskId } = state.seed;
    const cursorKey = `morrow.chat-stream-cursor.v1.${encodeURIComponent(JSON.stringify([projectId, conversationId, taskId]))}`;
    const streamAfters: number[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith(`/tasks/${taskId}/stream`)) {
        streamAfters.push(Number(url.searchParams.get("after") ?? "0"));
      }
    });

    await openConversation(page, conversationId);
    await expect(page.getByRole("heading", { name: "Active reconnect proof" })).toBeVisible();
    await expect(page.getByText("Morrow is responding…")).toBeVisible();
    await expect.poll(async () => page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { cursor: number }).cursor : 0;
    }, cursorKey)).toBe(1);

    await page.reload();
    await expect(page.getByText("Morrow is responding…")).toBeVisible();
    await expect.poll(() => streamAfters.filter((cursor) => cursor === 1).length).toBeGreaterThanOrEqual(1);

    await context.setOffline(true);
    await expect(page.getByText("Offline — showing saved conversation history.")).toBeVisible();
    await context.setOffline(false);
    await expect.poll(() => streamAfters.filter((cursor) => cursor === 1).length).toBeGreaterThanOrEqual(2);

    await page.getByRole("button", { name: "Stop generation" }).click();
    await expect(page.getByText("Task cancelled by user")).toBeVisible();
    await expect(page.getByTestId("conversation-message-assistant")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), cursorKey)).toBeNull();
  });

  test("failed and interrupted responses retry from the prior attempt cursor without duplicate execution", async ({ page }) => {
    for (const scenario of [
      { conversationId: state.seed.failedConversationId, taskId: state.seed.failedTaskId, title: "Failed retry proof" },
      { conversationId: state.seed.interruptedConversationId, taskId: state.seed.interruptedTaskId, title: "Interrupted retry proof" },
    ]) {
      const streamAfters: number[] = [];
      const observe = (request: { url(): string }) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith(`/tasks/${scenario.taskId}/stream`)) {
          streamAfters.push(Number(url.searchParams.get("after") ?? "0"));
        }
      };
      page.on("request", observe);
      await openConversation(page, scenario.conversationId);
      await expect(page.getByRole("heading", { name: scenario.title })).toBeVisible();
      await page.getByRole("button", { name: "Retry response" }).click();
      await expect(page.getByText("Based on the evidence, the system is fully operational.")).toBeVisible();
      await expect(page.getByTestId("conversation-message-assistant")).toHaveCount(1);
      await expect(page.getByRole("list", { name: "Tool activity" }).getByRole("listitem")).toHaveCount(1);
      await expect.poll(() => streamAfters.some((cursor) => cursor > 0)).toBe(true);
      page.off("request", observe);
    }
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

      await page.getByRole("button", { name: "Rename conversation" }).click();
      const titleInput = page.getByRole("textbox", { name: "Conversation title" });
      await expect(titleInput).toBeFocused();
      await titleInput.fill("Mobile renamed proof");
      await page.getByRole("button", { name: "Save name" }).click();
      await expect(page.getByRole("heading", { name: "Mobile renamed proof" })).toBeVisible();

      await page.getByRole("button", { name: "Archive conversation" }).click();
      await expect(page.getByRole("status")).toHaveText("Conversation archived.");
      await expect(page.getByRole("button", { name: "Restore conversation" })).toBeVisible();

      const deleteButton = page.getByRole("button", { name: "Delete conversation" });
      await deleteButton.click();
      const keepButton = page.getByRole("button", { name: "Keep conversation" });
      const confirmButton = page.getByRole("button", { name: "Delete permanently" });
      await expect(keepButton).toBeFocused();
      await keepButton.press("Shift+Tab");
      await expect(confirmButton).toBeFocused();
      await confirmButton.press("Tab");
      await expect(keepButton).toBeFocused();
      await keepButton.press("Escape");
      await expect(deleteButton).toBeFocused();

      await deleteButton.click();
      await page.getByRole("button", { name: "Delete permanently" }).click();
      await expect(page).toHaveURL(/\/app\/?$/);
      const deleted = await request.get(`/api/projects/${state.seed.projectId}/conversations/${conversationId}`);
      expect(deleted.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});

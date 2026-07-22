import { expect, test } from "@playwright/test";

test("composer preserves browser-native editing, IME input, and the draft across reload", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let submissions = 0;
  await page.route("**/api/web/missions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions += 1;
    return route.fulfill({
      status: 503,
      json: {
        version: 1,
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Morrow could not reach the model. Check the connection and try again.",
        },
      },
    });
  });

  await page.goto("/app/");
  const input = page.getByRole("textbox", { name: "Mission objective" });
  await expect(input).toBeFocused();

  const nativeDraft = "Fast typing: https://example.test `const answer = 42` 😀";
  await input.pressSequentially(nativeDraft, { delay: 0 });
  await input.press("Home");
  await input.press("ArrowRight");
  await input.press("End");
  await input.press("Shift+Home");
  const selected = await input.evaluate((node) => ({
    end: (node as HTMLTextAreaElement).selectionEnd,
    start: (node as HTMLTextAreaElement).selectionStart,
  }));
  expect(selected.end).toBeGreaterThan(selected.start);

  await input.press("Control+a");
  await input.press("Control+c");
  await input.press("Control+x");
  await expect(input).toHaveValue("");
  await input.press("Control+v");
  await expect(input).toHaveValue(nativeDraft);
  await input.press("Control+z");
  await input.press("Control+y");

  await input.fill("line one\nline two\n貼り付け: https://example.test/path?q=1 😀");
  await page.reload();
  await expect(input).toHaveValue("line one\nline two\n貼り付け: https://example.test/path?q=1 😀");

  await input.evaluate((node) => {
    const textarea = node as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "漢字" }));
    textarea.setRangeText("漢字", textarea.value.length, textarea.value.length, "end");
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: "漢字",
      inputType: "insertCompositionText",
      isComposing: true,
    }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "漢字" }));
  });
  await expect(input).toHaveValue(/😀漢字$/);

  await input.press("Shift+Enter");
  await expect(input).toHaveValue(/漢字\n$/);
  const beforeRejectedSend = await input.inputValue();
  await input.press("Enter");
  await expect(page.getByText("Morrow could not reach the model. Check the connection and try again.")).toBeVisible();
  await expect(input).toHaveValue(beforeRejectedSend);
  expect(submissions).toBe(1);

  const stored = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => key.startsWith("morrow.chat-draft.v1")),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]?.[1]).not.toContain("providerId");
});

test("composer remains reachable above a mobile viewport with touch-sized controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/");
  const input = page.getByRole("textbox", { name: "Mission objective" });
  await input.fill("Mobile draft 😀");
  await page.reload();
  await expect(input).toHaveValue("Mobile draft 😀");

  const send = page.getByRole("button", { name: "Start mission" });
  const box = await send.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

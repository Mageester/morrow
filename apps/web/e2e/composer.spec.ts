import { expect, test } from "@playwright/test";

const HARNESS = "/app/e2e/composer-harness.html";

test("production composer preserves native editing and collision-free drafts across reload and scope changes", async ({ context, isMobile, page }) => {
  test.skip(isMobile, "Desktop native-keyboard coverage runs in the dedicated desktop project.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(HARNESS);
  const input = page.getByRole("textbox", { name: "Message Morrow" });
  await expect(input).toBeFocused();

  const nativeDraft = "Fast typing: https://example.test `const answer = 42` 😀";
  await input.pressSequentially(nativeDraft, { delay: 0 });
  await input.press("Home");
  await input.press("Shift+End");
  const selection = await input.evaluate((node) => ({
    end: node.selectionEnd,
    start: node.selectionStart,
  }));
  expect(selection.end).toBeGreaterThan(selection.start);
  await input.press("Control+a");
  await input.press("Control+c");
  await input.press("Control+x");
  await expect(input).toHaveValue("");
  await input.press("Control+v");
  await expect(input).toHaveValue(nativeDraft);
  await input.press("Control+z");
  await input.press("Control+y");

  await input.fill("alpha draft\n貼り付け 😀");
  await page.getByRole("button", { name: "Use beta scope" }).click();
  await expect(input).toHaveValue("");
  await input.fill("beta draft");
  await page.getByRole("button", { name: "Use alpha scope" }).click();
  await expect(input).toHaveValue("alpha draft\n貼り付け 😀");
  await page.reload();
  await expect(input).toHaveValue("alpha draft\n貼り付け 😀");

  const stored = await page.evaluate(() => Object.keys(localStorage));
  expect(stored).toHaveLength(2);
  expect(stored.every((key) => key.startsWith("morrow.chat-draft.v2."))).toBe(true);
  expect(new Set(stored).size).toBe(2);
});

test("production composer handles bounded input, held deletion, autosize, IME 229, selectors, and callback payload", async ({ isMobile, page }) => {
  test.skip(isMobile, "Desktop native-keyboard coverage runs in the dedicated desktop project.");
  await page.goto(HARNESS);
  const input = page.getByRole("textbox", { name: "Message Morrow" });
  const rapidSample = "fast".repeat(256);
  await input.pressSequentially(rapidSample, { delay: 0 });
  expect(await input.inputValue()).toBe(rapidSample);
  await input.press("Control+a");
  const bounded = "x".repeat(32_000);
  const startedAt = Date.now();
  await page.keyboard.insertText(bounded);
  const elapsedMs = Date.now() - startedAt;
  expect(await input.inputValue()).toHaveLength(32_000);
  expect(elapsedMs).toBeLessThan(5_000);
  await page.keyboard.down("Backspace");
  await page.waitForTimeout(350);
  await page.keyboard.up("Backspace");
  expect((await input.inputValue()).length).toBeLessThan(32_000);

  await input.fill(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
  const sizing = await input.evaluate((node) => ({
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
  }));
  expect(sizing.scrollHeight).toBeGreaterThan(sizing.clientHeight);
  expect(sizing.overflowY).toBe("auto");
  expect(sizing.clientHeight).toBeLessThanOrEqual(192);

  await input.fill("IME compatibility");
  await input.evaluate((node) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "漢" }));
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "漢" }));
    node.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      keyCode: 229,
    }));
  });
  await expect(page.getByTestId("payload")).toHaveText("none");

  await page.getByRole("button", { name: "Build Auto" }).click();
  await page.getByLabel("Model route").selectOption("direct");
  await page.getByLabel("Project").selectOption("project-2");
  await expect(input).toHaveValue("");
  await input.fill("Ship the verified slice");
  await input.press("Enter");
  await expect(page.getByText("Harness rejected the message.")).toBeVisible();
  await expect(input).toBeFocused();
  await expect(page.getByTestId("payload")).toContainText('"projectId":"project-2"');
  await expect(page.getByTestId("payload")).toContainText('"mode":"agent"');
  await expect(page.getByTestId("payload")).toContainText('"autoApprove":true');
  await expect(page.getByTestId("payload")).toContainText('"providerId":"openrouter"');
});

test("production composer restores focus and selection after delayed outcomes and ignores stale scope status", async ({ isMobile, page }) => {
  test.skip(isMobile, "Desktop native-selection coverage runs in the dedicated desktop project.");
  await page.goto(HARNESS);
  const input = page.getByRole("textbox", { name: "Message Morrow" });
  const outcome = page.getByLabel("Harness outcome");

  await outcome.selectOption("delay-reject");
  await input.fill("retain exact selection");
  await input.evaluate((node) => node.setSelectionRange(3, 9));
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Resolve pending" }).click();
  await expect(page.getByText("Harness delayed rejection.")).toBeVisible();
  await expect(input).toBeFocused();
  expect(await input.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([3, 9]);

  await outcome.selectOption("delay-accept");
  await input.press("Enter");
  await page.getByRole("button", { name: "Resolve pending" }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();

  await page.getByRole("button", { name: "Use beta scope" }).click();
  await input.fill("beta remains");
  await page.getByRole("button", { name: "Use alpha scope" }).click();
  await input.fill("late alpha");
  await outcome.selectOption("delay-accept");
  await input.press("Enter");
  await page.getByRole("button", { name: "Use beta scope" }).click();
  await expect(input).toHaveValue("beta remains");
  await page.getByRole("button", { name: "Resolve pending" }).click();
  await expect(input).toHaveValue("beta remains");
  await expect(page.getByText("Message accepted.")).toHaveCount(0);
});

test("active task blocks Enter and form submission so only Stop remains actionable", async ({ isMobile, page }) => {
  test.skip(isMobile, "Desktop keyboard/form coverage runs in the dedicated desktop project.");
  await page.goto(HARNESS);
  const input = page.getByRole("textbox", { name: "Message Morrow" });
  await input.fill("must not submit");
  await page.getByRole("button", { name: "Toggle active task" }).click();
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeEnabled();
  await input.evaluate((node) => {
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    node.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("payload")).toHaveText("none");
});

test("production composer remains touch-reachable with a reduced mobile visual viewport", async ({ isMobile, page }) => {
  test.skip(!isMobile, "Touch and mobile-emulation coverage runs in the dedicated mobile project.");
  await page.goto(HARNESS);
  const input = page.getByRole("textbox", { name: "Message Morrow" });
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
  expect(await page.evaluate(() => navigator.userAgent)).toContain("Mobile");

  await page.getByRole("button", { name: "Use beta scope" }).tap();
  await expect(page.getByTestId("scope")).toHaveText("project-1:beta");
  await page.getByRole("button", { name: "Use alpha scope" }).tap();
  await expect(page.getByTestId("scope")).toHaveText("project-1:alpha");
  await input.tap();
  await input.fill("Mobile draft 😀");
  await page.reload();
  await expect(input).toHaveValue("Mobile draft 😀");
  await input.tap();

  await page.setViewportSize({ width: 390, height: 500 });
  await input.fill(Array.from({ length: 40 }, (_, index) => `mobile line ${index}`).join("\n"));
  await input.scrollIntoViewIfNeeded();
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.y).toBeLessThan(500);
  expect(inputBox!.y + inputBox!.height).toBeGreaterThan(0);
  await input.tap();
  const sizing = await input.evaluate((node) => ({
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
  }));
  expect(sizing.scrollHeight).toBeGreaterThan(sizing.clientHeight);
  expect(sizing.overflowY).toBe("auto");

  const send = page.getByRole("button", { name: "Send message" });
  const box = await send.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await send.tap();
  await expect(page.getByText("Harness rejected the message.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".morrow-chat-composer").evaluate((node) => getComputedStyle(node).paddingBottom)).not.toBe("0px");
  expect(await page.evaluate(() => {
    const includesSafeAreaRule = (rules: CSSRuleList): boolean =>
      Array.from(rules).some((rule) => {
        if (rule.cssText.includes(".morrow-chat-composer") &&
            rule.cssText.includes("padding-bottom: max(") &&
            rule.cssText.includes("env(safe-area-inset-bottom)")) return true;
        return "cssRules" in rule && includesSafeAreaRule((rule as CSSGroupingRule).cssRules);
      });
    return Array.from(document.styleSheets).some((sheet) => {
      try {
        return sheet.cssRules ? includesSafeAreaRule(sheet.cssRules) : false;
      } catch {
        return false;
      }
    });
  })).toBe(true);
});

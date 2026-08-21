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
  const draftKeys = stored.filter((key) => key.startsWith("morrow.chat-draft.v2."));
  expect(draftKeys).toHaveLength(2);
  expect(new Set(draftKeys).size).toBe(2);
  expect(stored).toContain("morrow.chat.composer-mode.v1");
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

  await expect(page.getByRole("button", { name: "Build" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "Trusted workspace" })).toBeChecked();
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

test("model picker opens unclipped above the chip bar", async ({ page }) => {
  await page.goto(HARNESS);
  const trigger = page.getByRole("button", { name: /Auto — recommended/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const panel = page.getByRole("menu");
  await expect(panel).toBeVisible();

  // Clipping does not change layout boxes, so the reliable detector is a
  // hit test: the panel's own center must resolve to an element inside the
  // panel, not to the chip bar that historically clipped it.
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    if (!box) return false;
    return page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return Boolean(el?.closest("[role='menu']"));
    }, [box.x + box.width / 2, box.y + box.height / 2]);
  }).toBe(true);

  const box = await panel.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
});

test("thinking popover and settings popover open unclipped above the chip bar", async ({ page }) => {
  await page.goto(HARNESS);
  for (const name of [/^Thinking ·/, /Workspace and message settings/]) {
    const trigger = page.getByRole("button", { name }).first();
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible();
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      if (!box) return false;
      return page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return Boolean(el?.closest("[role='dialog']"));
      }, [box.x + box.width / 2, box.y + box.height / 2]);
    }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
});

test("zz-probe geometry", async ({ page }) => {
  await page.goto(HARNESS);
  const info = await page.evaluate(() => {
    const toolbar = document.querySelector(".morrow-chat-composer__toolbar");
    const ts = toolbar ? getComputedStyle(toolbar) : null;
    return {
      ox: ts?.overflowX, oy: ts?.overflowY,
      buttons: Array.from(document.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.title ?? b.textContent?.trim().slice(0, 30)).slice(0, 14),
    };
  });
  console.log("PROBE_STYLE", JSON.stringify(info));
  await page.getByRole("button", { name: /Auto — recommended/ }).click();
  const geo = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const toolbar = document.querySelector(".morrow-chat-composer__toolbar");
    if (!menu || !toolbar) return { missing: true };
    const mb = menu.getBoundingClientRect();
    const tb = toolbar.getBoundingClientRect();
    const hit = document.elementFromPoint(mb.x + mb.width / 2, mb.y + mb.height / 2);
    return {
      menuTop: Math.round(mb.y), toolbarTop: Math.round(tb.y), toolbarH: Math.round(tb.height),
      hitClass: (hit?.getAttribute("class") ?? "").slice(0, 60), hitInMenu: Boolean(hit?.closest("[role='menu']")),
    };
  });
  console.log("PROBE_GEO", JSON.stringify(geo));
});

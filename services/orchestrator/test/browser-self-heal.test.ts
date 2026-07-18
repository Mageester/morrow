import { beforeEach, describe, expect, it, vi } from "vitest";

// Beta.32 packaged-acceptance regression: the product opens a HEADED browser by
// design, so the user closing that window is an ordinary consumer event. The
// controller kept reusing the dead Playwright session — every browser_open
// failed with "Target page, context or browser has been closed" until the model
// manually closed and reopened the session, and the loop detector interrupted
// the mission first. The controller must self-heal: reset a dead session before
// navigating, and retry a navigation exactly once on a closed-target error.

const state = vi.hoisted(() => ({
  launches: 0,
  gotoFailuresBeforeSuccess: 0,
  pageClosed: false,
  browserConnected: true,
}));

vi.mock("playwright", () => {
  function makePage() {
    return {
      isClosed: () => state.pageClosed,
      setDefaultTimeout: () => undefined,
      route: async () => undefined,
      on: () => undefined,
      goto: async () => {
        if (state.gotoFailuresBeforeSuccess > 0) {
          state.gotoFailuresBeforeSuccess -= 1;
          throw new Error("page.goto: Target page, context or browser has been closed");
        }
        return null;
      },
      url: () => "http://localhost:4173/",
      title: async () => "HALOFORM",
      viewportSize: () => ({ width: 1280, height: 720 }),
      locator: () => ({
        innerText: async () => "page text",
        evaluateAll: async () => [],
        nth: () => ({}),
      }),
      evaluate: async () => undefined,
      close: async () => undefined,
    };
  }
  return {
    chromium: {
      launch: async () => {
        state.launches += 1;
        state.pageClosed = false;
        state.browserConnected = true;
        return {
          isConnected: () => state.browserConnected,
          newContext: async () => ({
            pages: () => [],
            newPage: async () => makePage(),
            browser: () => null,
          }),
          close: async () => undefined,
        };
      },
    },
  };
});

import { isClosedTargetError, playwrightController } from "../src/browser/playwright.js";

describe("isClosedTargetError", () => {
  it("classifies playwright dead-target messages", () => {
    expect(isClosedTargetError(new Error("page.goto: Target page, context or browser has been closed"))).toBe(true);
    expect(isClosedTargetError(new Error("Target closed"))).toBe(true);
    expect(isClosedTargetError(new Error("browserContext.newPage: Target page, context or browser has been closed"))).toBe(true);
  });

  it("never classifies ordinary failures or cancellation as dead-target", () => {
    expect(isClosedTargetError(new Error("net::ERR_CONNECTION_REFUSED at http://localhost:5173/"))).toBe(false);
    expect(isClosedTargetError(new Error("Timeout 30000ms exceeded"))).toBe(false);
    expect(isClosedTargetError(new Error("Browser action cancelled"))).toBe(false);
  });
});

describe("browser session self-heal", () => {
  beforeEach(() => {
    state.launches = 0;
    state.gotoFailuresBeforeSuccess = 0;
    state.pageClosed = false;
    state.browserConnected = true;
  });

  it("retries a navigation once with a fresh session when the browser died mid-goto", async () => {
    const controller = playwrightController({ headless: true, allowPrivateNetwork: true, allowedDomains: ["localhost"] });
    state.gotoFailuresBeforeSuccess = 1;
    const snapshot = await controller.open("http://localhost:4173/");
    expect(snapshot.title).toBe("HALOFORM");
    expect(state.launches).toBe(2); // dead session disposed, fresh one launched
    await controller.close();
  });

  it("resets a session whose page was closed (user closed the headed window) before navigating", async () => {
    const controller = playwrightController({ headless: true, allowPrivateNetwork: true, allowedDomains: ["localhost"] });
    await controller.open("http://localhost:4173/");
    expect(state.launches).toBe(1);
    state.pageClosed = true; // the user closed the window between tool calls
    const snapshot = await controller.open("http://localhost:4173/");
    expect(snapshot.title).toBe("HALOFORM");
    expect(state.launches).toBe(2);
    await controller.close();
  });

  it("does not mask a genuinely non-fatal failure with a session restart", async () => {
    const controller = playwrightController({ headless: true, allowPrivateNetwork: true, allowedDomains: ["localhost"] });
    state.gotoFailuresBeforeSuccess = 2; // both the first attempt AND the single retry die
    await expect(controller.open("http://localhost:4173/")).rejects.toThrow(/has been closed/);
    await controller.close();
  });
});

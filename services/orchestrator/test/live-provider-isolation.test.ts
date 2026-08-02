import { describe, expect, it } from "vitest";
import { isLiveProviderOptedIn } from "../src/acceptance/flagship-gate.js";

describe("live-provider test isolation", () => {
  it("requires a positive per-scenario opt-in before a provider can be called", () => {
    expect(isLiveProviderOptedIn({}, "MORROW_LIVE_FLAGSHIP")).toBe(false);
    expect(isLiveProviderOptedIn({ MORROW_LIVE_FLAGSHIP: "0" }, "MORROW_LIVE_FLAGSHIP")).toBe(false);
    expect(isLiveProviderOptedIn({ MORROW_LIVE_FLAGSHIP: "true" }, "MORROW_LIVE_FLAGSHIP")).toBe(false);
    expect(isLiveProviderOptedIn({ MORROW_LIVE_FLAGSHIP: "1" }, "MORROW_LIVE_FLAGSHIP")).toBe(true);
  });
});

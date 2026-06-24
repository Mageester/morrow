import { describe, expect, it } from "vitest";
import { initialInputState, reduceKey } from "../src/terminal/input-state.js";

describe("terminal input overlays", () => {
  it("dismisses the output viewer with Escape", () => {
    const state = { ...initialInputState(), overlay: "output" as const };
    const result = reduceKey(state, { name: "escape" }, { commands: [], paletteItems: [] });
    expect(result.state.overlay).toBe("none");
  });
});

import { describe, expect, it } from "vitest";
import { shouldUseInteractive } from "../src/terminal/capabilities.js";

describe("interactive terminal capability selection", () => {
  it("falls back when stdin is not a TTY even if stdout is interactive", () => {
    expect(shouldUseInteractive({ json: false, isTTY: true, stdinIsTTY: false, env: {} })).toBe(false);
  });

  it("uses the full-screen frame for capable TTYs unless explicitly disabled", () => {
    expect(shouldUseInteractive({ json: false, isTTY: true, stdinIsTTY: true, env: {} })).toBe(true);
    expect(shouldUseInteractive({ json: false, isTTY: true, stdinIsTTY: true, env: { MORROW_TUI: "0" } })).toBe(false);
  });
});

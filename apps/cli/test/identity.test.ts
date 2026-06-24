import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { greeting, compactWordmark, largeWordmark, modeLabel, modeWord, privacyLabel, isLocalProvider, TAGLINE } from "../src/cli/identity.js";

const plain = new Output({ json: false, quiet: false, color: false });

describe("Morrow identity", () => {
  it("greets by time of day", () => {
    expect(greeting(new Date(2026, 0, 1, 8, 0, 0))).toBe("Good morning");
    expect(greeting(new Date(2026, 0, 1, 14, 0, 0))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 0, 1, 21, 0, 0))).toBe("Good evening");
    expect(greeting(new Date(2026, 0, 1, 2, 0, 0))).toBe("Good evening");
  });

  it("renders a compact wordmark that degrades to ASCII without Unicode", () => {
    const uni = compactWordmark(plain, true);
    const ascii = compactWordmark(plain, false);
    expect(uni).toContain("MORROW");
    expect(uni).toContain("✧");
    expect(ascii).toContain("MORROW");
    // No non-ASCII glyphs in the ASCII variant.
    expect(/[^\x00-\x7F]/.test(ascii)).toBe(false);
  });

  it("renders a large wordmark with no non-ASCII glyphs in ASCII mode", () => {
    const ascii = largeWordmark(plain, false).join("\n");
    expect(ascii).toContain("M  O  R  R  O  W");
    expect(ascii).toContain(TAGLINE);
    expect(/[^\x00-\x7F]/.test(ascii)).toBe(false);
  });

  it("uses truthful mode labels (never calls an agent session read-only)", () => {
    expect(modeLabel("agent")).toBe("Agent · approvals required");
    expect(modeLabel("read-only")).toBe("Inspect · read-only");
    expect(modeLabel("plan-only")).toBe("Plan · no changes");
    expect(modeWord("agent")).toBe("Agent");
    expect(modeWord("read-only")).toBe("Inspect");
  });

  it("labels provider privacy honestly", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("deepseek")).toBe(false);
    expect(privacyLabel("deepseek")).toBe("cloud");
    expect(privacyLabel("ollama")).toContain("local");
  });
});

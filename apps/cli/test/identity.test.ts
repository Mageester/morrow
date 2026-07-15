import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { greeting, compactWordmark, modeLabel, modeWord, parseModeName, privacyLabel, isLocalProvider, TAGLINE } from "../src/cli/identity.js";

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
    expect(uni).toContain(TAGLINE);
    expect(ascii).toContain("MORROW");
    // No non-ASCII glyphs in the ASCII variant.
    expect(/[^\x00-\x7F]/.test(ascii)).toBe(false);
  });

  it("uses truthful product-mode labels (Ask/Plan/Build; never calls an executing session read-only)", () => {
    expect(modeLabel("agent")).toBe("Build · approvals required");
    expect(modeLabel("agent", true)).toBe("Build · YOLO (auto-approves edits & commands)");
    expect(modeLabel("read-only")).toBe("Ask · read-only");
    expect(modeLabel("plan-only")).toBe("Plan · no changes");
    expect(modeWord("agent")).toBe("Build");
    expect(modeWord("read-only")).toBe("Ask");
    expect(modeWord("plan-only")).toBe("Plan");
  });

  it("parses product-mode names and legacy aliases", () => {
    expect(parseModeName("build")).toBe("agent");
    expect(parseModeName("agent")).toBe("agent");
    expect(parseModeName("ask")).toBe("read-only");
    expect(parseModeName("inspect")).toBe("read-only");
    expect(parseModeName("plan")).toBe("plan-only");
    expect(parseModeName("mission")).toBe("mission");
    expect(parseModeName("nonsense")).toBeNull();
  });

  it("labels provider privacy honestly", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("deepseek")).toBe(false);
    expect(privacyLabel("deepseek")).toBe("cloud");
    expect(privacyLabel("ollama")).toContain("local");
  });
});

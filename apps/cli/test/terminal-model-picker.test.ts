import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import type { ModelStatus } from "@morrow/contracts";
import { modelPickerLines, modelFactsLine, formatContextWindow } from "../src/terminal/model-picker.js";

const plain = new Output({ json: false, quiet: false, color: false });

function model(overrides: Partial<ModelStatus["model"]> = {}, available = true): ModelStatus {
  return {
    available,
    model: {
      version: 1,
      id: "deepseek-chat",
      providerId: "deepseek",
      label: "DeepSeek Chat",
      contextWindow: 64000,
      capabilities: { streaming: true, toolCalls: true, vision: false },
      speedClass: "balanced",
      costClass: "low",
      privacy: "remote",
      builtIn: true,
      ...overrides,
    },
  };
}

describe("model picker (honest facts)", () => {
  it("formats context windows and labels unknowns", () => {
    expect(formatContextWindow(64000)).toBe("64k");
    expect(formatContextWindow(128000)).toBe("128k");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(200000)).toBe("200k");
    expect(formatContextWindow(null)).toBe("unknown");
    expect(formatContextWindow(0)).toBe("unknown");
  });

  it("labels unknown context and cost rather than guessing", () => {
    const line = modelFactsLine(model({ contextWindow: null, costClass: "unknown" }), plain);
    expect(line).toContain("context unknown");
    expect(line).toContain("cost unknown");
  });

  it("always labels JSON-mode support as unknown at the CLI layer", () => {
    expect(modelFactsLine(model(), plain)).toContain("json unknown");
  });

  it("marks the current model and preserves-session hint", () => {
    const text = modelPickerLines([model()], { model: "deepseek-chat" }, plain, false).join("\n");
    expect(text).toContain("deepseek-chat");
    expect(text).toContain("current");
    expect(text).toContain("session is preserved");
  });

  it("states auto/preset routing when no model is selected", () => {
    const text = modelPickerLines([model()], {}, plain, false).join("\n");
    expect(text).toContain("auto");
    expect(text).toContain("preset routing");
  });

  it("shows availability honestly", () => {
    const text = modelPickerLines(
      [model({ id: "gpt-4o", providerId: "openai" }, false)],
      {},
      plain,
      false
    ).join("\n");
    expect(text).toContain("unavailable");
  });

  it("guides to provider setup when the registry is empty", () => {
    const text = modelPickerLines([], {}, plain, false).join("\n");
    expect(text).toContain("No models available");
    expect(text).toContain("morrow auth login");
  });
});

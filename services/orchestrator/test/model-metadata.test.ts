import { describe, expect, it } from "vitest";
import { calculateUsageCost, getModel, resolveModelMetadata } from "../src/routing/models.js";

describe("authoritative model metadata", () => {
  it("knows the DeepSeek Flash context limit and usage capabilities", () => {
    const meta = resolveModelMetadata("deepseek", "deepseek-v4-flash");
    expect(meta?.canonicalId).toBe("deepseek-v4-flash");
    expect(meta?.providerId).toBe("deepseek");
    expect(meta?.contextWindow).toBe(1_000_000);
    expect(meta?.tokenUsage).toBe(true);
    expect(meta?.streamingUsage).toBe(true);
    expect(meta?.capabilities.toolCalls).toBe(true);
  });

  it("resolves aliases to canonical metadata", () => {
    const meta = resolveModelMetadata("deepseek", "deepseek-flash");
    expect(meta?.canonicalId).toBe("deepseek-v4-flash");
    expect(getModel("deepseek-flash")?.id).toBe("deepseek-v4-flash");
  });

  it("returns safe unknown metadata for unknown models", () => {
    const meta = resolveModelMetadata("deepseek", "custom-model");
    expect(meta?.canonicalId).toBe("custom-model");
    expect(meta?.contextWindow).toBeNull();
    expect(meta?.pricing).toBeNull();
    expect(meta?.builtIn).toBe(false);
  });

  it("does not confuse the same model slug across provider changes", () => {
    const deepseek = resolveModelMetadata("deepseek", "deepseek-v4-flash");
    const openrouter = resolveModelMetadata("openrouter", "deepseek/deepseek-v4-flash");
    expect(deepseek?.providerId).toBe("deepseek");
    expect(openrouter?.providerId).toBe("openrouter");
    expect(openrouter?.canonicalId).toBe("deepseek/deepseek-v4-flash");
  });

  it("keeps unavailable context and pricing unknown", () => {
    const chat = resolveModelMetadata("deepseek", "deepseek-chat");
    expect(chat?.contextWindow).toBeNull();
    expect(chat?.pricing).toBeNull();
    expect(calculateUsageCost({ inputTokens: 100, outputTokens: 50 }, chat)).toEqual({ known: false, label: "unknown" });
  });

  it("calculates cost only with authoritative pricing", () => {
    const local = resolveModelMetadata("ollama", "llama3.1");
    expect(calculateUsageCost({ inputTokens: 1000, outputTokens: 500 }, local)).toEqual({ known: true, usd: 0, label: "$0.0000" });
  });
});

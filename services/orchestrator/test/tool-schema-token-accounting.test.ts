import { describe, expect, it } from "vitest";
import { measureProviderRequest } from "../src/execution/context-budget.js";
import { TOOL_CATALOG } from "../src/tools/catalog.js";
import type { ToolDefinition } from "../src/provider/base.js";

/**
 * Tool schemas are static ASCII JSON, and Morrow charged them one token per
 * BYTE. Real tokenizers average roughly 3.5-4 bytes per token on that text, so
 * the reserve was ~4x the truth.
 *
 * Live consequence (nemotron-3.5-lightning, task eb82bca6): on a route with no
 * published context window — the conservative 32,768 fallback — the tool
 * schemas alone were billed 12,664 of a 22,003-token compaction threshold. The
 * run compacted on *every single turn* with only ~5,800 tokens of real
 * conversation, so the model never kept its own prior observations and looped
 * on `inspect_workspace` 36 times.
 *
 * The reserve must stay conservative — over-reserving is safer than a real
 * overflow — but "conservative" cannot mean four times the true cost, because
 * that silently disables the context budget it was meant to protect.
 */
const tools: ToolDefinition[] = TOOL_CATALOG.filter((spec) => spec.enabled).map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: { type: "object", properties: spec.parameters as Record<string, unknown> },
}));

function measure(toolset: ToolDefinition[]) {
  return measureProviderRequest({
    providerId: "opencode-zen",
    model: "nemotron-3.5-lightning-free",
    protocol: "openai-chat",
    messages: [{ role: "user", content: "hi" }],
    tools: toolset,
    outputReserveTokens: 4096,
  });
}

describe("tool schema token accounting", () => {
  it("reserves a conservative but realistic number of tokens for the tool schemas", () => {
    const wireJson = JSON.stringify(tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })));
    const bytes = Buffer.byteLength(wireJson, "utf8");
    const realisticTokens = bytes / 3.7;
    const reserved = measure(tools).components.toolSchemas;

    // Still conservative: never under-reserve the real cost.
    expect(reserved).toBeGreaterThan(realisticTokens * 1.2);
    // But no longer absurd. A 1-token-per-byte floor lands at ~4x and is what
    // consumed half of a 32k budget before any conversation existed.
    expect(reserved).toBeLessThan(realisticTokens * 1.8);
    expect(reserved).toBeLessThan(bytes / 2);
  });

  it("leaves a small-context route enough room to actually hold a conversation", () => {
    // The 32,768 fallback with its standard reserves yields ~27,504 usable and
    // a 22,003 compaction threshold. The full tool surface must not eat most of
    // it, or every turn compacts and the model loses its own observations.
    const usableInputTokens = 27_504;
    const threshold = Math.floor(usableInputTokens * 0.8);
    const reserved = measure(tools).components.toolSchemas;
    expect(reserved).toBeLessThan(threshold * 0.25);
  });

  it("still scales with the size of the exposed tool surface", () => {
    const small = measure(tools.slice(0, 3)).components.toolSchemas;
    const full = measure(tools).components.toolSchemas;
    expect(full).toBeGreaterThan(small * 2);
    expect(small).toBeGreaterThan(0);
  });
});

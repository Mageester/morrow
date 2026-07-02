import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/provider/base.js";
import {
  estimateChatTokens,
  inputTokenBudget,
  prepareContextForProvider,
  resolveContextBudget,
  trimMessagesToBudget,
  validateProviderMessageOrdering,
  countChatTokens,
} from "../src/execution/context-budget.js";

describe("context budget", () => {
  it("derives input tokens from preset bytes and the model context window", () => {
    expect(inputTokenBudget({ contextBudgetBytes: 4000, outputBudgetTokens: 100 })).toBe(1000);
    expect(inputTokenBudget({ contextBudgetBytes: 4000, modelContextWindow: 900, outputBudgetTokens: 100, reserveTokens: 100 })).toBe(700);
  });

  it("trims old conversational history before system context or the newest turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System rules stay." },
      { role: "user", content: "old request " + "alpha ".repeat(160) },
      { role: "assistant", content: "old answer " + "beta ".repeat(160) },
      { role: "user", content: "new request keep this exact phrase" },
    ];

    const budget = estimateChatTokens([messages[0]!, messages[3]!]) + 2;
    const result = trimMessagesToBudget(messages, { maxInputTokens: budget });

    expect(result.trimmedMessages).toBe(2);
    expect(result.messages).toEqual([messages[0], messages[3]]);
    expect(result.finalTokens).toBeLessThanOrEqual(budget);
  });

  it("keeps assistant tool calls grouped with their tool outputs while trimming", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System rules stay." },
      { role: "user", content: "old request " + "alpha ".repeat(160) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
      },
      { role: "tool", toolCallId: "call-1", content: "tool output that must stay paired" },
    ];

    const budget = estimateChatTokens([messages[0]!, messages[2]!, messages[3]!]) + 2;
    const result = trimMessagesToBudget(messages, { maxInputTokens: budget });

    expect(result.messages).toEqual([messages[0], messages[2], messages[3]]);
    expect(result.finalTokens).toBeLessThanOrEqual(budget);
  });

  it("uses an exact offline tokenizer for supported OpenAI-family models and labels estimates honestly", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Count these tokens, please." }];

    const exact = countChatTokens(messages, { providerId: "openai", model: "gpt-5.4-mini" });
    expect(exact.exact).toBe(true);
    expect(exact.method).toBe("exact");
    expect(exact.tokenizer).toContain("tiktoken");
    expect(exact.model).toBe("gpt-5.4-mini");
    expect(exact.tokens).toBeGreaterThan(0);

    const estimated = countChatTokens(messages, { providerId: "anthropic", model: "claude-3-5-sonnet-20241022" });
    expect(estimated.exact).toBe(false);
    expect(estimated.method).toBe("estimate");
    expect(estimated.confidence).toBe("conservative");
  });

  it("centralizes model-aware budget resolution with source and reservations", () => {
    const known = resolveContextBudget({
      providerId: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      presetContextBudgetBytes: 786432,
      outputBudgetTokens: 4096,
      toolCount: 3,
    });
    expect(known.contextWindowTokens).toBe(200000);
    expect(known.contextWindowSource).toBe("known-model");
    expect(known.reservedTokens).toBeGreaterThan(4096);
    expect(known.maxInputTokens).toBeLessThan(200000);

    const overridden = resolveContextBudget({
      providerId: "openai",
      model: "custom-large",
      presetContextBudgetBytes: 999999,
      outputBudgetTokens: 1024,
      userContextWindowTokens: 16000,
      toolCount: 0,
    });
    expect(overridden.contextWindowTokens).toBe(16000);
    expect(overridden.contextWindowSource).toBe("user-config");

    const unknown = resolveContextBudget({
      providerId: "openai-compatible",
      model: "unknown",
      presetContextBudgetBytes: 524288,
      outputBudgetTokens: 2048,
      toolCount: 0,
    });
    expect(unknown.contextWindowSource).toBe("fallback");
    expect(unknown.exactModelLimit).toBe(false);
  });

  it("validates provider ordering and rejects orphaned tool results or unresolved historical tool calls", () => {
    expect(validateProviderMessageOrdering([
      { role: "system", content: "rules" },
      { role: "tool", toolCallId: "missing", content: "orphan" },
    ])).toMatchObject({ ok: false, reason: "orphan_tool_result" });

    expect(validateProviderMessageOrdering([
      { role: "system", content: "rules" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "user", content: "next turn" },
    ])).toMatchObject({ ok: false, reason: "unresolved_tool_call" });
  });

  it("compacts old eligible history before dropping it and redacts secret-like material", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System rules stay." },
      { role: "user", content: "Old goal: update src/app.ts. Command: pnpm test. API_KEY=abc123. " + "alpha ".repeat(400) },
      { role: "assistant", content: "Decision: keep provider-neutral routing. Error: test failed in src/app.ts. " + "beta ".repeat(400) },
      { role: "user", content: "Current request must remain raw." },
    ];

    const result = prepareContextForProvider(messages, {
      providerId: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      maxInputTokens: estimateChatTokens([messages[0]!, messages[3]!]) + 80,
      compact: true,
      recentRawGroups: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary?.method).toBe("deterministic");
    expect(result.summary?.content).toContain("src/app.ts");
    expect(result.summary?.content).toContain("pnpm test");
    expect(result.summary?.content).not.toContain("abc123");
    expect(result.messages.map((message) => message.content).join("\n")).toContain("Current request must remain raw.");
    expect(result.operations.map((op) => op.type)).toContain("context.compaction_completed");
  });

  it("refuses to prepare a provider payload when mandatory context cannot fit", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Mandatory system instructions " + "rules ".repeat(120) },
      { role: "user", content: "Current request must not be removed." },
    ];

    const result = prepareContextForProvider(messages, {
      providerId: "openai",
      model: "gpt-5.4-mini",
      maxInputTokens: 20,
      compact: true,
      recentRawGroups: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("minimum_context_too_large");
    expect(result.actionableMessage).toContain("Select a larger-context model");
  });
});

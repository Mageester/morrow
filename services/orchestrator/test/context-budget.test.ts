import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/provider/base.js";
import { estimateChatTokens, inputTokenBudget, trimMessagesToBudget } from "../src/execution/context-budget.js";

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
});

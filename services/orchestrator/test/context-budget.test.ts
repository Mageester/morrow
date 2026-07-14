import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/provider/base.js";
import {
  estimateChatTokens,
  estimateTextTokens,
  inputTokenBudget,
  prepareContextForProvider,
  resolveContextBudget,
  trimMessagesToBudget,
  validateProviderMessageOrdering,
  countChatTokens,
  measureProviderRequest,
  admitProviderRequest,
  admitMeasuredProviderRequest,
} from "../src/execution/context-budget.js";
import { resolveEffectiveContext } from "../src/routing/effective-context.js";
import { getEncoding } from "js-tiktoken";

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

  it("records summary cursors in message coordinates across assistant/tool groups", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Old requirement " + "history ".repeat(300) },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", toolCallId: "call-1", content: "Old observation " + "evidence ".repeat(300) },
      { role: "user", content: "Current request" },
    ];
    const result = prepareContextForProvider(messages, {
      providerId: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      maxInputTokens: estimateChatTokens([messages[3]!]) + 100,
      compact: true,
      recentRawGroups: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toMatchObject({ sourceStartIndex: 0, sourceEndIndex: 2, sourceMessageCount: 3 });
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
    expect(result.actionableMessage).toContain("Recovery options");
  });

  it("accounts for tool schemas, provider reasoning continuation, protocol overhead, and output reserve", () => {
    const measured = measureProviderRequest({
      providerId: "deepseek",
      model: "deepseek-reasoner",
      protocol: "openai-chat",
      messages: [{
        role: "assistant",
        content: "Visible answer fragment",
        providerContinuation: { reasoningContent: "opaque continuation required by the provider" },
      }],
      tools: [{
        name: "read_file",
        description: "Read one workspace file",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative path" } },
          required: ["path"],
        },
      }],
      outputReserveTokens: 16_384,
    });

    expect(measured.components.messages).toBeGreaterThan(0);
    expect(measured.components.toolSchemas).toBeGreaterThan(0);
    expect(measured.components.providerContinuation).toBeGreaterThan(0);
    expect(measured.components.protocolOverhead).toBeGreaterThan(0);
    expect(measured.outputReserveTokens).toBe(16_384);
    expect(measured.totalRequestTokens).toBe(measured.inputTokens + 16_384);
  });

  it("labels a mixed exact-message envelope conservatively and margins estimated extras", () => {
    const continuation = { reasoningContent: "provider-owned continuation state" };
    const tools = [{
      name: "read_file",
      description: "Read one workspace file",
      parameters: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Relative path" } },
        required: ["path"],
      },
    }];
    const measured = measureProviderRequest({
      providerId: "openai",
      model: "gpt-5.4-mini",
      protocol: "openai-chat",
      messages: [{ role: "assistant", content: "Visible answer", providerContinuation: continuation }],
      tools,
      outputReserveTokens: 4_096,
    });
    const rawToolTokens = estimateTextTokens(JSON.stringify(tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))));
    const rawContinuationTokens = estimateTextTokens(JSON.stringify(continuation));
    const rawInputTokens = measured.components.messages + rawToolTokens + rawContinuationTokens + 12;

    expect(measured.method).toBe("estimate");
    expect(measured.exact).toBe(false);
    expect(measured.confidence).toBe("conservative");
    expect(measured.inputTokens).toBeGreaterThan(rawInputTokens);
  });

  it("never undercounts tokenizer-expensive Unicode in opaque continuation fields", () => {
    const continuation = { reasoningContent: "👩🏿‍🚀".repeat(100) };
    const serialized = JSON.stringify(continuation);
    const exactOpenAiTokens = getEncoding("o200k_base").encode(serialized).length;

    const measured = measureProviderRequest({
      providerId: "deepseek",
      model: "deepseek-reasoner",
      protocol: "openai-chat",
      messages: [{ role: "assistant", content: "", providerContinuation: continuation }],
      tools: [],
      outputReserveTokens: 0,
    });

    expect(measured.components.providerContinuation).toBeGreaterThanOrEqual(exactOpenAiTokens);
  });

  it("rejects an oversized complete request before admission", () => {
    const resolution = resolveEffectiveContext({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: {
        kind: "default",
        host: "api.deepseek.com",
        protocol: "openai-chat",
        limitTokens: 131_072,
        limitSource: "provider-metadata",
      },
      outputReserveTokens: 16_384,
    });
    const envelope = {
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      protocol: "openai-chat" as const,
      messages: [{ role: "user" as const, content: "oversized ".repeat(70_000) }],
      tools: [],
      outputReserveTokens: 16_384,
    };

    const admission = admitProviderRequest(envelope, resolution);

    expect(admission.ok).toBe(false);
    expect(admission.measurement.inputTokens).toBeGreaterThan(resolution.maximumInputTokens);
    expect(admission.measurement.outputReserveTokens).toBe(16_384);
  });

  it("rejects the incident's exact 148403-token request against 131072 before invocation", () => {
    const resolution = resolveEffectiveContext({
      providerId: "deepseek", selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputReserveTokens: 16_384,
    });
    const measurement = {
      inputTokens: 132_019,
      outputReserveTokens: 16_384,
      totalRequestTokens: 148_403,
      method: "estimate" as const,
      exact: false,
      confidence: "conservative" as const,
      components: { messages: 132_000, toolSchemas: 0, providerContinuation: 0, protocolOverhead: 19 },
    };
    const admission = admitMeasuredProviderRequest(measurement, resolution);
    expect(admission.ok).toBe(false);
    expect(admission.measurement.totalRequestTokens).toBe(148_403);
    expect(resolution.effectiveRequestLimitTokens).toBe(131_072);
  });
});

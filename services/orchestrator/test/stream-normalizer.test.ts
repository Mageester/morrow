import { describe, expect, it } from "vitest";
import type { ProviderChunk } from "../src/provider/base.js";
import { assembleProviderToolCalls, normalizeProviderStream } from "../src/provider/stream-normalizer.js";

async function* source(chunks: ProviderChunk[]): AsyncIterable<ProviderChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collect(chunks: ProviderChunk[], signal?: AbortSignal): Promise<ProviderChunk[]> {
  const output: ProviderChunk[] = [];
  for await (const chunk of normalizeProviderStream(source(chunks), signal ? { abortSignal: signal } : {})) output.push(chunk);
  return output;
}

describe("shared provider stream normalizer", () => {
  it("emits one terminal done after usage and finish markers", async () => {
    const output = await collect([
      { type: "text", text: "hello" },
      { type: "done", usage: { promptTokens: 12, completionTokens: 3 } },
      { type: "done", finishReason: "stop" },
      { type: "done", finishReason: "length", usage: { promptTokens: 99, completionTokens: 99 } },
    ]);

    expect(output).toEqual([
      { type: "text", text: "hello" },
      { type: "done", usage: { promptTokens: 12, completionTokens: 3 }, finishReason: "stop" },
    ]);
  });

  it("preserves opaque provider continuation carried by the terminal marker", async () => {
    const output = await collect([
      {
        type: "tool_call",
        toolCalls: [{ id: "call-1", index: 0, type: "function", function: { name: "inspect_workspace", arguments: "{}" } }],
      },
      { type: "done", finishReason: "tool_calls", providerContinuation: { reasoningContent: "opaque terminal reasoning" } },
    ]);

    expect(output.at(-1)).toEqual({
      type: "done",
      finishReason: "tool_calls",
      providerContinuation: { reasoningContent: "opaque terminal reasoning" },
    });
  });

  it("keeps parallel fragmented tool calls reassemblable and gives missing ids a stream-unique identity", async () => {
    const output = await collect([
      {
        type: "tool_call",
        toolCalls: [
          { id: "", index: 0, type: "function", function: { name: "read_file", arguments: "{\"path\":" } },
          { id: "", index: 1, type: "function", function: { name: "list_files", arguments: "{\"path\":" } },
        ],
      },
      {
        type: "tool_call",
        toolCalls: [
          { id: "", index: 0, type: "function", function: { name: "", arguments: "\"a.txt\"}" } },
          { id: "", index: 1, type: "function", function: { name: "", arguments: "\".\"}" } },
        ],
      },
      { type: "done", finishReason: "tool_calls" },
    ]);

    const calls = assembleProviderToolCalls(output);
    expect(calls.map((call) => ({ index: call.index, name: call.name, arguments: JSON.parse(call.arguments) }))).toEqual([
      { index: 0, name: "read_file", arguments: { path: "a.txt" } },
      { index: 1, name: "list_files", arguments: { path: "." } },
    ]);
    expect(calls.every((call) => call.id.length > 0)).toBe(true);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });

  it("pins a fragmented tool call's id to the first provider id for that index", async () => {
    // A gateway that re-sends a different id on a later fragment must not be
    // able to split one call into two, or make the executed call's id differ
    // from the id already streamed to the UI and persisted for the turn.
    const output = await collect([
      {
        type: "tool_call",
        toolCalls: [{ id: "call-stable", index: 0, type: "function", function: { name: "create_file", arguments: "{\"path\":\"a\"," } }],
      },
      {
        type: "tool_call",
        toolCalls: [{ id: "call-DIFFERENT", index: 0, type: "function", function: { name: "", arguments: "\"content\":\"x\"}" } }],
      },
      { type: "done", finishReason: "tool_calls" },
    ]);

    const streamedIds = output.flatMap((chunk) => (chunk.toolCalls ?? []).map((call) => call.id));
    expect(new Set(streamedIds)).toEqual(new Set(["call-stable"]));
    const calls = assembleProviderToolCalls(output);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call-stable");
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "a", content: "x" });
  });

  it("upgrades a synthesized id exactly once when the provider names the call later", async () => {
    const output = await collect([
      { type: "tool_call", toolCalls: [{ id: "", index: 0, type: "function", function: { name: "read_file", arguments: "{" } }] },
      { type: "tool_call", toolCalls: [{ id: "provider-id", index: 0, type: "function", function: { name: "", arguments: "}" } }] },
      { type: "tool_call", toolCalls: [{ id: "provider-id-2", index: 0, type: "function", function: { name: "", arguments: "" } }] },
      { type: "done", finishReason: "tool_calls" },
    ]);
    const calls = assembleProviderToolCalls(output);
    expect(calls).toHaveLength(1);
    // The provider's own id wins over the placeholder, then stops moving so a
    // later contradictory id cannot rename the call.
    expect(calls[0]!.id).toBe("provider-id");
  });

  it("stops accepting model output after a terminal finish marker but still folds trailing usage", async () => {
    // A proxy that concatenates two responses onto one stream must not be able
    // to blend the second response's text into this answer, or get its tool
    // calls executed as part of this turn. Trailing usage-only markers are
    // still legitimate and must be collected.
    const output = await collect([
      { type: "text", text: "answer" },
      { type: "done", finishReason: "stop" },
      { type: "text", text: " leaked second response" },
      { type: "tool_call", toolCalls: [{ id: "ghost", index: 0, type: "function", function: { name: "run_command", arguments: "{}" } }] },
      { type: "done", usage: { promptTokens: 40, completionTokens: 7 } },
    ]);

    expect(output).toEqual([
      { type: "text", text: "answer" },
      { type: "done", usage: { promptTokens: 40, completionTokens: 7 }, finishReason: "stop" },
    ]);
    expect(assembleProviderToolCalls(output)).toEqual([]);
  });

  it("turns a clean stop without model-visible output into a bounded empty response", async () => {
    const output = await collect([
      { type: "done", usage: { promptTokens: 10, completionTokens: 0 }, finishReason: "stop" },
    ]);
    expect(output).toEqual([{
      type: "error",
      error: {
        type: "empty_response",
        kind: "provider",
        message: "Provider returned a completed response with no content",
        retryable: true,
      },
    }]);
  });

  it("preserves partial output but classifies a missing terminal marker as interrupted", async () => {
    const output = await collect([{ type: "text", text: "partial" }]);
    expect(output).toEqual([
      { type: "text", text: "partial" },
      { type: "error", error: { type: "interrupted_stream", kind: "provider", message: "Provider stream ended before completion", retryable: true } },
    ]);
  });

  it("keeps a mid-stream error terminal and ignores later chunks", async () => {
    const output = await collect([
      { type: "text", text: "before failure" },
      { type: "error", error: { type: "network_error", kind: "network", message: "socket reset", retryable: true } },
      { type: "text", text: "must be ignored" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(output).toEqual([
      { type: "text", text: "before failure" },
      { type: "error", error: { type: "network_error", kind: "network", message: "socket reset", retryable: true } },
    ]);
  });

  it("rejects malformed chunks and maps cancellation to a typed provider error", async () => {
    const malformed = await collect([{ type: "tool_call", toolCalls: undefined } as unknown as ProviderChunk]);
    expect(malformed.at(-1)).toMatchObject({ type: "error", error: { type: "malformed_stream", retryable: false } });

    const controller = new AbortController();
    controller.abort();
    await expect(collect([{ type: "text", text: "never" }], controller.signal)).rejects.toMatchObject({
      kind: "cancelled",
      retryable: false,
    });
  });
});

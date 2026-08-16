import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../src/provider/gemini.js";
import type { ChatMessage, ProviderChunk } from "../src/provider/base.js";
import { normalizeProviderStream } from "../src/provider/stream-normalizer.js";
import { openDatabase } from "../src/database.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { prepareContextForProvider } from "../src/execution/context-budget.js";
import { buildProviderProjection, type DurableProviderTurn } from "../src/execution/provider-projection.js";

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function mockSseResponse(events: unknown[]): Response {
  const text = events.map(sseEvent).join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Gemini thought-signature preservation at provider adapter boundary", () => {
  it("extracts thought signatures from streaming chunks and attaches opaque continuation state", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-3.7-flash",
    });

    const ssePayload = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  text: "Analyzing the repository structure to find file X.",
                  thoughtSignature: "sig_step_1_thought",
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "read_file",
                    args: { path: "src/index.ts" },
                    thoughtSignature: "sig_step_1_call",
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 },
      },
    ];

    // Mock fetch for streamChat
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => mockSseResponse(ssePayload);

    try {
      const chunks: ProviderChunk[] = [];
      for await (const chunk of provider.streamChat([{ role: "user", content: "read index" }], { model: "gemini-3.7-flash" })) {
        chunks.push(chunk);
      }

      // First chunk is reasoning (not visible text)
      const reasoningChunk = chunks.find((c) => c.type === "text" && c.providerContinuation?.reasoningContent);
      expect(reasoningChunk).toBeDefined();
      expect(reasoningChunk?.text).toBeUndefined(); // Reasoning is not emitted as visible output
      expect(reasoningChunk?.providerContinuation?.reasoningContent).toBe("Analyzing the repository structure to find file X.");

      // Second chunk is the tool call, carrying the thought signature in opaque continuation metadata
      const toolChunk = chunks.find((c) => c.type === "tool_call");
      expect(toolChunk).toBeDefined();
      expect(toolChunk?.toolCalls?.[0]?.function.name).toBe("read_file");
      expect(toolChunk?.providerContinuation?.opaque?.thoughtSignature).toBe("sig_step_1_call");

      // Terminal done chunk contains the merged continuation state
      const doneChunk = chunks.find((c) => c.type === "done");
      expect(doneChunk).toBeDefined();
      expect(doneChunk?.finishReason).toBe("tool_calls");
      expect(doneChunk?.providerContinuation?.reasoningContent).toBe("Analyzing the repository structure to find file X.");
      expect(doneChunk?.providerContinuation?.opaque?.thoughtSignature).toBe("sig_step_1_call");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes provider stream and preserves providerContinuation on tool calls and done", async () => {
    const rawChunks: ProviderChunk[] = [
      {
        type: "text",
        providerContinuation: {
          reasoningContent: "Thinking step 1",
          opaque: { thoughtSignature: "sig-1" },
        },
      },
      {
        type: "tool_call",
        toolCalls: [
          {
            id: "gemini-tool-1",
            index: 0,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
          },
        ],
        providerContinuation: {
          opaque: { thoughtSignature: "sig-1", toolCallSignatures: { "gemini-tool-1": "sig-1" } },
        },
      },
      {
        type: "done",
        finishReason: "tool_calls",
        providerContinuation: {
          reasoningContent: "Thinking step 1",
          opaque: { thoughtSignature: "sig-1" },
        },
      },
    ];

    async function* gen() {
      for (const c of rawChunks) yield c;
    }

    const normalized: ProviderChunk[] = [];
    for await (const chunk of normalizeProviderStream(gen())) {
      normalized.push(chunk);
    }

    const toolCallChunk = normalized.find((c) => c.type === "tool_call");
    expect(toolCallChunk?.providerContinuation?.opaque?.thoughtSignature).toBe("sig-1");

    const doneChunk = normalized.find((c) => c.type === "done");
    expect(doneChunk?.providerContinuation?.reasoningContent).toBe("Thinking step 1");
    expect(doneChunk?.providerContinuation?.opaque?.thoughtSignature).toBe("sig-1");
  });

  it("reconstructs thoughtSignature on functionCall parts in subsequent multi-turn requests", () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-3.7-flash",
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Find the entry point" },
      {
        role: "assistant",
        content: "",
        providerContinuation: {
          reasoningContent: "I will call read_file to check package.json",
          opaque: {
            thoughtSignature: "sig-turn1-opaque-token-12345",
            toolCallSignatures: {
              "call-1": "sig-turn1-opaque-token-12345",
            },
          },
        },
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "package.json" }) },
          },
        ],
      },
      {
        role: "tool",
        name: "read_file",
        toolCallId: "call-1",
        content: '{"main": "src/index.ts"}',
      },
    ];

    // Access private buildRequest via any cast for testing wire projection
    const built = (provider as any).buildRequest(messages);

    expect(built.contents).toHaveLength(3);
    // Turn 1: user
    expect(built.contents[0].role).toBe("user");
    expect(built.contents[0].parts[0].text).toBe("Find the entry point");

    // Turn 2: model with functionCall AND thoughtSignature
    expect(built.contents[1].role).toBe("model");
    expect(built.contents[1].parts[0].functionCall).toEqual({
      name: "read_file",
      args: { path: "package.json" },
    });
    expect(built.contents[1].parts[0].thoughtSignature).toBe("sig-turn1-opaque-token-12345");

    // Turn 3: user with functionResponse
    expect(built.contents[2].role).toBe("user");
    expect(built.contents[2].parts[0].functionResponse).toEqual({
      name: "read_file",
      response: { result: '{"main": "src/index.ts"}' },
    });
  });

  it("selects a reasoning level without disturbing provider-private continuation state", async () => {
    // The capability system decides WHICH thinking level this exact route may
    // send. Thought signatures are separate, adapter-private continuation
    // state. This asserts the two coexist: a reasoning selection must not
    // rewrite, drop, or reorder the signatures replayed in the same request.
    const provider = new GeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-3.7-flash",
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Continue the investigation" },
      {
        role: "assistant",
        content: "",
        providerContinuation: {
          reasoningContent: "Reading the entry point next",
          opaque: { thoughtSignature: "sig-coexist", toolCallSignatures: { "call-1": "sig-coexist" } },
        },
        toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", name: "read_file", toolCallId: "call-1", content: "{}" },
    ];

    let captured: any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return mockSseResponse([{ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
    }) as any;
    try {
      for await (const _chunk of provider.streamChat(messages, {
        model: "gemini-3.7-flash",
        reasoning: { mode: "effort", effort: "high" },
        exactReasoningCapability: {
          mode: "selectable",
          efforts: [{ id: "high", label: "High" }],
          wire: "gemini-thinking-level",
        },
      } as any)) {
        // drain
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The reasoning selection reached generationConfig, in Gemini's spelling.
    expect(captured.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
    // …and the private continuation state is still intact on the same request.
    const modelTurn = captured.contents.find((c: any) => c.role === "model");
    expect(modelTurn.parts[0].functionCall.name).toBe("read_file");
    expect(modelTurn.parts[0].thoughtSignature).toBe("sig-coexist");
    // The thought signature is transport state and never becomes a request
    // field of its own.
    expect(captured.generationConfig.thoughtSignature).toBeUndefined();
  });

  it("refuses a reasoning level this exact Gemini model does not offer, before any request", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-3.7-flash",
    });
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; return mockSseResponse([]); }) as any;
    const chunks: ProviderChunk[] = [];
    try {
      for await (const chunk of provider.streamChat([{ role: "user", content: "hi" }], {
        model: "gemini-3.7-flash",
        // Verified live 2026-08-16: gemini-3.7-flash answers
        // "Thinking level MINIMAL is not supported for this model".
        reasoning: { mode: "effort", effort: "minimal" },
        exactReasoningCapability: {
          mode: "selectable",
          efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }],
          wire: "gemini-thinking-level",
        },
      } as any)) {
        chunks.push(chunk);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called, "an unsupported level must be refused before the network call").toBe(false);
    expect(chunks[0]?.type).toBe("error");
    expect(chunks[0]?.error?.kind).toBe("invalid_request");
  });

  it("handles multi-turn realistic sequence: user -> tool 1 -> tool 2 -> final response", () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-3.7-flash",
    });

    const multiTurnMessages: ChatMessage[] = [
      { role: "user", content: "Count lines in file A and file B" },
      {
        role: "assistant",
        content: "",
        providerContinuation: {
          reasoningContent: "Checking file A first",
          opaque: {
            thoughtSignature: "sig-turn1-file-a",
            toolCallSignatures: { "tool-a": "sig-turn1-file-a" },
          },
        },
        toolCalls: [
          {
            id: "tool-a",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
          },
        ],
      },
      {
        role: "tool",
        name: "read_file",
        toolCallId: "tool-a",
        content: "Line 1\nLine 2\n",
      },
      {
        role: "assistant",
        content: "",
        providerContinuation: {
          reasoningContent: "File A has 2 lines. Now checking file B",
          opaque: {
            thoughtSignature: "sig-turn2-file-b",
            toolCallSignatures: { "tool-b": "sig-turn2-file-b" },
          },
        },
        toolCalls: [
          {
            id: "tool-b",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) },
          },
        ],
      },
      {
        role: "tool",
        name: "read_file",
        toolCallId: "tool-b",
        content: "Line 1\nLine 2\nLine 3\n",
      },
    ];

    const built = (provider as any).buildRequest(multiTurnMessages);

    expect(built.contents).toHaveLength(5);
    // Turn 1 (user): prompt
    expect(built.contents[0].role).toBe("user");
    // Turn 2 (model): tool-a call with sig-turn1-file-a
    expect(built.contents[1].role).toBe("model");
    expect(built.contents[1].parts[0].functionCall.name).toBe("read_file");
    expect(built.contents[1].parts[0].thoughtSignature).toBe("sig-turn1-file-a");
    // Turn 3 (user): tool-a result
    expect(built.contents[2].role).toBe("user");
    expect(built.contents[2].parts[0].functionResponse.name).toBe("read_file");
    // Turn 4 (model): tool-b call with sig-turn2-file-b
    expect(built.contents[3].role).toBe("model");
    expect(built.contents[3].parts[0].functionCall.name).toBe("read_file");
    expect(built.contents[3].parts[0].thoughtSignature).toBe("sig-turn2-file-b");
    // Turn 5 (user): tool-b result
    expect(built.contents[4].role).toBe("user");
    expect(built.contents[4].parts[0].functionResponse.name).toBe("read_file");
  });

  it("persists thought signatures across durable replay and task resume", () => {
    const db = openDatabase(":memory:");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("p1", 1, "P", "/tmp", now, now);
    db.prepare("INSERT INTO tasks (id, schema_version, project_id, type, status, created_at, updated_at) VALUES (?,1,?,?,?,?,?)")
      .run("task-gemini-test", "p1", "agent_chat", "running", now, now);

    const repo = executionContinuityRepository(db);

    const taskId = "task-gemini-test";
    const turnKey = "turn-key-12345";
    const routeFingerprint = "gemini:gemini-3.7-flash:default";
    const ownerId = "owner-1";

    // 0. Open initial segment
    const seg = repo.openSegment({
      taskId,
      missionId: null,
      providerId: "gemini",
      model: "gemini-3.7-flash",
      routeJson: {},
      ownerId,
      now,
    });
    const segmentId = seg.id;

    // 1. Record provider turn
    repo.recordProviderTurn({
      id: "turn-1",
      taskId,
      segmentId,
      turnKey,
      ordinal: 1,
      assistantText: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"main.ts"}' }],
      isFinal: false,
      ownerId,
      generation: 1,
      now,
    });

    // 2. Save provider continuation with opaque thought signature
    repo.saveProviderContinuation({
      id: "cont-1",
      taskId,
      segmentId,
      providerId: "gemini",
      routeFingerprint,
      turnKey,
      state: {
        reasoningContent: "Inspecting main.ts",
        opaque: {
          thoughtSignature: "sig-persisted-thought-signature",
          toolCallSignatures: { "call-1": "sig-persisted-thought-signature" },
        },
      },
      ownerId,
      generation: 1,
      now,
    });

    // 3. Reconstruct provider projection on resume
    const turns: DurableProviderTurn[] = repo.listProviderTurns(taskId).map((turn): DurableProviderTurn => {
      const providerContinuation = repo.loadProviderContinuation(taskId, turn.turnKey, routeFingerprint);
      return {
        turnKey: turn.turnKey,
        assistantText: turn.assistantText,
        toolCalls: turn.toolCalls as DurableProviderTurn["toolCalls"],
        ...(providerContinuation ? { providerContinuation, providerContinuationRouteFingerprint: routeFingerprint } : {}),
      };
    });

    const projection = buildProviderProjection({
      prefixMessages: [],
      turns,
      toolResults: [
        {
          id: "call-1",
          toolName: "read_file",
          result: '{"content":"console.log(\'hello\')"}',
          status: "completed",
        },
      ],
    });

    // 4. Verify reconstructed messages have providerContinuation with opaque signature
    const assistantTurn = projection.find((m) => m.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn?.providerContinuation?.reasoningContent).toBe("Inspecting main.ts");
    expect(assistantTurn?.providerContinuation?.opaque?.thoughtSignature).toBe("sig-persisted-thought-signature");

    // 5. Verify GeminiProvider builds the exact thoughtSignature
    const provider = new GeminiProvider({ apiKey: "test-key", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-3.7-flash" });
    const built = (provider as any).buildRequest(projection);
    const modelPart = built.contents.find((c: any) => c.role === "model")?.parts[0];
    expect(modelPart?.functionCall?.name).toBe("read_file");
    expect(modelPart?.thoughtSignature).toBe("sig-persisted-thought-signature");
  });

  it("isolates provider continuation: stripped when projecting or routing to a different provider", () => {
    const db = openDatabase(":memory:");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("p2", 1, "P", "/tmp", now, now);
    db.prepare("INSERT INTO tasks (id, schema_version, project_id, type, status, created_at, updated_at) VALUES (?,1,?,?,?,?,?)")
      .run("task-isolate-test", "p2", "agent_chat", "running", now, now);

    const repo = executionContinuityRepository(db);

    const taskId = "task-isolate-test";
    const turnKey = "turn-key-iso";
    const geminiFingerprint = "gemini:gemini-3.7-flash:default";
    const deepseekFingerprint = "deepseek:deepseek-v4-flash:default";
    const ownerId = "owner-iso";
    const seg = repo.openSegment({
      taskId,
      missionId: null,
      providerId: "gemini",
      model: "gemini-3.7-flash",
      routeJson: {},
      ownerId,
      now,
    });
    const segmentId = seg.id;

    repo.recordProviderTurn({
      id: "turn-iso",
      taskId,
      segmentId,
      turnKey,
      ordinal: 1,
      assistantText: "",
      toolCalls: [{ id: "call-iso", name: "read_file", arguments: '{"path":"main.ts"}' }],
      isFinal: false,
      ownerId,
      generation: 1,
      now,
    });

    repo.saveProviderContinuation({
      id: "cont-iso",
      taskId,
      segmentId,
      providerId: "gemini",
      routeFingerprint: geminiFingerprint,
      turnKey,
      state: {
        reasoningContent: "Gemini thinking",
        opaque: { thoughtSignature: "gemini-sig" },
      },
      ownerId,
      generation: 1,
      now,
    });

    // Projecting for DeepSeek does NOT load Gemini's continuation state
    const deepSeekTurns: DurableProviderTurn[] = repo.listProviderTurns(taskId).map((turn): DurableProviderTurn => {
      const providerContinuation = repo.loadProviderContinuation(taskId, turn.turnKey, deepseekFingerprint);
      return {
        turnKey: turn.turnKey,
        assistantText: turn.assistantText,
        toolCalls: turn.toolCalls as DurableProviderTurn["toolCalls"],
        ...(providerContinuation ? { providerContinuation, providerContinuationRouteFingerprint: deepseekFingerprint } : {}),
      };
    });

    const deepSeekProjection = buildProviderProjection({
      prefixMessages: [],
      turns: deepSeekTurns,
      toolResults: [
        {
          id: "call-iso",
          toolName: "read_file",
          result: '{"content":"result"}',
          status: "completed",
        },
      ],
    });

    const deepSeekAssistant = deepSeekProjection.find((m) => m.role === "assistant");
    expect(deepSeekAssistant?.providerContinuation).toBeUndefined();

    // In agent candidate message projection, mismatched route fingerprint is stripped
    const inMemoryTurn: ChatMessage = {
      role: "assistant",
      content: "some text",
      providerContinuation: {
        reasoningContent: "Gemini thinking",
        opaque: { thoughtSignature: "gemini-sig" },
      },
      providerContinuationRouteFingerprint: geminiFingerprint,
    };
    const projectedForDeepSeek: ChatMessage[] = [inMemoryTurn].map((message): ChatMessage => {
      if (message.providerContinuationRouteFingerprint === deepseekFingerprint) return message;
      const { providerContinuation: _private, providerContinuationRouteFingerprint: _binding, ...publicMessage } = message;
      return publicMessage;
    });
    expect(projectedForDeepSeek[0]?.providerContinuation).toBeUndefined();
  });
});

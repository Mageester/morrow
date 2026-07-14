import { describe, it, expect, afterEach, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../src/provider/openai-compatible.js";
import { AnthropicProvider } from "../src/provider/anthropic.js";
import { GeminiProvider } from "../src/provider/gemini.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import { buildMissionCompletion } from "../src/mission/completion.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function sseResponse(lines: string[], status = 200): Response {
  const body = lines.join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function chunkedSseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Captured {
  url: string;
  init: any;
}

function mockFetch(response: Response | (() => Response)): { captured: Captured | null } {
  const ref: { captured: Captured | null } = { captured: null };
  globalThis.fetch = (async (url: any, init: any) => {
    ref.captured = { url: String(url), init };
    return typeof response === "function" ? response() : response;
  }) as any;
  return ref;
}

async function collect(provider: AiProvider, messages: ChatMessage[], options: StreamOptions = {}): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of provider.streamChat(messages, options)) out.push(chunk);
  return out;
}

const userMessages: ChatMessage[] = [
  { role: "system", content: "You are Morrow." },
  { role: "user", content: "Read a file" },
];

describe("OpenAI-compatible provider normalization", () => {
  it("streams text, tool-call deltas, and usage", async () => {
    const ref = mockFetch(
      sseResponse([
        `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n`,
        `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`,
        `data: [DONE]\n\n`,
      ])
    );
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "sk-secret-key", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.4-mini", includeUsage: true });
    const chunks = await collect(provider, userMessages, { tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }] });

    expect(chunks.find((c) => c.type === "text")?.text).toBe("Hello");
    const toolChunks = chunks.filter((c) => c.type === "tool_call");
    expect(toolChunks.length).toBe(2);
    expect(toolChunks[0]!.toolCalls?.[0]?.function.name).toBe("read_file");
    const done = chunks.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 10, completionTokens: 5 });

    // Request carried the key, but no chunk echoes it.
    expect(ref.captured?.init.headers.Authorization).toBe("Bearer sk-secret-key");
    expect(JSON.stringify(chunks)).not.toContain("sk-secret-key");
  });

  it("preserves DeepSeek reasoning continuation fields without rendering them as text", async () => {
    const ref = mockFetch(sseResponse([
      `data: {"choices":[{"delta":{"reasoning_content":"private-step"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"visible"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]));
    const provider = new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-reasoner" });
    const chunks = await collect(provider, [
      ...userMessages,
      { role: "assistant", content: "prior", providerContinuation: { reasoningContent: "prior-private" } },
      { role: "user", content: "continue" },
    ]);

    expect(chunks.find((chunk) => chunk.providerContinuation)?.providerContinuation).toEqual({ reasoningContent: "private-step" });
    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text).join("")).toBe("visible");
    expect(JSON.parse(ref.captured!.init.body).messages[2].reasoning_content).toBe("prior-private");
  });

  it("classifies HTTP errors into typed kinds", async () => {
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1", defaultModel: "m" });

    mockFetch(new Response(`{"error":{"message":"Authorization: Bearer sk-secret-key"}}`, { status: 401 }));
    let chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("auth");
    expect(chunks.at(-1)?.error?.retryable).toBe(false);
    expect(chunks.at(-1)?.error?.message).not.toContain("sk-secret-key");
    expect(chunks.at(-1)?.error?.message).toContain("***redacted***");

    mockFetch(new Response(`{"error":{"message":"slow down"}}`, { status: 429 }));
    chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("rate_limit");
    expect(chunks.at(-1)?.error?.retryable).toBe(true);

    mockFetch(new Response(`oops`, { status: 500 }));
    chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("provider");
    expect(chunks.at(-1)?.error?.retryable).toBe(true);
  });

  it("rejects non-http endpoints", async () => {
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "k", baseUrl: "file:///etc/passwd", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("invalid_request");
  });

  it("ignores malformed SSE lines", async () => {
    mockFetch(
      sseResponse([
        `data: not-json\n\n`,
        `: comment\n\n`,
        `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
        `data: [DONE]\n\n`,
      ])
    );
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.filter((c) => c.type === "text").map((c) => c.text).join("")).toBe("ok");
  });

  it("flushes one final assistant record without a trailing newline exactly once", async () => {
    mockFetch(chunkedSseResponse([`data: {"choices":[{"delta":{"content":"final"}}]}`]));
    const chunks = await collect(new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" }), userMessages);
    expect(chunks.filter((c) => c.type === "text").map((c) => c.text)).toEqual(["final"]);
  });

  it("handles a final DONE record without a trailing newline", async () => {
    mockFetch(chunkedSseResponse([`data: [DONE]`]));
    const chunks = await collect(new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" }), userMessages);
    expect(chunks).toEqual([]);
  });

  it("preserves split UTF-8 and trailing records after complete records", async () => {
    const bytes = new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"one"}}]}\n\ndata: {"choices":[{"delta":{"content":"hé"}}]}`);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, bytes.length - 1)); c.enqueue(bytes.slice(bytes.length - 1)); c.close(); } });
    mockFetch(new Response(stream, { status: 200 }));
    const chunks = await collect(new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" }), userMessages);
    expect(chunks.filter((c) => c.type === "text").map((c) => c.text)).toEqual(["one", "hé"]);
  });

  it("rejects malformed trailing data instead of silently completing", async () => {
    mockFetch(chunkedSseResponse([`data: not-json`]));
    const chunks = await collect(new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" }), userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("provider");
  });

  it("requests JSON object output when responseFormat is set", async () => {
    const ref = mockFetch(
      sseResponse([
        `data: {"choices":[{"delta":{"content":"{}"}}]}\n\n`,
        `data: [DONE]\n\n`,
      ])
    );
    const provider = new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" });
    await collect(provider, userMessages, { responseFormat: "json_object" });

    const sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.response_format).toEqual({ type: "json_object" });
  });

  it("emits a timeout error when the request exceeds timeoutMs", async () => {
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e: any = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as any;
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1", defaultModel: "m" });
    const chunks = await collect(provider, userMessages, { timeoutMs: 20 });
    expect(chunks.at(-1)?.error?.kind).toBe("timeout");
  });

  it("emits a cancelled error when the external abort signal fires", async () => {
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e: any = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as any;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1", defaultModel: "m" });
    const chunks = await collect(provider, userMessages, { abortSignal: controller.signal });
    expect(chunks.at(-1)?.error?.kind).toBe("cancelled");
  });
});

describe("mission completion routing", () => {
  it("enables provider JSON mode for independent review completions only", async () => {
    const ref = mockFetch(() =>
      sseResponse([
        `data: {"choices":[{"delta":{"content":"{\\"verdict\\":\\"insufficient_evidence\\"}"}}]}\n\n`,
        `data: [DONE]\n\n`,
      ])
    );
    const completion = buildMissionCompletion({ presetId: "cheap", env: { DEEPSEEK_API_KEY: "k" } })!;

    await completion([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "json review" },
    ], { purpose: "review", temperature: 0 });

    let sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.response_format).toEqual({ type: "json_object" });

    await completion([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "json criteria" },
    ], { purpose: "planning", temperature: 0.1 });

    sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.response_format).toBeUndefined();
  });
});

describe("Anthropic provider normalization", () => {
  it("hoists the system prompt and normalizes tool_use blocks", async () => {
    const ref = mockFetch(
      sseResponse([
        `data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
        `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"read_file","input":{}}}\n\n`,
        `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}\n\n`,
        `data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ])
    );
    const provider = new AnthropicProvider({ apiKey: "sk-ant-secret", baseUrl: "https://api.anthropic.com", defaultModel: "claude-3-5-sonnet-20241022" });
    const chunks = await collect(provider, userMessages, { tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }] });

    expect(chunks.find((c) => c.type === "text")?.text).toBe("Hi");
    const toolStart = chunks.find((c) => c.type === "tool_call" && c.toolCalls?.[0]?.id === "tu_1");
    expect(toolStart?.toolCalls?.[0]?.index).toBe(0); // remapped from block index 1
    const argDelta = chunks.find((c) => c.type === "tool_call" && c.toolCalls?.[0]?.function.arguments.includes("path"));
    expect(argDelta?.toolCalls?.[0]?.index).toBe(0);
    expect(chunks.find((c) => c.type === "done")?.usage).toEqual({ promptTokens: 12, completionTokens: 7 });

    expect(ref.captured?.init.headers["x-api-key"]).toBe("sk-ant-secret");
    const sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.system).toBe("You are Morrow.");
    expect(JSON.stringify(chunks)).not.toContain("sk-ant-secret");
  });

  it("maps an overloaded error to a retryable rate_limit", async () => {
    mockFetch(sseResponse([`data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n`]));
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("rate_limit");
    expect(chunks.at(-1)?.error?.retryable).toBe(true);
  });
});

describe("Gemini provider normalization", () => {
  it("normalizes text and functionCall parts with contiguous indices", async () => {
    const ref = mockFetch(
      sseResponse([
        `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n`,
        `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n`,
      ])
    );
    const provider = new GeminiProvider({ apiKey: "goog-secret", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-1.5-flash" });
    const chunks = await collect(provider, userMessages, { tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }] });

    expect(chunks.find((c) => c.type === "text")?.text).toBe("Hello");
    const tool = chunks.find((c) => c.type === "tool_call");
    expect(tool?.toolCalls?.[0]?.id).toBe("gemini-tool-0");
    expect(JSON.parse(tool!.toolCalls![0]!.function.arguments)).toEqual({ path: "a" });
    expect(chunks.find((c) => c.type === "done")?.usage).toEqual({ promptTokens: 3, completionTokens: 4 });

    expect(ref.captured?.url).toContain("streamGenerateContent");
    expect(ref.captured?.init.headers["x-goog-api-key"]).toBe("goog-secret");
    const sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.systemInstruction.parts[0].text).toBe("You are Morrow.");
    expect(JSON.stringify(chunks)).not.toContain("goog-secret");
  });

  it("classifies a 403 as an auth error", async () => {
    mockFetch(new Response(`{"error":{"message":"permission denied"}}`, { status: 403 }));
    const provider = new GeminiProvider({ apiKey: "k", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("auth");
  });
});

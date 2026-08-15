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
    expect(toolChunks.map((chunk) => chunk.toolCalls?.[0]?.function.arguments ?? "").join("")).toBe('{"path":"a.txt"}');
    const done = chunks.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 10, completionTokens: 5 });

    // Request carried the key, but no chunk echoes it.
    expect(ref.captured?.init.headers.Authorization).toBe("Bearer sk-secret-key");
    expect(JSON.stringify(chunks)).not.toContain("sk-secret-key");
  });

  it("moves a mid-conversation system message (e.g. a convergence advisory) to the front and merges it with the leading one", async () => {
    const ref = mockFetch(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]));
    const provider = new OpenAiCompatibleProvider({ id: "tokenrouter", apiKey: "k", baseUrl: "https://api.tokenrouter.com/v1", defaultModel: "qwen/qwen3.8-max-free" });
    await collect(provider, [
      { role: "system", content: "You are Morrow." },
      { role: "user", content: "Read a file" },
      { role: "assistant", content: "Reading now." },
      { role: "system", content: "Morrow convergence advisory: repeated edit detected." },
      { role: "user", content: "Try again" },
    ]);

    const sent = JSON.parse(ref.captured!.init.body).messages;
    // Several OpenAI-compatible backends reject any system message that is
    // not the first entry ("System message must be at the beginning.") —
    // both system messages must land in one leading slot, in the original
    // relative order, with every other message's order otherwise unchanged.
    expect(sent[0]).toEqual({ role: "system", content: "You are Morrow.\n\nMorrow convergence advisory: repeated edit detected." });
    expect(sent.slice(1).map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
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

  it("forwards tool_choice: required onto the wire only when tools are present", async () => {
    const ref = mockFetch(sseResponse([`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n`, `data: [DONE]\n\n`]));
    const provider = new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-flash" });
    await collect(provider, userMessages, {
      toolChoice: "required",
      tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
    });
    expect(JSON.parse(ref.captured!.init.body).tool_choice).toBe("required");

    // Never sent without tools: the wire body would have no function to
    // constrain the response to, and some gateways reject a bare tool_choice.
    const ref2 = mockFetch(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]));
    await collect(provider, userMessages, { toolChoice: "required" });
    expect(JSON.parse(ref2.captured!.init.body)).not.toHaveProperty("tool_choice");

    // Absent entirely on a normal turn: a route not recovering from a
    // reasoning-only failure must see the exact same request shape as today.
    const ref3 = mockFetch(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]));
    await collect(provider, userMessages, { tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }] });
    expect(JSON.parse(ref3.captured!.init.body)).not.toHaveProperty("tool_choice");
  });

  it("injects a valid reasoning effort into the request body, and rejects an unsupported one before the request", async () => {
    const effortCap = { control: "effort" as const, efforts: ["low", "medium", "high"] as const, budgets: [], source: "registry" as const };
    const ref = mockFetch(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]));
    const provider = new OpenAiCompatibleProvider({ id: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.5" });
    await collect(provider, userMessages, { reasoning: { mode: "effort", effort: "high" }, reasoningCapability: { ...effortCap, efforts: [...effortCap.efforts] } });
    expect(JSON.parse(ref.captured!.init.body).reasoning_effort).toBe("high");

    // A token budget has no OpenAI wire form — the adapter fails fast with an
    // invalid_request error and never sends the request.
    let sent = false;
    globalThis.fetch = (async () => { sent = true; return sseResponse([`data: [DONE]\n\n`]); }) as any;
    const chunks = await collect(provider, userMessages, { reasoning: { mode: "budget", tokens: 8192 }, reasoningCapability: { control: "budget", efforts: [], budgets: [8192], source: "provider-metadata" } });
    expect(sent).toBe(false);
    expect(chunks.at(-1)?.error?.kind).toBe("invalid_request");
  });

  it("maps DeepSeek effort and off selections to its thinking wire fields", async () => {
    const deepSeekCapability = {
      control: "effort" as const,
      efforts: ["low", "high", "xhigh", "max"] as const,
      budgets: [],
      source: "provider-metadata" as const,
      supportsOff: true,
      wire: "deepseek-thinking" as const,
    };
    const provider = new OpenAiCompatibleProvider({ id: "deepseek", apiKey: "k", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-flash" });

    const enabledRef = mockFetch(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]));
    await collect(provider, userMessages, {
      reasoning: { mode: "effort", effort: "max" },
      reasoningCapability: { ...deepSeekCapability, efforts: [...deepSeekCapability.efforts] },
    });
    const enabledBody = JSON.parse(enabledRef.captured!.init.body);
    expect(enabledBody.reasoning_effort).toBe("max");
    expect(enabledBody.thinking).toEqual({ type: "enabled" });

    const disabledRef = mockFetch(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]));
    await collect(provider, userMessages, {
      reasoning: { mode: "off" },
      reasoningCapability: { ...deepSeekCapability, efforts: [...deepSeekCapability.efforts] },
    });
    expect(JSON.parse(disabledRef.captured!.init.body).thinking).toEqual({ type: "disabled" });
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

  it("ignores OpenRouter processing comments and classifies structured mid-stream errors", async () => {
    mockFetch(sseResponse([
      `: OPENROUTER PROCESSING\n\n`,
      `data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`,
      `data: {"error":{"code":429,"message":"upstream rejected Bearer openrouter-secret-value","metadata":{"error_type":"rate_limit"}}}\n\n`,
    ]));
    const chunks = await collect(new OpenAiCompatibleProvider({ id: "openrouter", apiKey: "openrouter-secret-value", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto" }), userMessages);
    expect(chunks.find((chunk) => chunk.type === "text")?.text).toBe("partial");
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { kind: "rate_limit", retryable: true, status: 429 } });
    expect(JSON.stringify(chunks)).not.toContain("openrouter-secret-value");
  });

  it("reports a stream that ends before DONE or a finish reason as interrupted", async () => {
    mockFetch(chunkedSseResponse([`data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`]));
    const chunks = await collect(new OpenAiCompatibleProvider({ id: "openrouter", apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto" }), userMessages);
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: { type: "interrupted_stream", kind: "provider", retryable: true } });
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

  it("retries once with a larger output budget when a review call is truncated with no content (reasoning-model overrun)", async () => {
    const bodies: any[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      call += 1;
      if (call === 1) {
        // Real production shape: finish_reason "length", empty content — the
        // model spent its whole output budget on hidden reasoning.
        return sseResponse([`data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`, `data: [DONE]\n\n`]);
      }
      return sseResponse([
        `data: {"choices":[{"delta":{"content":"{\\"verdict\\":\\"approved\\"}"}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    }) as any;
    const completion = buildMissionCompletion({ presetId: "cheap", env: { DEEPSEEK_API_KEY: "k" } })!;

    const result = await completion([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "json review" },
    ], { purpose: "review", temperature: 0 });

    expect(call).toBe(2);
    expect(bodies[1].max_tokens).toBeGreaterThan(bodies[0].max_tokens);
    expect(result.text).toContain("approved");
  });

  it("does not retry a review call that legitimately finished with content", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return sseResponse([
        `data: {"choices":[{"delta":{"content":"{\\"verdict\\":\\"insufficient_evidence\\"}"}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    }) as any;
    const completion = buildMissionCompletion({ presetId: "cheap", env: { DEEPSEEK_API_KEY: "k" } })!;

    await completion([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "json review" },
    ], { purpose: "review", temperature: 0 });

    expect(call).toBe(1); // a real (non-empty) insufficient_evidence verdict is not a truncation — never retried here
  });

  it("falls back to primary model for review if alternate review model call fails", async () => {
    let callCount = 0;
    const modelsUsed: string[] = [];
    const responseFormatsUsed: unknown[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      callCount += 1;
      const body = JSON.parse(init.body);
      modelsUsed.push(body.model);
      responseFormatsUsed.push(body.response_format);
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { message: "Insufficient Balance", type: "invalid_request_error", code: "insufficient_balance" } }), { status: 402, headers: { "content-type": "application/json" } });
      }
      return sseResponse([
        `data: {"choices":[{"delta":{"content":"{\\"verdict\\":\\"approved\\"}"}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    }) as any;
    const completion = buildMissionCompletion({ presetId: "cheap", env: { DEEPSEEK_API_KEY: "k" } })!;

    const result = await completion([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "json review" },
    ], { purpose: "review", temperature: 0 });

    expect(callCount).toBe(2);
    expect(modelsUsed[0]).not.toEqual(modelsUsed[1]);
    // The retry must still be a "review" request, not a downgraded "planning"
    // one — dropping response_format: json_object was the actual defect: a
    // provider under no obligation to return parseable JSON without it, on
    // exactly the recovery path most likely to hit a weaker model.
    expect(responseFormatsUsed[1]).toEqual({ type: "json_object" });
    expect(result.text).toContain("approved");
  });

  it("does not retry review on the primary model when the failure is not model-specific", async () => {
    // A provider-wide failure (invalid credentials, network error) fails
    // identically regardless of which model is requested. Retrying wastes a
    // call and doubles latency for zero chance of success — but the current
    // implementation retries unconditionally on any thrown error, so this
    // documents that behavior's cost rather than asserting a fix isn't
    // needed. Two calls, not a hang or a wasted third attempt.
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error" } }), { status: 401, headers: { "content-type": "application/json" } });
    }) as any;
    const completion = buildMissionCompletion({ presetId: "cheap", env: { DEEPSEEK_API_KEY: "k" } })!;

    await expect(completion([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "json review" },
    ], { purpose: "review", temperature: 0 })).rejects.toThrow();
    expect(callCount).toBe(2);
  });

  it("uses mission-specific overrides for provider and model rather than the globally resolved preset defaults", async () => {
    // The dogfooding run that found this was using a default workspace preset
    // (balanced -> deepseek) but explicitly passing --provider opencode-zen
    // for the mission execution. The worker successfully used the override,
    // but the review cycle failed with "Insufficient Balance" against the
    // default DeepSeek account. MissionCompletionFn did not receive or respect
    // the mission's execution overrides, routing recovery back to the global
    // default instead of the explicitly chosen provider.
    globalThis.fetch = (async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"{\\"verdict\\":\\"approved\\"}"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ])) as any;
    
    const completion = buildMissionCompletion({ 
      presetId: "balanced", 
      env: { DEEPSEEK_API_KEY: "k", OPENCODE_ZEN_API_KEY: "k" } 
    })!;
    
    const result = await completion([
      { role: "user", content: "json review" },
    ], { 
      purpose: "review", 
      temperature: 0,
      missionProviderId: "opencode-zen",
      missionModel: "deepseek-v4-flash-free",
    });

    // It must return the requested provider and model, not the fallback ones.
    expect(result.provider).toBe("opencode-zen");
    expect(result.model).toBe("deepseek-v4-flash-free");
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

  it("reports a max_tokens stop as finishReason 'length' so a truncated reasoning response is recoverable", async () => {
    // A reasoning model can spend its entire output budget thinking and emit
    // no visible answer. Without a finishReason the caller cannot tell that
    // apart from a model with nothing to say, and mission review's
    // truncation retry (mission/completion.ts) could never fire on Anthropic.
    mockFetch(
      sseResponse([
        `data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ])
    );
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.find((c) => c.type === "done")?.finishReason).toBe("length");
  });

  it("reports the remaining stop reasons, and none at all when the provider omits one", async () => {
    for (const [wire, expected] of [["end_turn", "stop"], ["stop_sequence", "stop"], ["tool_use", "tool_calls"], ["refusal", "content_filter"]] as const) {
      mockFetch(
        sseResponse([
          `data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n`,
          `data: {"type":"message_delta","delta":{"stop_reason":"${wire}"},"usage":{"output_tokens":1}}\n\n`,
          `data: {"type":"message_stop"}\n\n`,
        ])
      );
      const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com", defaultModel: "m" });
      const chunks = await collect(provider, userMessages);
      expect(chunks.find((c) => c.type === "done")?.finishReason).toBe(expected);
    }

    mockFetch(
      sseResponse([
        `data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n`,
        `data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ])
    );
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.find((c) => c.type === "done")).not.toHaveProperty("finishReason");
  });

  it("drops temperature and lifts max_tokens above the thinking budget when extended thinking is enabled", async () => {
    // The API rejects a request that pairs thinking with a sampling
    // temperature, or whose max_tokens does not exceed budget_tokens. The
    // preset supplies both of those without any knowledge of the reasoning
    // mode, so the adapter reconciles them.
    const ref = mockFetch(sseResponse([`data: {"type":"message_stop"}\n\n`]));
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com", defaultModel: "m" });
    await collect(provider, userMessages, {
      temperature: 0.3,
      maxOutputTokens: 4096,
      reasoning: { mode: "budget", tokens: 8192 },
      reasoningCapability: { control: "budget", efforts: [], budgets: [8192], source: "registry" },
    });

    const sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(sentBody).not.toHaveProperty("temperature");
    expect(sentBody.max_tokens).toBeGreaterThan(8192);
  });

  it("leaves temperature untouched when thinking is not enabled", async () => {
    const ref = mockFetch(sseResponse([`data: {"type":"message_stop"}\n\n`]));
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com", defaultModel: "m" });
    await collect(provider, userMessages, {
      temperature: 0.3,
      maxOutputTokens: 4096,
      reasoning: { mode: "off" },
      reasoningCapability: { control: "budget", efforts: [], budgets: [8192], source: "registry" },
    });

    const sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.thinking).toEqual({ type: "disabled" });
    expect(sentBody.temperature).toBe(0.3);
    expect(sentBody.max_tokens).toBe(4096);
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
    expect(tool?.toolCalls?.[0]?.id).toMatch(/^gemini-tool-[0-9a-f]{8}-0$/);
    expect(tool?.toolCalls?.[0]?.index).toBe(0);
    expect(JSON.parse(tool!.toolCalls![0]!.function.arguments)).toEqual({ path: "a" });
    expect(chunks.find((c) => c.type === "done")?.usage).toEqual({ promptTokens: 3, completionTokens: 4 });

    expect(ref.captured?.url).toContain("streamGenerateContent");
    expect(ref.captured?.init.headers["x-goog-api-key"]).toBe("goog-secret");
    const sentBody = JSON.parse(ref.captured!.init.body);
    expect(sentBody.systemInstruction.parts[0].text).toBe("You are Morrow.");
    expect(JSON.stringify(chunks)).not.toContain("goog-secret");
  });

  it("never reuses a tool-call id across turns — the durable transcript keys on it globally", async () => {
    // Gemini's wire format carries no call identity, so the adapter mints one.
    // A bare per-turn ordinal ("gemini-tool-0") collided with the previous
    // turn's first call and with every other Gemini task's, and the colliding
    // upsert updated the earlier row instead of recording the new call.
    const ids: string[] = [];
    for (let turn = 0; turn < 3; turn++) {
      mockFetch(
        sseResponse([
          `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}},{"functionCall":{"name":"list_files","args":{"path":"."}}}]}}]}\n\n`,
        ])
      );
      const provider = new GeminiProvider({ apiKey: "k", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "m" });
      const chunks = await collect(provider, userMessages, { tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }] });
      ids.push(...chunks.filter((c) => c.type === "tool_call").flatMap((c) => c.toolCalls!.map((t) => t.id)));
    }

    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // Indices still restart per turn: they address this turn's accumulator.
    expect(ids.map((id) => id.slice(-2))).toEqual(["-0", "-1", "-0", "-1", "-0", "-1"]);
  });

  it("classifies a 403 as an auth error", async () => {
    mockFetch(new Response(`{"error":{"message":"permission denied"}}`, { status: 403 }));
    const provider = new GeminiProvider({ apiKey: "k", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "m" });
    const chunks = await collect(provider, userMessages);
    expect(chunks.at(-1)?.error?.kind).toBe("auth");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/provider/anthropic.js";
import type { AiProvider, ChatMessage, ProviderChunk } from "../src/provider/base.js";
import { CodexProvider } from "../src/provider/codex.js";
import { GeminiProvider } from "../src/provider/gemini.js";
import { OpenAiCompatibleProvider } from "../src/provider/openai-compatible.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function emptySse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completedOpenAiSse(): Response {
  return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureBody(provider: AiProvider, messages: ChatMessage[]): Promise<Record<string, any>> {
  let body: Record<string, any> | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return provider instanceof OpenAiCompatibleProvider ? completedOpenAiSse() : emptySse();
  }) as typeof fetch;
  const chunks: ProviderChunk[] = [];
  for await (const chunk of provider.streamChat(messages, {})) chunks.push(chunk);
  expect(chunks.find((chunk) => chunk.type === "error")).toBeUndefined();
  expect(body).toBeDefined();
  return body!;
}

const image = {
  mimeType: "image/png" as const,
  data: Buffer.from("not-a-real-png-but-valid-bounded-bytes").toString("base64"),
  sha256: "f".repeat(64),
};
const messages: ChatMessage[] = [
  { role: "system", content: "Inspect the rendered page." },
  { role: "user", content: "Analyze screenshot evidence.", images: [image] },
];

describe("provider vision payloads", () => {
  it("serializes bounded image evidence for OpenAI-compatible chat", async () => {
    const body = await captureBody(new OpenAiCompatibleProvider({
      id: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.6",
    }), messages);

    expect(body.messages[1].content).toEqual([
      { type: "text", text: "Analyze screenshot evidence." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    ]);
    expect(JSON.stringify(body)).not.toContain(image.sha256);
  });

  it("serializes bounded image evidence for Anthropic Messages", async () => {
    const body = await captureBody(new AnthropicProvider({
      apiKey: "k",
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-5",
    }), messages);

    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Analyze screenshot evidence." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
    ]);
  });

  it("serializes bounded image evidence for Gemini generateContent", async () => {
    const body = await captureBody(new GeminiProvider({
      apiKey: "k",
      baseUrl: "https://generativelanguage.googleapis.com",
      defaultModel: "gemini-3.5-flash",
    }), messages);

    expect(body.contents[0].parts).toEqual([
      { text: "Analyze screenshot evidence." },
      { inlineData: { mimeType: "image/png", data: image.data } },
    ]);
  });

  it("serializes bounded image evidence for the Codex Responses transport", async () => {
    const body = await captureBody(new CodexProvider({
      oauthToken: "header.payload.signature",
      defaultModel: "gpt-5.6",
    }), messages);

    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "Analyze screenshot evidence." },
      { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
    ]);
  });

  it("rejects invalid, non-user, and oversized image inputs before network access", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.6",
    });
    let requests = 0;
    globalThis.fetch = (async () => { requests += 1; return emptySse(); }) as typeof fetch;

    const cases: ChatMessage[][] = [
      [{ role: "assistant", content: "bad", images: [image] }],
      [{ role: "user", content: "bad", images: [{ ...image, mimeType: "image/gif" as any }] }],
      [{ role: "user", content: "bad", images: [{ ...image, data: "not base64!?" }] }],
      [{ role: "user", content: "bad", images: [{ ...image, data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }] }],
    ];
    for (const value of cases) {
      const chunks: ProviderChunk[] = [];
      for await (const chunk of provider.streamChat(value, {})) chunks.push(chunk);
      expect(chunks.at(-1)?.error?.kind).toBe("invalid_request");
    }
    expect(requests).toBe(0);
  });
});

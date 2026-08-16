import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/provider/anthropic.js";
import { CodexProvider } from "../src/provider/codex.js";
import { GeminiProvider } from "../src/provider/gemini.js";
import { OpenAiCompatibleProvider } from "../src/provider/openai-compatible.js";
import type { AiProvider, ChatMessage, ProviderChunk, ProviderProtocol, StreamOptions } from "../src/provider/base.js";

/**
 * Every adapter must normalize the same situations into the same
 * `ProviderChunk` sequence. This is a conformance suite, not four adapter
 * tests: each adapter declares its own wire encoding of one shared set of
 * canned scenarios, and the assertions run identically across all of them.
 *
 * It exists because Morrow fixed `finishReason` as an instance and left the
 * class open. `anthropic.ts` learned to report `stop_reason`; `gemini.ts` and
 * `codex.ts` stayed silent, so `mission/completion.ts`'s review-retry — which
 * fires only on `finishReason === "length"` — was dead on those routes exactly
 * as it had been on Anthropic. Nothing about a per-adapter test would have
 * caught that. A shared table does: an adapter that cannot report truncation
 * fails the same case its peers pass, and a new adapter that is not registered
 * here fails the coverage assertion below rather than shipping unchecked.
 */

const PROVIDER_SOURCE_DIR = join(__dirname, "..", "src", "provider");

type ScenarioName = "stop" | "truncated" | "tool_use" | "empty_stop";

/** The canned tool call every adapter's `tool_use` scenario must produce, in
 * order. Two calls, so id uniqueness is exercised within a stream as well as
 * across streams. */
const EXPECTED_TOOL_CALLS = [
  { name: "read_file", args: { path: "a.txt" } },
  { name: "list_files", args: { path: "." } },
] as const;

/** The visible text every `stop` scenario must deliver, and the partial text a
 * `truncated` scenario must still deliver rather than discard. */
const STOP_TEXT = "Hello world";
const TRUNCATED_TEXT = "Hello wo";

interface WireAdapter {
  /** Class name exactly as declared in its source file. */
  className: string;
  sourceFile: string;
  protocol: ProviderProtocol;
  /** A distinctive credential, asserted never to appear in any emitted chunk. */
  secret: string;
  make(): AiProvider;
  /** SSE records for each shared scenario, in this protocol's own wire format. */
  wire: Record<ScenarioName, string[]>;
  /**
   * A mid-stream failure record, or null when the protocol has no such shape.
   * Explicit either way: a new adapter must state which it is, and a `null`
   * must say why.
   */
  streamError: { records: string[] } | { records: null; reason: string };
}

const ANTHROPIC_SECRET = "sk-ant-conformance-secret";
const OPENAI_SECRET = "sk-openai-conformance-secret";
const GEMINI_SECRET = "goog-conformance-secret";
// Codex authenticates with an OAuth JWT; the header builder parses it for the
// account claim and tolerates one it cannot decode.
const CODEX_SECRET = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJjb25mb3JtYW5jZSJ9.conformance-signature";

const ADAPTERS: WireAdapter[] = [
  {
    className: "OpenAiCompatibleProvider",
    sourceFile: "openai-compatible.ts",
    protocol: "openai-chat",
    secret: OPENAI_SECRET,
    make: () => new OpenAiCompatibleProvider({ id: "openai", apiKey: OPENAI_SECRET, baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.5", includeUsage: true }),
    wire: {
      stop: [
        `data: {"choices":[{"delta":{"content":"${STOP_TEXT}"}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ],
      empty_stop: [
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ],
      truncated: [
        `data: {"choices":[{"delta":{"content":"${TRUNCATED_TEXT}"}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`,
        `data: [DONE]\n\n`,
      ],
      tool_use: [
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_conf_a","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_conf_b","function":{"name":"list_files","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
        `data: [DONE]\n\n`,
      ],
    },
    streamError: { records: [`data: {"error":{"code":429,"message":"upstream is rate limiting"}}\n\n`] },
  },
  {
    className: "AnthropicProvider",
    sourceFile: "anthropic.ts",
    protocol: "anthropic-messages",
    secret: ANTHROPIC_SECRET,
    make: () => new AnthropicProvider({ apiKey: ANTHROPIC_SECRET, baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-5" }),
    wire: {
      stop: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${STOP_TEXT}"}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
      empty_stop: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
      truncated: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${TRUNCATED_TEXT}"}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
      tool_use: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_conf_a","name":"read_file","input":{}}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}\n\n`,
        `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_conf_b","name":"list_files","input":{}}}\n\n`,
        `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\".\\"}"}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    },
    streamError: { records: [`data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n`] },
  },
  {
    className: "GeminiProvider",
    sourceFile: "gemini.ts",
    protocol: "gemini-generate-content",
    secret: GEMINI_SECRET,
    make: () => new GeminiProvider({ apiKey: GEMINI_SECRET, baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-3-pro" }),
    wire: {
      stop: [
        `data: {"candidates":[{"content":{"parts":[{"text":"${STOP_TEXT}"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":5}}\n\n`,
      ],
      empty_stop: [
        `data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":0}}\n\n`,
      ],
      truncated: [
        `data: {"candidates":[{"content":{"parts":[{"text":"${TRUNCATED_TEXT}"}]},"finishReason":"MAX_TOKENS"}]}\n\n`,
      ],
      tool_use: [
        `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}},{"functionCall":{"name":"list_files","args":{"path":"."}}}]},"finishReason":"STOP"}]}\n\n`,
      ],
    },
    streamError: {
      records: null,
      reason: "streamGenerateContent has no in-stream error record; a failure arrives as an HTTP status, covered by the shared transport case.",
    },
  },
  {
    className: "CodexProvider",
    sourceFile: "codex.ts",
    protocol: "openai-responses",
    secret: CODEX_SECRET,
    make: () => new CodexProvider({ oauthToken: CODEX_SECRET, defaultModel: "gpt-5.5", baseUrl: "https://chatgpt.com/backend-api/codex" }),
    wire: {
      stop: [
        `data: {"type":"response.output_text.delta","delta":"${STOP_TEXT}"}\n\n`,
        `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":5}}}\n\n`,
      ],
      empty_stop: [
        `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":0}}}\n\n`,
      ],
      truncated: [
        `data: {"type":"response.output_text.delta","delta":"${TRUNCATED_TEXT}"}\n\n`,
        `data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":11,"output_tokens":4096}}}\n\n`,
      ],
      tool_use: [
        `data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_conf_a","call_id":"call_conf_a","name":"read_file","arguments":""}}\n\n`,
        `data: {"type":"response.function_call_arguments.delta","item_id":"fc_conf_a","delta":"{\\"path\\":\\"a.txt\\"}"}\n\n`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_conf_b","call_id":"call_conf_b","name":"list_files","arguments":""}}\n\n`,
        `data: {"type":"response.function_call_arguments.delta","item_id":"fc_conf_b","delta":"{\\"path\\":\\".\\"}"}\n\n`,
        `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":9}}}\n\n`,
      ],
    },
    streamError: { records: [`data: {"type":"response.failed","response":{"error":{"message":"backend rejected the request"}}}\n\n`] },
  },
];

/**
 * Implementations in src/provider that are deliberately not part of this
 * suite, each with the reason it carries no wire format of its own. A new
 * adapter is not allowed to enter by omission — the coverage assertion fails
 * until it appears here or in ADAPTERS.
 */
const NOT_A_WIRE_ADAPTER: Record<string, string> = {
  MockProvider: "test double; replays caller-supplied ProviderChunks and speaks no wire protocol",
  OpenAiProvider: "thin environment-credential wrapper that delegates every stream to OpenAiCompatibleProvider",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function sseResponse(records: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(records.join("")));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function respondWith(make: () => Response): void {
  globalThis.fetch = (async () => make()) as any;
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are Morrow." },
  { role: "user", content: "Read a file, then list the directory." },
];

const OPTIONS: StreamOptions = {
  tools: [
    { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { name: "list_files", description: "list a directory", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ],
  maxOutputTokens: 4096,
  timeoutMs: 90_000,
};

async function collect(provider: AiProvider, options: StreamOptions = OPTIONS): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of provider.streamChat(MESSAGES, options)) out.push(chunk);
  return out;
}

/** Merge streamed tool-call deltas by index, the same way the agent runtime
 * accumulates them. A conforming adapter must produce a sequence this can
 * reassemble into whole calls. */
function accumulateToolCalls(chunks: ProviderChunk[]): Array<{ id: string; name: string; args: string }> {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  for (const chunk of chunks) {
    if (chunk.type !== "tool_call") continue;
    for (const call of chunk.toolCalls ?? []) {
      const index = call.index ?? 0;
      const current = byIndex.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) current.id = call.id;
      if (call.function.name) current.name = call.function.name;
      current.args += call.function.arguments ?? "";
      byIndex.set(index, current);
    }
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
}

function textOf(chunks: ProviderChunk[]): string {
  return chunks.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** Every reason the stream reported it ended. Exactly one is conforming. */
function finishReasonsOf(chunks: ProviderChunk[]): Array<ProviderChunk["finishReason"]> {
  return chunks.filter((c) => c.type === "done" && c.finishReason).map((c) => c.finishReason);
}

describe("provider adapter conformance", () => {
  it("covers every wire adapter in src/provider", () => {
    const declared = new Set([...ADAPTERS.map((a) => a.className), ...Object.keys(NOT_A_WIRE_ADAPTER)]);
    const found: string[] = [];
    for (const file of readdirSync(PROVIDER_SOURCE_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(PROVIDER_SOURCE_DIR, file), "utf-8");
      for (const match of source.matchAll(/class\s+(\w+)\s+implements\s+AiProvider/g)) found.push(match[1]!);
    }
    expect(found.length).toBeGreaterThan(0);
    // A new adapter must be registered in ADAPTERS (and pass every case below)
    // or explicitly excused in NOT_A_WIRE_ADAPTER with a stated reason. It
    // cannot enter the product unchecked by simply not being mentioned.
    expect(found.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("registers each adapter against the protocol it actually speaks, with no duplicates", () => {
    const protocols = ADAPTERS.map((a) => a.protocol);
    expect(new Set(protocols).size).toBe(protocols.length);
    for (const adapter of ADAPTERS) {
      const source = readFileSync(join(PROVIDER_SOURCE_DIR, adapter.sourceFile), "utf-8");
      expect(source, `${adapter.sourceFile} should declare ${adapter.className}`).toContain(`class ${adapter.className} implements AiProvider`);
    }
  });

  for (const adapter of ADAPTERS) {
    describe(`${adapter.className} (${adapter.protocol})`, () => {
      it("reports a clean stop and delivers the visible text", async () => {
        respondWith(() => sseResponse(adapter.wire.stop));
        const chunks = await collect(adapter.make());
        expect(textOf(chunks)).toBe(STOP_TEXT);
        expect(finishReasonsOf(chunks)).toEqual(["stop"]);
        expect(chunks.filter((c) => c.type === "error")).toEqual([]);
      });

      it("classifies a clean stop with no visible output or tool call as retryable", async () => {
        respondWith(() => sseResponse(adapter.wire.empty_stop));
        const chunks = await collect(adapter.make());
        expect(chunks.at(-1)).toEqual({
          type: "error",
          error: {
            type: "empty_response",
            kind: "provider",
            message: "Provider returned a completed response with no content",
            retryable: true,
          },
        });
      });

      it("reports truncation as finishReason 'length' and keeps the partial text", async () => {
        // The load-bearing case. `mission/completion.ts` retries a review only
        // when finishReason === "length", so an adapter that cannot report
        // this leaves a reasoning model's empty, budget-exhausted response
        // indistinguishable from a model that had nothing to say. Deleting
        // finishReason from any adapter turns this red.
        respondWith(() => sseResponse(adapter.wire.truncated));
        const chunks = await collect(adapter.make());
        expect(finishReasonsOf(chunks)).toEqual(["length"]);
        expect(textOf(chunks)).toBe(TRUNCATED_TEXT);
      });

      it("normalizes tool calls into contiguous, reassemblable deltas", async () => {
        respondWith(() => sseResponse(adapter.wire.tool_use));
        const chunks = await collect(adapter.make());
        const calls = accumulateToolCalls(chunks);
        expect(calls.map((c) => c.name)).toEqual(EXPECTED_TOOL_CALLS.map((c) => c.name));
        expect(calls.map((c) => JSON.parse(c.args))).toEqual(EXPECTED_TOOL_CALLS.map((c) => c.args));
        expect(finishReasonsOf(chunks)).toEqual(["tool_calls"]);
        // Indices must be contiguous from zero — the runtime accumulator keys on them.
        const indices = chunks.filter((c) => c.type === "tool_call").flatMap((c) => (c.toolCalls ?? []).map((t) => t.index));
        expect([...new Set(indices)].sort()).toEqual([0, 1]);
      });

      it("normalizes a transport failure into a typed, retryable error", async () => {
        globalThis.fetch = (async () => new Response(`{"error":{"message":"slow down"}}`, {
          status: 429,
          headers: { "content-type": "application/json" },
        })) as any;
        const chunks = await collect(adapter.make());
        expect(chunks.at(-1)).toMatchObject({ type: "error", error: { kind: "rate_limit", retryable: true, status: 429 } });
      });

      const streamError = adapter.streamError;
      if (streamError.records) {
        it("normalizes a mid-stream failure into a typed error and stops", async () => {
          respondWith(() => sseResponse(streamError.records!));
          const chunks = await collect(adapter.make());
          const last = chunks.at(-1);
          expect(last?.type).toBe("error");
          expect(last?.error?.message ?? "").not.toBe("");
          expect(["auth", "rate_limit", "timeout", "network", "cancelled", "invalid_request", "context_overflow", "provider", "unknown"])
            .toContain(last?.error?.kind);
          expect(typeof last?.error?.retryable).toBe("boolean");
        });
      } else {
        it("states why this protocol carries no mid-stream failure record", () => {
          expect(streamError.reason.length).toBeGreaterThan(20);
        });
      }

      it("never echoes the credential into any emitted chunk", async () => {
        for (const scenario of ["stop", "truncated", "tool_use"] as const) {
          respondWith(() => sseResponse(adapter.wire[scenario]));
          const chunks = await collect(adapter.make());
          expect(JSON.stringify(chunks), `${scenario} leaked the credential`).not.toContain(adapter.secret);
        }
      });

      /**
       * The durable transcript stores tool calls in a table keyed globally on
       * their id, and the conflicting upsert refreshes only status and result
       * — never the tool name or arguments. `gemini.ts` mints its own ids
       * because Gemini's wire format carries none, and a per-turn ordinal
       * ("gemini-tool-0") therefore collided with every previous Gemini turn,
       * silently recording zero tool calls for every conversation after the
       * first.
       *
       * The rule is stated once, for all adapters, with no per-adapter opt-in:
       * an id either comes from the provider (it appears verbatim in the wire
       * the adapter was fed) or the adapter minted it, and a minted id must
       * differ on every stream. A constant, self-generated id satisfies
       * neither and fails here.
       */
      it("produces tool-call ids that are unique across streams unless the provider minted them", async () => {
        const runs = 3;
        const wire = adapter.wire.tool_use.join("");
        const idsPerRun: string[][] = [];
        for (let run = 0; run < runs; run++) {
          respondWith(() => sseResponse(adapter.wire.tool_use));
          const calls = accumulateToolCalls(await collect(adapter.make()));
          expect(calls.every((c) => c.id.length > 0), "every tool call must carry an id").toBe(true);
          // Within one stream, distinct calls are always distinct rows.
          expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
          idsPerRun.push(calls.map((c) => c.id));
        }

        const providerSupplied = idsPerRun[0]!.every((id) => wire.includes(id));
        if (providerSupplied) {
          // Identity came off the wire; the provider owns its global uniqueness
          // and the adapter must pass it through unchanged.
          expect(idsPerRun[1]).toEqual(idsPerRun[0]);
        } else {
          // The adapter minted the identity, so N streams of M calls must
          // produce N x M distinct ids.
          const all = idsPerRun.flat();
          expect(all).toHaveLength(runs * EXPECTED_TOOL_CALLS.length);
          expect(new Set(all).size).toBe(all.length);
        }
      });
    });
  }
});

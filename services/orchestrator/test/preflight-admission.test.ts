import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  admitMeasuredProviderRequest,
  admitProviderRequest,
  measureProviderRequest,
  type ProviderRequestMeasurement,
  type ProviderRequestEnvelope,
} from "../src/execution/context-budget.js";
import type { ToolDefinition } from "../src/provider/base.js";

/**
 * §3 acceptance: every provider-call site in the orchestrator goes through
 * `measureProviderRequest` + `admitProviderRequest` (or
 * `admitMeasuredProviderRequest`) BEFORE `openStreamWithFallback`. A single
 * bypassed call site lets a 37,134-token request slip through and choke the
 * provider with the same catastrophic failure the §1 fix addresses; the
 * budget gate is the last line of defence and must not be removed by accident.
 */

interface CallSite {
  file: string;
  line: number;
  call: string;
}

function enumerateCallSites(root: string, file: string, pattern: RegExp): CallSite[] {
  const text = readFileSync(join(root, file), "utf8");
  const out: CallSite[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(pattern);
    if (match) out.push({ file, line: index + 1, call: line.trim() });
  }
  return out;
}

describe("preflight: every provider-call site is preceded by admission", () => {
  const ROOT = join(process.cwd(), "src");

  it("agents/main path admits before opening the stream", () => {
    const sites = enumerateCallSites(
      ROOT,
      "execution/agent.ts",
      /\bopenStreamWithFallback\s*\(/
    );
    expect(sites.length).toBe(1);
    const site = sites[0]!;
    const text = readFileSync(join(ROOT, site.file), "utf8");
    const lines = text.split(/\r?\n/);
    // Within 200 lines BEFORE the call, at least one of admitProviderRequest,
    // admitMeasuredProviderRequest, measureProviderRequest must appear.
    const window = lines.slice(Math.max(0, site.line - 200), site.line).join("\n");
    expect(window).toMatch(/admitProviderRequest|admitMeasuredProviderRequest|measureProviderRequest/);
  });

  it("mission/completion path admits before opening the stream", () => {
    const sites = enumerateCallSites(
      ROOT,
      "mission/completion.ts",
      /\bopenStreamWithFallback\s*\(/
    );
    expect(sites.length).toBe(1);
    const site = sites[0]!;
    const text = readFileSync(join(ROOT, site.file), "utf8");
    const lines = text.split(/\r?\n/);
    const window = lines.slice(Math.max(0, site.line - 80), site.line).join("\n");
    expect(window).toMatch(/admitProviderRequest/);
  });
});

describe("admitMeasuredProviderRequest refuses oversized payloads", () => {
  it("refuses when inputTokens > usableInputTokens (verified budget)", () => {
    const measurement: ProviderRequestMeasurement = {
      inputTokens: 40_000,
      outputReserveTokens: 2_048,
      totalRequestTokens: 42_048,
      method: "exact",
      exact: true,
      confidence: "exact",
      components: {
        messages: 36_000,
        imageInputs: 0,
        toolSchemas: 4_000,
        providerContinuation: 0,
        protocolOverhead: 0,
      },
    };
    const out = admitMeasuredProviderRequest(measurement, { usableInputTokens: 27_504 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("request_too_large");
    expect(out.measurement).toBe(measurement);
    expect(out.usableInputTokens).toBe(27_504);
  });

  it("refuses when inputTokens > usableInputTokens (unverified/fallback budget)", () => {
    // §1 acceptance: even when the budget is the conservative fallback, an
    // oversized payload is refused BEFORE the network call, not after.
    const measurement: ProviderRequestMeasurement = {
      inputTokens: 33_000,
      outputReserveTokens: 2_048,
      totalRequestTokens: 35_048,
      method: "estimate",
      exact: false,
      confidence: "conservative",
      components: {
        messages: 30_000,
        imageInputs: 0,
        toolSchemas: 3_000,
        providerContinuation: 0,
        protocolOverhead: 0,
      },
    };
    const out = admitMeasuredProviderRequest(measurement, { usableInputTokens: 29_553 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("request_too_large");
  });

  it("admits a payload that fits within the usable budget", () => {
    const measurement: ProviderRequestMeasurement = {
      inputTokens: 5_000,
      outputReserveTokens: 2_048,
      totalRequestTokens: 7_048,
      method: "exact",
      exact: true,
      confidence: "exact",
      components: {
        messages: 4_500,
        imageInputs: 0,
        toolSchemas: 500,
        providerContinuation: 0,
        protocolOverhead: 0,
      },
    };
    const out = admitMeasuredProviderRequest(measurement, { usableInputTokens: 27_504 });
    expect(out.ok).toBe(true);
  });
});

describe("measureProviderRequest includes tool schemas and protocol overhead", () => {
  it("grows inputTokens when an extra tool schema is added", () => {
    const baseMessages = [
      { role: "system" as const, content: "You are a coding agent." },
      { role: "user" as const, content: "List the files." },
    ];
    const smallTools: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const largeTools: ToolDefinition[] = [
      ...smallTools,
      {
        name: "run_command",
        description: "Run a shell command with full options",
        parameters: {
          type: "object",
          properties: {
            executable: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
            timeoutMs: { type: "number" },
          },
        },
      },
    ];
    const small = measureProviderRequest({
      providerId: "openai-compatible",
      model: "deepseek-v4-flash-free",
      protocol: "openai-chat",
      messages: baseMessages,
      tools: smallTools,
      outputReserveTokens: 2_048,
    });
    const large = measureProviderRequest({
      providerId: "openai-compatible",
      model: "deepseek-v4-flash-free",
      protocol: "openai-chat",
      messages: baseMessages,
      tools: largeTools,
      outputReserveTokens: 2_048,
    });
    expect(large.components.toolSchemas).toBeGreaterThan(small.components.toolSchemas);
    expect(large.inputTokens).toBeGreaterThan(small.inputTokens);
  });

  it("includes the openai-chat protocol overhead", () => {
    const messages = [{ role: "user" as const, content: "ping" }];
    const out = measureProviderRequest({
      providerId: "openai-compatible",
      model: "glm-5.2",
      protocol: "openai-chat",
      messages,
      tools: [],
      outputReserveTokens: 1,
    });
    expect(out.components.protocolOverhead).toBeGreaterThan(0);
  });
});

describe("admitProviderRequest (envelope-level) end-to-end refuses oversized requests", () => {
  it("refuses when the built envelope exceeds the verified budget", () => {
    const big = "x".repeat(200_000);
    const envelope: ProviderRequestEnvelope = {
      providerId: "opencode-go",
      model: "glm-5.2",
      protocol: "openai-chat",
      messages: [
        { role: "system" as const, content: "You are an agent." },
        { role: "user" as const, content: big },
      ],
      tools: [],
      outputReserveTokens: 2_048,
    };
    // Use a small verified budget to prove refusal happens BEFORE the network
    // call. The budget is 8k input tokens — 200k of payload obviously fails.
    const admission = admitProviderRequest(envelope, { usableInputTokens: 8_000 });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.reason).toBe("request_too_large");
    expect(admission.measurement.inputTokens).toBeGreaterThan(8_000);
  });
});
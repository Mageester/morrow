import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { buildCanonicalProviderRequest } from "../src/execution/canonical-request.js";
import { measureProviderRequest } from "../src/execution/context-budget.js";
import type { ChatMessage, ProviderProtocol } from "../src/provider/base.js";

const TARGET_TOKENS = [1_000, 10_000, 50_000] as const;
const route = {
  providerId: "openai",
  modelId: "gpt-5.5",
  protocol: "openai-chat" as ProviderProtocol,
  endpointHost: "benchmark.invalid",
  endpointIdentityHash: "benchmark-route",
  routeFingerprint: "benchmark:openai:gpt-5.5",
};

function contentForTarget(targetTokens: number): string {
  const unit = "alpha beta gamma delta epsilon zeta eta theta iota kappa ";
  return unit.repeat(Math.ceil(targetTokens * 4 / unit.length));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const results = TARGET_TOKENS.map((targetTokens) => {
  const messages: ChatMessage[] = [{ role: "user", content: contentForTarget(targetTokens) }];
  const envelope = {
    providerId: "openai",
    model: "gpt-5.5",
    protocol: "openai-chat" as const,
    route,
    messages,
    tools: [],
    outputReserveTokens: 2_048,
  };

  // Warm the module/tokenizer path before recording samples.
  measureProviderRequest(envelope);
  buildCanonicalProviderRequest({ ...envelope, route });
  const canonicalSamples: number[] = [];
  const legacyHashSamples: number[] = [];
  const measurementSamples: number[] = [];
  let measurement = measureProviderRequest(envelope);
  let canonical = buildCanonicalProviderRequest({ ...envelope, route });
  for (let sample = 0; sample < 3; sample++) {
    let started = performance.now();
    canonical = buildCanonicalProviderRequest({ ...envelope, route });
    canonicalSamples.push(performance.now() - started);
    started = performance.now();
    createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
    legacyHashSamples.push(performance.now() - started);
    started = performance.now();
    measurement = measureProviderRequest(envelope);
    measurementSamples.push(performance.now() - started);
  }

  return {
    targetTokens,
    measuredInputTokens: measurement.inputTokens,
    totalRequestTokens: measurement.totalRequestTokens,
    bytes: Buffer.byteLength(messages[0]!.content, "utf8"),
    legacyHashMedianMs: Number(median(legacyHashSamples).toFixed(3)),
    canonicalMedianMs: Number(median(canonicalSamples).toFixed(3)),
    measurementMedianMs: Number(median(measurementSamples).toFixed(3)),
    canonicalHashPrefix: canonical.contentHash.slice(0, 16),
  };
});

console.log(JSON.stringify(results));

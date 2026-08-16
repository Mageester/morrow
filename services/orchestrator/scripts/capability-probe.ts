/**
 * Live provider/model capability probe.
 *
 * Reports what Morrow's real resolution path concludes about every configured
 * route — never a second, independently-derived answer. Each column names the
 * mechanism that produced it, so an unknown is visibly an unknown rather than
 * a number nobody can source.
 *
 *   pnpm --filter @morrow/orchestrator exec tsx scripts/capability-probe.ts
 *
 * `--probe-limits` additionally sends one deliberately oversized request per
 * route, so a provider that discloses no capacity in its model listing can
 * state its real limit in the rejection. That request is billed and slow; it
 * is opt-in for exactly that reason.
 */
import { join } from "node:path";
import { hydrateProviderEnvFromSecrets } from "../src/provider/secrets.js";
import { resolveMorrowHome } from "../src/home.js";
import {
  createProvider,
  getProviderDefaultModel,
  installProviderModelDiscoveries,
  isProviderConfigured,
  listProviderStatuses,
} from "../src/provider/registry.js";
import { testProviderConnectivity } from "../src/provider/connectivity.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { buildExactProviderRoute, resolveProviderModelCapabilities } from "../src/provider/model-capabilities.js";
import { observedContextLimit } from "../src/provider/context-limit-discovery.js";
import type { ProviderId } from "@morrow/contracts";
import type { ProviderModelDiscovery } from "../src/repositories/provider-model-discovery.js";

hydrateProviderEnvFromSecrets(join(resolveMorrowHome(process.env), "secrets.env"), process.env);

const PROBE_LIMITS = process.argv.includes("--probe-limits");

const TARGETS: Array<{ providerId: ProviderId; model?: string | undefined }> = [
  { providerId: "gemini", model: process.env.GEMINI_MODEL ?? "gemini-3.7-flash" },
  { providerId: "deepseek" },
  { providerId: "nvidia-nim", model: process.env.NVIDIA_NIM_MODEL },
  { providerId: "tokenrouter", model: process.env.TOKENROUTER_MODEL },
  { providerId: "opencode-zen", model: process.env.OPENCODE_ZEN_MODEL },
  { providerId: "openai" },
  { providerId: "anthropic" },
  { providerId: "openrouter" },
];

function show(value: unknown): string {
  return value === null || value === undefined ? "unknown" : String(value);
}

/** One oversized request, purely to read the capacity out of the rejection. */
async function probeOverLimit(providerId: ProviderId, model: string): Promise<string> {
  try {
    const provider = createProvider(providerId, process.env, model);
    const oversized = "word ".repeat(900_000);
    for await (const chunk of provider.streamChat([{ role: "user", content: oversized }], {
      model,
      maxOutputTokens: 16,
      timeoutMs: 120_000,
    })) {
      if (chunk.type === "error") return chunk.error?.message.slice(0, 160) ?? "error";
      if (chunk.type === "done") return "accepted (no limit disclosed)";
    }
    return "no terminal chunk";
  } catch (error) {
    return (error as Error).message.slice(0, 160);
  }
}

const rows: Array<Record<string, string>> = [];

for (const target of TARGETS) {
  const { providerId } = target;
  if (!isProviderConfigured(providerId, process.env)) {
    rows.push({ Provider: providerId, Model: "—", Note: "not configured (no credentials)" });
    continue;
  }

  const status = listProviderStatuses(process.env).find((item) => item.id === providerId);
  const model = target.model ?? getProviderDefaultModel(providerId, process.env) ?? "(none)";

  // 1. Live discovery through the same path the server uses.
  const connectivity = await testProviderConnectivity(providerId, process.env);
  const discovery: ProviderModelDiscovery = {
    providerId,
    authMode: status?.authMode ?? "unknown",
    models: connectivity.models,
    status: connectivity.ok ? "available" : "unavailable",
    errorKind: connectivity.errorKind,
    fetchedAt: new Date().toISOString(),
  };
  installProviderModelDiscoveries([discovery]);

  const discovered = connectivity.models.find((item) => item.providerModelId === model);
  const provider = createProvider(providerId, process.env, model);
  const route = provider.route;

  if (PROBE_LIMITS) await probeOverLimit(providerId, model);
  const learned = route ? observedContextLimit(route, "", model) : undefined;

  // 2. Morrow's real capability + budget resolution for this exact route.
  const capabilities = resolveProviderModelCapabilities(buildExactProviderRoute({
    providerId,
    modelId: model,
    protocol: route?.protocol ?? "openai-chat",
    endpointKind: route?.endpointKind ?? "default",
    endpointHost: route?.endpointHost ?? null,
    endpointIdentityHash: route?.endpointIdentityHash ?? null,
  }));
  const budget = resolveModelBudget({
    providerId,
    selectedModel: model,
    endpoint: {
      kind: route?.endpointKind ?? "default",
      host: route?.endpointHost ?? null,
      protocol: route?.protocol ?? "openai-chat",
      limitTokens: route?.endpointLimitTokens ?? null,
      limitSource: route?.endpointLimitSource ?? "unknown",
      endpointIdentityHash: route?.endpointIdentityHash ?? null,
    },
  });

  const reasoning = capabilities.reasoning;
  const modes = reasoning.state === "known" && reasoning.value
    ? (reasoning.value.efforts.length > 0 ? reasoning.value.efforts.map((e) => e.id).join("/") : reasoning.value.mode)
    : "unknown";

  const discoveryMechanism = discovered?.contextWindow != null
    ? "model listing (reports capacity)"
    : learned
      ? "over-limit rejection"
      : connectivity.models.length > 0
        ? "model listing (ids only)"
        : "none";

  rows.push({
    Provider: providerId,
    Model: model,
    "Native context": show(budget.nativeContextWindowTokens),
    "Route limit": show(budget.routeLimitTokens),
    "Effective context": show(budget.effectiveContextWindowTokens),
    "Max output": show(capabilities.maxOutputTokens.value),
    "Reasoning modes": modes,
    Discovery: discoveryMechanism,
    Source: budget.contextWindowSource,
    Confidence: budget.contextWindowConfidence,
    Freshness: capabilities.contextWindow.fetchedAt ?? discovery.fetchedAt,
  });
}

const columns = [
  "Provider", "Model", "Native context", "Route limit", "Effective context",
  "Max output", "Reasoning modes", "Discovery", "Source", "Confidence", "Freshness", "Note",
];
const present = columns.filter((column) => rows.some((row) => row[column] !== undefined));
const width = (column: string) => Math.max(column.length, ...rows.map((row) => (row[column] ?? "—").length));
const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(width(present[index]!))).join("  ");

console.log(line(present));
console.log(present.map((column) => "-".repeat(width(column))).join("  "));
for (const row of rows) console.log(line(present.map((column) => row[column] ?? "—")));

import type { ProviderId } from "@morrow/contracts";

/**
 * Which providers the flagship workflow may be proven against, stated per
 * provider instead of hidden in an array.
 *
 * `eligible: false` is not a gap — it records *why* a route cannot carry the
 * gate, so a newly added provider has to be classified deliberately rather
 * than silently inheriting eligibility. `FLAGSHIP_PROVIDER_ELIGIBILITY_COVERAGE`
 * asserts this table covers the whole provider registry.
 */
export interface FlagshipProviderEligibility {
  providerId: ProviderId;
  /** May carry a real flagship run. */
  eligible: boolean;
  /** Model ids must be discovered live; there is no dependable default. */
  requiresLiveModelDiscovery: boolean;
  reason: string;
}

export const FLAGSHIP_PROVIDER_ELIGIBILITY: readonly FlagshipProviderEligibility[] = [
  { providerId: "anthropic", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable, stable default model." },
  { providerId: "openai", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable, stable default model." },
  { providerId: "gemini", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable, stable default model." },
  { providerId: "deepseek", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable; primary free-tier gate provider." },
  { providerId: "openrouter", eligible: true, requiresLiveModelDiscovery: true, reason: "Aggregator; available frontier ids vary by account." },
  { providerId: "opencode-go", eligible: true, requiresLiveModelDiscovery: true, reason: "Gateway; available ids vary by account." },
  { providerId: "opencode-zen", eligible: true, requiresLiveModelDiscovery: true, reason: "Second gate provider; free frontier ids must be discovered." },
  { providerId: "vercel-ai-gateway", eligible: true, requiresLiveModelDiscovery: true, reason: "Gateway; available ids vary by account." },
  { providerId: "github-models", eligible: true, requiresLiveModelDiscovery: true, reason: "Gateway; available ids vary by account." },

  // Not eligible. Each exclusion states the property that disqualifies it.
  { providerId: "deterministic-local", eligible: false, requiresLiveModelDiscovery: false, reason: "Not a model route; invokes no provider." },
  { providerId: "mock", eligible: false, requiresLiveModelDiscovery: false, reason: "Test double; proves nothing about real models." },
  { providerId: "openai-compatible", eligible: false, requiresLiveModelDiscovery: true, reason: "Custom user-supplied endpoint; capability is unknown to this repository." },
  { providerId: "ollama", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's hardware and pulled weights." },
  { providerId: "lmstudio", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's machine." },
  { providerId: "llamacpp", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's machine." },
  { providerId: "vllm", eligible: false, requiresLiveModelDiscovery: true, reason: "Local/self-hosted route; capability depends on the deployment." },
  { providerId: "jan", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's machine." },
  { providerId: "xai", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "mistral", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "moonshot", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "zai", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "dashscope", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "perplexity", eligible: false, requiresLiveModelDiscovery: true, reason: "Search-oriented; not an agentic build route." },
  { providerId: "cohere", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "groq", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "cerebras", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "together", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "fireworks", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "deepinfra", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "nebius", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "novita", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "hyperbolic", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "sambanova", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
];

/** Providers the gate may actually run against. */
export const FLAGSHIP_GATE_CANDIDATES: readonly ProviderId[] = FLAGSHIP_PROVIDER_ELIGIBILITY
  .filter((entry) => entry.eligible)
  .map((entry) => entry.providerId);

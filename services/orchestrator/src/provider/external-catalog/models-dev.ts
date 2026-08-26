import { z } from "zod";
import type { ModelInfo, ProviderId, ReasoningMode, RouteReasoningCapability } from "@morrow/contracts";

/**
 * models.dev ingestion.
 *
 * models.dev publishes one JSON document describing thousands of models across
 * every mainstream provider and gateway. Morrow reads it as **data about model
 * identity and model capability** — context capacity, modalities, whether the
 * model calls tools, whether it reasons and at what depths, what it costs. It
 * deliberately does NOT read wire behaviour out of it: which request field
 * carries an output ceiling, how a reasoning selection is spelled, whether an
 * endpoint accepts `response_format` are facts about the endpoint being called
 * and belong to the provider adapter. That split is the whole point — see
 * `types.ts`.
 *
 * **Every field is read defensively, one model at a time.** The upstream shape
 * is not Morrow's to control: rows carry image models whose `limit.context` is
 * `0`, an `experimental` key that is a boolean on one provider and an object on
 * another, and fields that appear months before anyone here notices. A schema
 * strict enough to reject those would discard an entire provider's metadata
 * over one unusual row, which is exactly the failure this source exists to
 * prevent. A value that cannot be understood is skipped; the model keeps its
 * other facts, and the model's neighbours keep theirs.
 */

/** Maximum providers to consider from one document (194 upstream today). */
const MAX_PROVIDERS = 1_000;
/** Maximum models per provider. Gateways legitimately publish hundreds. */
const MAX_MODELS_PER_PROVIDER = 8_000;
const MAX_MODALITIES = 20;
const MAX_REASONING_LEVELS = 32;

export const ModelsDevDocumentSchema = z.record(z.string(), z.unknown());

/**
 * models.dev provider id → Morrow provider id.
 *
 * Pure data. Adding a provider Morrow already speaks to is one line here, not
 * a code path. Providers Morrow has no route for are skipped rather than
 * invented — the external catalog supplies capabilities for routes that exist,
 * it never creates routes.
 *
 * Regional and plan-scoped variants of a provider (`…-cn`, `…-coding-plan`,
 * `google-vertex`, `ollama-cloud`) are deliberately NOT mapped onto the plain
 * provider: they are different endpoints with different limits, and folding
 * them together would let one deployment's numbers describe another's.
 */
export const MODELS_DEV_PROVIDER_IDS: Readonly<Record<string, ProviderId>> = Object.freeze({
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  "google-generative-ai": "gemini",
  openrouter: "openrouter",
  deepseek: "deepseek",
  opencode: "opencode-zen",
  "opencode-zen": "opencode-zen",
  "opencode-go": "opencode-go",
  tokenrouter: "tokenrouter",
  vercel: "vercel-ai-gateway",
  "vercel-ai-gateway": "vercel-ai-gateway",
  "github-models": "github-models",
  xai: "xai",
  "x-ai": "xai",
  mistral: "mistral",
  mistralai: "mistral",
  moonshotai: "moonshot",
  moonshot: "moonshot",
  zhipuai: "zai",
  zai: "zai",
  "z-ai": "zai",
  alibaba: "dashscope",
  dashscope: "dashscope",
  qwen: "dashscope",
  perplexity: "perplexity",
  cohere: "cohere",
  groq: "groq",
  cerebras: "cerebras",
  together: "together",
  togetherai: "together",
  "together-ai": "together",
  fireworks: "fireworks",
  "fireworks-ai": "fireworks",
  deepinfra: "deepinfra",
  nebius: "nebius",
  novita: "novita",
  "novita-ai": "novita",
  hyperbolic: "hyperbolic",
  sambanova: "sambanova",
  nvidia: "nvidia-nim",
  "nvidia-nim": "nvidia-nim",
  ollama: "ollama",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  llamacpp: "llamacpp",
  "llama.cpp": "llamacpp",
  vllm: "vllm",
  jan: "jan",
});

/**
 * Vendor prefix on a gateway model id → the Morrow provider whose external
 * rows describe that vendor's models.
 *
 * Used only to find the UNDERLYING model behind a gateway id such as
 * `anthropic/claude-…`. It never changes which adapter serves the request.
 */
export const GATEWAY_VENDOR_PROVIDER_IDS: Readonly<Record<string, ProviderId>> = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  deepseek: "deepseek",
  "x-ai": "xai",
  xai: "xai",
  mistralai: "mistral",
  mistral: "mistral",
  moonshotai: "moonshot",
  moonshot: "moonshot",
  "z-ai": "zai",
  zai: "zai",
  zhipuai: "zai",
  qwen: "dashscope",
  alibaba: "dashscope",
  perplexity: "perplexity",
  cohere: "cohere",
  nvidia: "nvidia-nim",
  "deepseek-ai": "deepseek",
});

/**
 * Fold punctuation differences out of a model id.
 *
 * The same model is published as `claude-opus-4-8` by its vendor and
 * `claude-opus-4.8` by a gateway; underscores appear in a third place. This is
 * a spelling difference in one identifier, not a different model — but it is
 * still only a heuristic, so callers apply it last and only when it lands on a
 * single row.
 */
export function normalizeModelIdentity(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/[._]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

/**
 * Routing suffixes gateways append to an otherwise ordinary model id.
 *
 * These select a billing/serving variant of the same model, so stripping one
 * finds the model's metadata. Anything not on this list is left alone: an
 * Ollama tag like `:8b` names a genuinely different model and must not be
 * silently folded into its family.
 */
const GATEWAY_VARIANT_SUFFIXES = new Set(["free", "nitro", "floor", "online", "extended", "beta", "exacto"]);

/**
 * Providers whose endpoint runs on the user's own machine.
 *
 * Privacy class is a property of where the endpoint lives, so it is declared
 * once here rather than re-derived from a model's weights licence.
 */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set<ProviderId>(["ollama", "lmstudio", "llamacpp", "vllm", "jan"]);

// ── Defensive readers ───────────────────────────────────────────────────────
// Each returns undefined/null for anything it cannot understand. None of them
// substitutes a default: absence has to stay distinguishable from a value.

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boolish(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A capacity of zero means "not a token-limited model", not "zero tokens". */
function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function textArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .map((entry) => text(entry, 120))
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(items)].slice(0, maxItems);
}

const TITLE: Record<string, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max",
};

/**
 * Read the reasoning control a row declares.
 *
 * `reasoning_options` is the only field that states which depths a model
 * accepts, and Morrow reproduces the list verbatim — including a `none` level,
 * which is a real accepted value rather than Morrow's own "off" state.
 *
 * A `toggle` option says reasoning can be switched on and off. It does NOT say
 * how, and on an OpenAI-compatible route "omit the field" means "provider
 * default", not "off" — so this reports a model that reasons and stops there
 * rather than setting `supportsOff` and letting a user's Off selection turn
 * into a request that silently keeps reasoning enabled. The route's own
 * provider metadata (or a bundled correction) is what earns that claim.
 *
 * A `budget_tokens` option gives a range, not an enumeration, so the budget
 * list stays empty: any positive budget is in-contract, and only the adapter's
 * protocol decides whether a budget can be sent at all.
 */
function externalReasoning(source: Record<string, unknown>): RouteReasoningCapability {
  const reasons = boolish(source["reasoning"]);
  const options = Array.isArray(source["reasoning_options"]) ? source["reasoning_options"] : [];
  const parsed = options.map(record).filter((option): option is Record<string, unknown> => option !== undefined);
  const effort = parsed.find((option) => option["type"] === "effort");
  const budget = parsed.find((option) => option["type"] === "budget_tokens");
  const toggle = parsed.find((option) => option["type"] === "toggle");
  // `interleaved` also appears as `{ field: "reasoning_content" }`, naming the
  // wire field that carries the interleaved content. The field NAME is wire
  // behaviour and stays with the adapter; only the capability is ingested.
  const interleaved = source["interleaved"] === true || record(source["interleaved"]) !== undefined
    ? { interleaved: true as const }
    : {};

  if (effort) {
    const levels = textArray(effort["values"], MAX_REASONING_LEVELS);
    if (levels.length > 0) {
      const modes: ReasoningMode[] = levels.map((id) => ({ id, label: TITLE[id.toLowerCase()] ?? id }));
      return {
        control: "effort",
        efforts: modes.map((mode) => mode.id),
        modes,
        budgets: [],
        source: "external-catalog",
        ...interleaved,
        // No `wire`: the spelling a selection travels under belongs to the
        // adapter serving the route, not to the database describing the model.
      };
    }
  }
  if (budget) {
    return { control: "budget", efforts: [], budgets: [], source: "external-catalog", ...interleaved };
  }
  if (toggle) {
    // Reasons at a depth the provider fixes. `supportsOff` stays unset for the
    // reason given above: knowing a toggle exists is not knowing how to send it.
    return { control: "fixed", efforts: [], budgets: [], source: "external-catalog", ...interleaved };
  }
  if (reasons === true) {
    // Reasons, controls unverified. Keeps a picker on Auto instead of
    // offering depths nobody confirmed this route accepts.
    return { control: "unknown", efforts: [], budgets: [], source: "external-catalog", ...interleaved };
  }
  if (reasons === false) {
    return { control: "none", efforts: [], budgets: [], source: "external-catalog" };
  }
  // No row, or a row that says nothing about reasoning. Distinct from the
  // `reasons === false` case directly above, which is models.dev positively
  // reporting that the model does not reason. Claiming "none" here would put
  // words in the catalogue's mouth and disable the reasoning controls of every
  // model Morrow simply has no metadata for.
  return { control: "unknown", efforts: [], budgets: [], source: "unknown" };
}

function pricing(source: Record<string, unknown>): ModelInfo["pricing"] {
  const cost = record(source["cost"]);
  const input = nonNegativeNumber(cost?.["input"]);
  const output = nonNegativeNumber(cost?.["output"]);
  if (input === undefined || output === undefined) return null;
  const cacheRead = nonNegativeNumber(cost?.["cache_read"]);
  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    ...(cacheRead === undefined ? {} : { cachedInputUsdPerMillion: cacheRead }),
    // A published aggregate, not the provider's own billing statement for this
    // account. Morrow's cost maths only trusts "authoritative" sources, so this
    // is displayable without ever being charged against a budget.
    source: "provider-reported" as const,
  };
}

function lifecycle(source: Record<string, unknown>): NonNullable<ModelInfo["lifecycle"]> {
  switch (text(source["status"], 60)?.toLowerCase()) {
    case "deprecated":
    case "retired":
      return "deprecated";
    case "legacy":
      return "legacy";
    case "beta":
    case "preview":
    case "experimental":
      return "preview";
    default:
      return boolish(source["experimental"]) === true ? "preview" : "current";
  }
}

function requestState(value: boolean | undefined): "supported" | "unsupported" | "unknown" {
  return value === true ? "supported" : value === false ? "unsupported" : "unknown";
}

export interface ModelsDevNormalizeOptions {
  /** Version/etag identifying this snapshot. */
  readonly metadataVersion: string;
  /** When the snapshot was retrieved. */
  readonly fetchedAt: string;
}

function normalizeModel(
  providerId: ProviderId,
  raw: unknown,
  options: ModelsDevNormalizeOptions,
): ModelInfo | undefined {
  const source = record(raw);
  if (!source) return undefined;
  const id = text(source["id"], 300);
  if (!id) return undefined;

  const limit = record(source["limit"]);
  const modalities = record(source["modalities"]);
  const inputModalities = textArray(modalities?.["input"], MAX_MODALITIES);
  const outputModalities = textArray(modalities?.["output"], MAX_MODALITIES);
  const attachment = boolish(source["attachment"]);
  const vision = inputModalities.length > 0
    ? inputModalities.some((modality) => modality.toLowerCase() === "image" || modality.toLowerCase() === "video")
    : attachment === true;
  const toolCall = boolish(source["tool_call"]);
  const reasoning = externalReasoning(source);
  const reasons = boolish(source["reasoning"]);

  return {
    version: 1,
    id,
    providerModelId: id,
    canonicalId: id,
    aliases: [],
    providerId,
    label: text(source["name"], 300) ?? id,
    family: text(source["family"], 300) ?? null,
    generation: null,
    lifecycle: lifecycle(source),
    ...(inputModalities.length > 0 ? { inputModalities } : {}),
    ...(outputModalities.length > 0 ? { outputModalities } : {}),
    contextWindow: positiveInt(limit?.["context"]),
    maxOutputTokens: positiveInt(limit?.["output"]),
    pricing: pricing(source),
    tokenUsage: true,
    streamingUsage: true,
    capabilities: {
      // models.dev does not report streaming; the protocol baseline in the
      // adapter already covers it, and the external capability layer
      // deliberately never asserts it (see external-catalog/index.ts).
      streaming: true,
      toolCalls: toolCall === true,
      vision,
      ...(reasons === undefined ? {} : { reasoning: reasons }),
    },
    requestCapabilities: {
      tools: requestState(toolCall),
      // Silence, not a claim: which of these a route accepts is an endpoint
      // fact, and a consumer treats "unknown" as "fall back to the protocol
      // baseline the adapter owns".
      toolChoice: "unknown",
      temperature: requestState(boolish(source["temperature"])),
      streamUsage: "unknown",
      responseFormat: requestState(boolish(source["structured_output"])),
      maxOutputTokens: "unknown",
    },
    capabilitySource: "remote-catalog",
    speedClass: "unknown",
    costClass: "unknown",
    privacy: LOCAL_PROVIDER_IDS.has(providerId) ? "local" : "remote",
    builtIn: false,
    metadataSource: "remote-catalog",
    metadataVersion: options.metadataVersion,
    fetchedAt: options.fetchedAt,
    confidence: "reported",
    reasoning,
  };
}

/**
 * Normalize one models.dev document into Morrow catalog rows.
 *
 * Returns an empty array (never throws) for a document that carries nothing
 * usable, so a shape change upstream degrades to "no external metadata"
 * instead of breaking startup.
 */
export function normalizeModelsDevDocument(raw: unknown, options: ModelsDevNormalizeOptions): ModelInfo[] {
  const parsed = ModelsDevDocumentSchema.safeParse(raw);
  if (!parsed.success) return [];
  const entries = Object.entries(parsed.data);
  if (entries.length === 0 || entries.length > MAX_PROVIDERS) return [];

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const [sourceProviderId, rawProvider] of entries) {
    const providerId = MODELS_DEV_PROVIDER_IDS[sourceProviderId.trim().toLowerCase()];
    if (!providerId) continue;
    const providerModels = record(record(rawProvider)?.["models"]);
    if (!providerModels) continue;
    const rows = Object.values(providerModels);
    if (rows.length > MAX_MODELS_PER_PROVIDER) continue;

    for (const row of rows) {
      const model = normalizeModel(providerId, row, options);
      if (!model) continue;
      // Two upstream ids can map onto one Morrow provider (`mistral` and
      // `mistralai`). First declaration wins; a duplicate would otherwise be
      // rejected by the catalog's identity validation.
      const key = `${providerId} ${model.id.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(model);
    }
  }
  return models;
}

/** Split a gateway model id into its vendor prefix and the remaining id. */
export function splitGatewayModelId(modelId: string): { vendor: string; model: string } | undefined {
  const index = modelId.indexOf("/");
  if (index <= 0 || index === modelId.length - 1) return undefined;
  return { vendor: modelId.slice(0, index).trim().toLowerCase(), model: modelId.slice(index + 1).trim() };
}

/** Drop a gateway routing/billing variant suffix, leaving the model id. */
export function stripGatewayVariant(modelId: string): string | undefined {
  const index = modelId.lastIndexOf(":");
  if (index <= 0 || index === modelId.length - 1) return undefined;
  const suffix = modelId.slice(index + 1).trim().toLowerCase();
  return GATEWAY_VARIANT_SUFFIXES.has(suffix) ? modelId.slice(0, index) : undefined;
}

import type { RouteReasoningCapability } from "@morrow/contracts";
import type { ContextLimitSource, ProviderProtocol } from "../provider/base.js";
import { resolveModelMetadata, resolveReasoningCapability } from "./models.js";
import {
  resolveEffectiveContext,
  type EffectiveContextEndpointInput,
  type RouteFallbackIdentity,
} from "./effective-context.js";

/**
 * The single canonical model-capability + usable-budget resolution.
 *
 * This supersedes computing "how much input can we send" in two places with
 * two different reserve formulas (a route/endpoint-aware ceiling in
 * effective-context.ts and a preset/tool-aware ceiling in context-budget.ts).
 * Every consumer that needs to know the model, its verified capacity, or the
 * usable input budget for a request — routing, compaction, admission, the
 * terminal's /context and /model views, and task reports — reads this one
 * shape so they can never disagree.
 */
export interface ModelBudget {
  providerId: string;
  selectedModelId: string;
  canonicalModelId: string;
  displayName: string;
  capabilities: { streaming: boolean; toolCalls: boolean; vision: boolean };
  /** What reasoning control this exact route exposes, with provenance. */
  reasoning: RouteReasoningCapability;

  protocol: ProviderProtocol;
  endpointKind: EffectiveContextEndpointInput["kind"];
  endpointHost: string | null;

  /** The verified-or-configured ceiling for this exact route (smallest of
   * advertised model capacity and any configured endpoint override), before
   * any reserve is subtracted. */
  contextWindowTokens: number;
  contextWindowSource: ContextLimitSource;
  /** "verified" ONLY for built-in model metadata (routing/models.ts) or
   * genuinely provider-reported metadata ("model-metadata" /
   * "provider-metadata"). "configured" for a user-supplied context-window
   * override or a configured endpoint limit ("endpoint-override") — Morrow
   * cannot independently verify either against the real provider. "unverified"
   * when no authoritative value exists at all and the internal safe fallback
   * was used ("fallback" / "unknown"). Endpoint overrides are deliberately
   * never "verified": a configured number is a claim, not a fact. */
  contextWindowConfidence: "verified" | "configured" | "unverified";

  endpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;

  outputReserveTokens: number;
  safetyMarginTokens: number;
  toolReserveTokens: number;
  framingReserveTokens: number;
  totalReserveTokens: number;

  /** contextWindowTokens - totalReserveTokens: the real provider-capacity
   * ceiling. This is THE number every consumer must use to decide whether a
   * complete wire request will be accepted — durable-checkpoint compaction,
   * live-fallback admission, and mission-completion requests all gate on
   * this, independent of any local preset/dev budget. */
  usableInputTokens: number;
  /** Where the first-pass deterministic history trim aims: a share of
   * `usableInputTokens` (COMPACTION_TARGET_RATIO), raised to the local
   * preset/dev context budget when that byte budget is the larger of the two.
   * A *soft* efficiency target, never a provider constraint — it must never be
   * used to reject a request outright. */
  compactionTargetTokens: number;

  /**
   * Demarcates which unverified-route category the conservative fallback was
   * sourced from. Surfaced in `morrow models inspect` and mission telemetry so
   * the operator can tell apart "OpenCode Zen fallback" from "OpenCode Go
   * fallback" from "custom-compatible fallback" — without ever fabricating a
   * per-slug context limit. Only the live provider discovery path (highest-
   * precedence metadata source per §1) or an explicit user override can
   * legitimately replace the conservative safe number with a verified one.
   */
  routeFallbackIdentity: RouteFallbackIdentity;
}

/**
 * Share of a route's verified usable input the deterministic trim aims to stay
 * under before it compacts. Headroom, not a limit: the remainder absorbs the
 * turn that crosses the line — a large tool result or a long assistant turn —
 * so crossing it triggers one orderly compaction instead of an admission
 * rejection. `usableInputTokens` remains the only number that can refuse a
 * request.
 */
export const COMPACTION_TARGET_RATIO = 0.85;

export function resolveModelBudget(input: {
  providerId: string;
  selectedModel: string;
  endpoint: EffectiveContextEndpointInput;
  /** The preset's generic byte budget. A FLOOR: it may raise a small route's
   * working context, never shrink a large one. */
  presetContextBudgetBytes?: number;
  /** A byte budget the caller asked for explicitly (`maxContextBytes`). Unlike
   * the preset default this still CAPS — someone naming a number is giving an
   * instruction, not a baseline, and a dev/CLI knob that silently did nothing
   * would be worse than not having one. */
  explicitContextBudgetBytes?: number;
  outputBudgetTokens?: number;
  toolCount?: number;
  userContextWindowTokens?: number | null;
  safetyMarginTokens?: number;
  fallbackLimitTokens?: number;
}): ModelBudget {
  const metadata = resolveModelMetadata(input.providerId, input.selectedModel);
  // outputReserveTokens is 1 here (the minimum resolveEffectiveContext accepts):
  // this call only borrows its endpoint/model-capacity merge logic. The real,
  // complete reserve (output + safety margin + tools + framing) is computed
  // once below and is the only reserve figure any consumer of ModelBudget sees.
  const effective = resolveEffectiveContext({
    providerId: input.providerId,
    selectedModel: input.selectedModel,
    endpoint: input.endpoint,
    outputReserveTokens: 1,
    ...(input.fallbackLimitTokens !== undefined ? { fallbackLimitTokens: input.fallbackLimitTokens } : {}),
  });

  const contextWindowTokens = input.userContextWindowTokens ?? effective.effectiveRequestLimitTokens;
  const contextWindowSource: ContextLimitSource = input.userContextWindowTokens
    ? "endpoint-override"
    : effective.effectiveLimitSource;
  const contextWindowConfidence: ModelBudget["contextWindowConfidence"] =
    input.userContextWindowTokens
      ? "configured"
      : contextWindowSource === "fallback" || contextWindowSource === "unknown"
        ? "unverified"
        : contextWindowSource === "endpoint-override"
          ? "configured"
          : "verified"; // "model-metadata" | "provider-metadata"

  const outputReserveTokens = input.outputBudgetTokens ?? 2048;
  const safetyMarginTokens = input.safetyMarginTokens ?? Math.max(512, Math.ceil(contextWindowTokens * 0.02));
  // Tool schemas are measured from their exact serialized definitions by
  // measureProviderRequest before every provider invocation. Reserving another
  // synthetic amount per tool here double-counts the same bytes and can reject
  // a request solely because the truthful catalog grew. Keep the field for the
  // stable disclosure shape; the exact-envelope gate is authoritative.
  const toolReserveTokens = 0;
  const framingReserveTokens = 512;
  const totalReserveTokens = outputReserveTokens + safetyMarginTokens + toolReserveTokens + framingReserveTokens;

  const usableInputTokens = Math.max(1, contextWindowTokens - totalReserveTokens);
  // The preset byte budget is a FLOOR, not a ceiling. Read as a ceiling it
  // throttled every large-window route to whichever constant the presets happened
  // to carry: `balanced` at 524288 bytes pinned a 1,000,000-token model to a
  // 131,072-token working context, so a long task compacted roughly eight times
  // more often than the route required. Every premature compaction discards
  // context the model already paid to gather, which is what drove the measured
  // long-run pathology — the same file read 31-92 times, 276 compactions and
  // ~201 MB of checkpoints in a single task.
  //
  // Small-window routes are unaffected: their floor lands above the ratio and the
  // clamp to `usableInputTokens` puts them exactly where the old `min` did.
  const routeTargetTokens = Math.max(1, Math.floor(usableInputTokens * COMPACTION_TARGET_RATIO));
  const presetFloorTokens = input.presetContextBudgetBytes !== undefined
    ? Math.max(1, Math.floor(input.presetContextBudgetBytes / 4))
    : routeTargetTokens;
  const explicitCapTokens = input.explicitContextBudgetBytes !== undefined
    ? Math.max(1, Math.floor(input.explicitContextBudgetBytes / 4))
    : usableInputTokens;
  const compactionTargetTokens = Math.max(
    1,
    Math.min(Math.max(routeTargetTokens, presetFloorTokens), explicitCapTokens, usableInputTokens),
  );

  return {
    providerId: input.providerId,
    selectedModelId: input.selectedModel,
    canonicalModelId: metadata.canonicalId,
    displayName: metadata.label,
    capabilities: { ...metadata.capabilities },
    reasoning: resolveReasoningCapability(input.providerId, input.selectedModel),
    protocol: input.endpoint.protocol,
    endpointKind: input.endpoint.kind,
    endpointHost: input.endpoint.host,
    contextWindowTokens,
    contextWindowSource,
    contextWindowConfidence,
    endpointLimitTokens: effective.configuredEndpointLimitTokens,
    endpointLimitSource: effective.endpointLimitSource,
    outputReserveTokens,
    safetyMarginTokens,
    toolReserveTokens,
    framingReserveTokens,
    totalReserveTokens,
    usableInputTokens,
    compactionTargetTokens,
    routeFallbackIdentity: effective.routeFallbackIdentity,
  };
}

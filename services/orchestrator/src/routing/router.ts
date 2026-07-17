import type { PresetId, Preset, PresetStatus, RoutingDecision, RoutingCandidate, ProviderId } from "@morrow/contracts";
import type { ProviderEnv } from "../provider/credentials.js";
import { getProviderStatus, isProviderConfigured, getProviderDefaultModel, providerCapabilities, PROVIDER_IDS } from "../provider/registry.js";
import { getPreset, listPresets } from "./presets.js";

export interface RouteOverride {
  providerId?: ProviderId;
  model?: string;
}

export type RouteResult = { ok: true; decision: RoutingDecision } | { ok: false; reason: string };

function isLocal(id: ProviderId): boolean {
  return providerCapabilities(id)?.local ?? false;
}

function preferredModel(preset: Preset, providerId: ProviderId, env: ProviderEnv): string | null {
  const prefs = preset.modelPreferences[providerId] ?? [];
  const status = getProviderStatus(providerId, env);
  const available = new Set(status?.models ?? []);
  const preferred = prefs.find((model) => available.size === 0 || available.has(model));
  // Once the active account surface supplied a model list, never substitute an
  // arbitrary provider default that the preset did not recommend. This keeps
  // automatic routing on reviewed/current choices and lets the next provider
  // candidate take over honestly.
  return preferred ?? (available.size === 0 ? getProviderDefaultModel(providerId, env) : null);
}

/**
 * Resolve a preset (with optional explicit override) to a concrete
 * provider+model, honestly reporting whether a fallback occurred and which
 * candidates were considered. Privacy boundaries are hard: a `local-only`
 * preset will never silently route to a hosted provider, even on override.
 */
export function routePreset(presetId: PresetId, env: ProviderEnv = process.env, override?: RouteOverride): RouteResult {
  const preset = getPreset(presetId);
  if (!preset) return { ok: false, reason: `Unknown preset: ${presetId}` };

  if (override?.providerId) {
    const pid = override.providerId;
    if (preset.privacy === "local-only" && !isLocal(pid)) {
      return { ok: false, reason: `Preset "${preset.label}" is local-only and cannot use the non-local provider "${pid}".` };
    }
    if (!isProviderConfigured(pid, env)) {
      return { ok: false, reason: `Provider "${pid}" is not configured.` };
    }
    const model = override.model || preferredModel(preset, pid, env);
    if (!model) return { ok: false, reason: `No model available for provider "${pid}".` };
    return {
      ok: true,
      decision: {
        version: 1,
        presetId,
        providerId: pid,
        model,
        reason: `User override: ${pid} / ${model}`,
        fallbackUsed: false,
        overridden: true,
        privacy: preset.privacy,
        candidates: [{ providerId: pid, configured: true, reason: "user override" }],
      },
    };
  }

  // For local-only presets, only local providers are eligible — no cloud fallback.
  const order = preset.providerOrder.filter((pid) => (preset.privacy === "local-only" ? isLocal(pid) : true));
  const candidates: RoutingCandidate[] = [];
  let chosen: { providerId: ProviderId; model: string } | null = null;

  for (const pid of order) {
    const configured = isProviderConfigured(pid, env);
    candidates.push({
      providerId: pid,
      configured,
      reason: configured ? "configured" : getProviderStatus(pid, env)?.setupHint ?? "not configured",
    });
    if (configured && !chosen) {
      const model = preferredModel(preset, pid, env);
      if (model) chosen = { providerId: pid, model };
    }
  }

  // No provider in the preset's own preference order is usable. Before failing,
  // consider every other configured provider (e.g. a consumer whose only
  // configured route is an OpenAI-compatible gateway that no preset lists).
  // This is an explicit, recorded last-resort candidate — never silent: the
  // decision reason and candidate list both say the preset order was exhausted.
  let outsideOrder = false;
  if (!chosen && preset.privacy !== "local-only") {
    for (const pid of PROVIDER_IDS) {
      if (order.includes(pid)) continue;
      if (!isProviderConfigured(pid, env)) continue;
      const model = getProviderDefaultModel(pid, env);
      candidates.push({ providerId: pid, configured: true, reason: model ? "configured (outside preset order)" : "configured but no default model" });
      if (model && !chosen) {
        chosen = { providerId: pid, model };
        outsideOrder = true;
      }
    }
  }

  if (!chosen) {
    const reason = preset.requiresLocal
      ? `Preset "${preset.label}" requires a local provider. Enable Ollama (set OLLAMA_BASE_URL to a running server).`
      : `Preset "${preset.label}" has no configured provider. Configure one of: ${order.join(", ")}.`;
    return { ok: false, reason };
  }

  const fallbackUsed = chosen.providerId !== order[0];
  return {
    ok: true,
    decision: {
      version: 1,
      presetId,
      providerId: chosen.providerId,
      model: chosen.model,
      reason: outsideOrder
        ? `No provider in the "${preset.label}" preset order is configured; routed to configured provider "${chosen.providerId}" (outside preset order).`
        : fallbackUsed
          ? `Preferred provider unavailable; routed to first configured provider "${chosen.providerId}".`
          : `Routed to preferred provider "${chosen.providerId}".`,
      fallbackUsed,
      overridden: false,
      privacy: preset.privacy,
      candidates,
    },
  };
}

/**
 * Resolve which configured provider serves a model id the user selected without
 * naming a provider. This is the single place a model-only selection becomes a
 * full route — the dispatcher must never stamp a model onto a provider that
 * does not serve it. Match order: exact model-list membership, then provider
 * default model. Only configured providers are eligible.
 */
export function resolveProviderForModel(model: string, env: ProviderEnv = process.env): ProviderId | null {
  const wanted = model.trim();
  let defaultMatch: ProviderId | null = null;
  for (const pid of PROVIDER_IDS) {
    const status = getProviderStatus(pid, env);
    if (!status?.configured) continue;
    if (status.models.includes(wanted)) return pid;
    if (!defaultMatch && status.defaultModel === wanted) defaultMatch = pid;
  }
  return defaultMatch;
}

export function listPresetStatuses(env: ProviderEnv = process.env): PresetStatus[] {
  return listPresets().map((preset) => {
    const res = routePreset(preset.id, env);
    if (res.ok) {
      return { preset, available: true, unavailableReason: null, resolved: { providerId: res.decision.providerId, model: res.decision.model } };
    }
    return { preset, available: false, unavailableReason: res.reason, resolved: null };
  });
}

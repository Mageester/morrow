import type { PresetId, Preset, PresetStatus, RoutingDecision, RoutingCandidate, ProviderId } from "@morrow/contracts";
import type { ProviderEnv } from "../provider/credentials.js";
import { getProviderStatus, isProviderConfigured, getProviderDefaultModel, providerCapabilities } from "../provider/registry.js";
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
  // A provider the preset lists without model preferences (the generic
  // OpenAI-compatible gateway) has exactly one reviewed choice: the model the
  // operator configured for it. Routing to that default is honest — there is
  // no preset recommendation it could contradict.
  if (prefs.length === 0) return status?.defaultModel ?? getProviderDefaultModel(providerId, env);
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
      reason: fallbackUsed
        ? `Preferred provider unavailable; routed to first configured provider "${chosen.providerId}".`
        : `Routed to preferred provider "${chosen.providerId}".`,
      fallbackUsed,
      overridden: false,
      privacy: preset.privacy,
      candidates,
    },
  };
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

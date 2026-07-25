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
  // A preset only curates models for the providers it names. For any other
  // provider it has no opinion at all, so the provider's own default — the
  // model the user selected during setup, or the one discovery found — is the
  // correct and only sensible choice. Treating "no opinion" the same as
  // "recommended nothing that is available" is what made every provider
  // outside a preset's curated list unroutable.
  //
  // The discovered status default is preferred over the configured one so a
  // credential whose account no longer has the saved model still routes.
  if (prefs.length === 0) return status?.defaultModel ?? getProviderDefaultModel(providerId, env);
  const preferred = prefs.find((model) => available.size === 0 || available.has(model));
  // The preset DID recommend models here but none are available on this
  // account. Never substitute an arbitrary default it did not recommend: keep
  // automatic routing on reviewed choices and let the next candidate take over
  // honestly.
  return preferred ?? (available.size === 0 ? getProviderDefaultModel(providerId, env) : null);
}

/**
 * The providers a preset may route to, in preference order.
 *
 * A preset names the providers it prefers, but that list is curated and
 * therefore always incomplete — Morrow supports many more providers than any
 * preset enumerates. Stopping at the curated list meant a user whose only
 * configured provider was outside it (say Groq, OpenCode Zen, or LM Studio) got
 * "no configured provider" from every preset, and a fully configured Morrow was
 * unusable.
 *
 * So the curated order comes first, and any *other configured* provider is
 * appended after it as a fallback. Two properties are preserved exactly:
 *
 *  - Preference still wins: a preset's own providers are always tried first, so
 *    routing quality is unchanged for users who have them.
 *  - Privacy is still absolute: a `local-only` preset only ever appends local
 *    providers, so the fallback can never turn a local-only run into a hosted
 *    one. This is the reason the filter is applied to appended providers too,
 *    and not only to the curated list.
 *
 * Unconfigured providers are never appended — they would add noise to the
 * candidate list without ever being selectable.
 */
function eligibleProviderOrder(preset: Preset, env: ProviderEnv): ProviderId[] {
  const allowed = (pid: ProviderId) => (preset.privacy === "local-only" ? isLocal(pid) : true);
  const curated = preset.providerOrder.filter(allowed);
  const seen = new Set<ProviderId>(curated);
  const extra = PROVIDER_IDS.filter(
    (pid) => !seen.has(pid) && allowed(pid) && isProviderConfigured(pid, env)
  );
  return [...curated, ...extra];
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
  const order = eligibleProviderOrder(preset, env);
  const candidates: RoutingCandidate[] = [];
  let chosen: { providerId: ProviderId; model: string } | null = null;
  // Configured providers that could not supply a model — reported separately so
  // the failure message points at the real problem.
  const modelless: ProviderId[] = [];

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
      else modelless.push(pid);
    }
  }

  if (!chosen) {
    // Distinguish "nothing is set up" from "something is set up but has no
    // model yet" — they need completely different actions from the user, and
    // reporting the first for the second sends them to reconfigure a provider
    // that is already working.
    if (modelless.length > 0) {
      return {
        ok: false,
        reason: `${modelless.join(", ")} ${modelless.length === 1 ? "is" : "are"} configured but no model is selected. Run \`morrow providers configure ${modelless[0]}\` to pick one, or \`morrow providers test ${modelless[0]}\` to list the available models.`,
      };
    }
    const reason = preset.requiresLocal
      ? `Preset "${preset.label}" requires a local provider. Start a local server (Ollama, LM Studio, llama.cpp, vLLM, or Jan) and point Morrow at it with \`morrow providers configure\`.`
      : `Preset "${preset.label}" has no configured provider. Configure one with \`morrow providers configure\`.`;
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

import type { ModelInfo } from "@morrow/contracts";
import {
  capabilityLayerFromModelInfo,
  retagCapabilityFact,
  type CapabilityLayer,
} from "../capability-facts.js";
import { externalCapabilityLayer } from "../external-catalog/index.js";
import { isVerifiedReasoningDeclaration } from "./common.js";
import { PROVIDER_MODEL_CATALOGS } from "./index.js";

/**
 * The catalog half of capability resolution: everything Morrow knows about a
 * model NAME, before anything is known about the endpoint serving it.
 *
 * Two catalogs contribute, at two different authorities:
 *
 *  - the bundled catalog beside the adapters, as generic seed metadata plus a
 *    small set of Morrow-verified compatibility corrections;
 *  - the installed external model database (models.dev), as comprehensive
 *    generic metadata that supersedes the seed but never the corrections.
 *
 * Neither is a routing whitelist. A model in no catalog at all resolves to
 * unknown facts and stays perfectly executable.
 */

export function findBundledModel(providerId: string, modelId: string): ModelInfo | undefined {
  const folded = modelId.trim().toLowerCase();
  return PROVIDER_MODEL_CATALOGS[providerId]?.find((model) =>
    model.id === modelId
    || model.aliases.includes(modelId)
    || model.id.toLowerCase() === folded
    || model.aliases.some((alias) => alias.toLowerCase() === folded),
  );
}

/**
 * Split one bundled row into the two authorities it actually speaks with.
 *
 * Everything except a verified reasoning declaration is seed data. The
 * declaration itself is restated as a `provider-correction` fact so it survives
 * a comprehensive external row that knows the model but not Morrow's wire
 * dialect for it.
 */
export function bundledCapabilityLayers(model: ModelInfo): CapabilityLayer[] {
  const full = capabilityLayerFromModelInfo(model, "provider-catalog", "provider", "reported");
  if (!isVerifiedReasoningDeclaration(model) || full.capabilities.reasoning?.state !== "known") {
    return [full];
  }
  const { reasoning, ...seed } = full.capabilities;
  return [
    { source: "provider-catalog", capabilities: seed },
    {
      source: "provider-correction",
      capabilities: { reasoning: retagCapabilityFact(reasoning, "provider-correction", "provider", "verified") },
    },
  ];
}

/** Every name-keyed capability layer for one provider/model pair, unordered. */
export function catalogCapabilityLayers(providerId: string, modelId: string): CapabilityLayer[] {
  const bundled = findBundledModel(providerId, modelId);
  const external = externalCapabilityLayer(providerId, modelId);
  return [
    ...(bundled ? bundledCapabilityLayers(bundled) : []),
    ...(external ? [external] : []),
  ];
}

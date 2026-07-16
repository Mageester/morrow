import type { ModelDescriptor } from "@morrow/contracts";
import { ModelDescriptorSchema } from "@morrow/contracts";
import bundled from "./bundled-catalog.json";

export interface BundledCatalog {
  schemaVersion: number;
  catalogVersion: string;
  generatedAt: string;
  models: ModelDescriptor[];
}

const parsed = bundled as Omit<BundledCatalog, "models"> & { models: unknown[] };
export const BUNDLED_CATALOG: BundledCatalog = {
  schemaVersion: parsed.schemaVersion,
  catalogVersion: parsed.catalogVersion,
  generatedAt: parsed.generatedAt,
  models: parsed.models.map((model) => ModelDescriptorSchema.parse(model)),
};

export function resolveBundledDescriptor(providerId: string, providerModelId: string, authMode?: ModelDescriptor["authMode"]): ModelDescriptor | undefined {
  const normalized = providerModelId.trim();
  return BUNDLED_CATALOG.models.find((model) =>
    model.providerId === providerId &&
    (authMode === undefined || model.authMode === authMode) &&
    (model.providerModelId === normalized || model.canonicalModelId === normalized || model.aliases.includes(normalized)),
  );
}

import { ModelStatusSchema, PresetStatusSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const modelKeys = {
  all: ["models"] as const,
  catalogue() {
    return [...this.all, "catalogue"] as const;
  },
  presets() {
    return [...this.all, "presets"] as const;
  },
};

export const modelQueries = {
  /** The live model catalogue: every known model with availability, provider,
   * context window, capabilities, pricing, and lifecycle. Never carries a key. */
  catalogue() {
    return queryOptions({
      queryKey: modelKeys.catalogue(),
      queryFn: () => api.get("/api/models", ModelStatusSchema.array()),
    });
  },
  /** Routing presets with resolved availability. */
  presets() {
    return queryOptions({
      queryKey: modelKeys.presets(),
      queryFn: () => api.get("/api/presets", PresetStatusSchema.array()),
    });
  },
};

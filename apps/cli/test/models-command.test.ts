import { describe, expect, it } from "vitest";
import type { ModelStatus } from "@morrow/contracts";
import { visibleModelsForAccount } from "../src/commands/models.js";

describe("models command account visibility", () => {
  it("shows provider-discovered custom models without requiring a catalog lifecycle", () => {
    const models = [
      {
        model: { id: "nvidia/nemotron-3-ultra-550b-a55b", providerId: "nvidia-nim", lifecycle: "custom" },
        available: true,
        availability: "available",
      },
      {
        model: { id: "stale-model", providerId: "nvidia-nim", lifecycle: "custom" },
        available: false,
        availability: "unavailable",
      },
      {
        model: { id: "bundled-model", providerId: "openai", lifecycle: "current" },
        available: true,
        availability: "available",
      },
    ] as unknown as ModelStatus[];

    expect(visibleModelsForAccount(models).map((status) => status.model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "bundled-model",
    ]);
  });
});

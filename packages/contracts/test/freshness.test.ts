import { describe, expect, it } from "vitest";
import {
  FreshnessModeSchema,
  FreshnessPolicySchema,
  ResearchRunSchema,
  ResearchSourceSchema,
  ResearchSourcesResponseSchema,
  ResearchRoutingDecisionSchema,
} from "../src/index.js";

const source = {
  version: 1 as const,
  id: "source-1",
  taskId: "task-1",
  url: "https://example.com/news",
  title: "Example news",
  publisher: "Example",
  retrievedAt: "2026-08-11T12:00:00.000Z",
  publishedAt: "2026-08-10T12:00:00.000Z",
  contentHash: "a".repeat(64),
  sourceType: "web" as const,
  trustStatus: "untrusted" as const,
  validationStatus: "validated" as const,
  citations: [{ claim: "A claim", excerpt: "A bounded excerpt." }],
};

describe("freshness and research provenance contracts", () => {
  it("accepts each typed freshness mode and rejects an implicit mode", () => {
    expect(FreshnessModeSchema.parse("offline")).toBe("offline");
    expect(FreshnessPolicySchema.parse({ mode: "offline" })).toEqual({ mode: "offline" });
    expect(FreshnessPolicySchema.parse({ mode: "current" })).toEqual({ mode: "current" });
    expect(FreshnessPolicySchema.parse({ mode: "recent", maxAgeHours: 24 })).toEqual({ mode: "recent", maxAgeHours: 24 });
    expect(FreshnessPolicySchema.parse({ mode: "as_of", date: "2026-08-10" })).toEqual({ mode: "as_of", date: "2026-08-10" });
    expect(() => FreshnessPolicySchema.parse({ mode: "recent" })).toThrow();
  });

  it("keeps provenance metadata and bounded citations while excluding raw snapshots", () => {
    const parsed = ResearchSourceSchema.parse(source);
    expect(parsed).toMatchObject({
      url: source.url,
      retrievedAt: source.retrievedAt,
      contentHash: source.contentHash,
      taskId: source.taskId,
      trustStatus: "untrusted",
    });
    expect(() => ResearchSourceSchema.parse({ ...source, snapshotContent: "raw fetched page" })).toThrow();
    expect(ResearchSourcesResponseSchema.parse({ version: 1, taskId: "task-1", sources: [parsed] }).sources).toHaveLength(1);
  });

  it("records the requested policy and visible routing decision without authority fields", () => {
    expect(ResearchRunSchema.parse({
      version: 1,
      id: "run-1",
      taskId: "task-1",
      query: "latest example news",
      freshnessPolicy: { mode: "current" },
      sourceIds: ["source-1"],
      conflicts: [],
      status: "completed",
      createdAt: "2026-08-11T12:00:00.000Z",
      completedAt: "2026-08-11T12:01:00.000Z",
    }).status).toBe("completed");
    expect(ResearchRoutingDecisionSchema.parse({
      required: true,
      requiresNetwork: true,
      execution: "live",
      explanation: "Current information requires a network-capable research tool.",
      policy: { mode: "current" },
    }).execution).toBe("live");
  });
});

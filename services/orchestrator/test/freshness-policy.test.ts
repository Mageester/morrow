import { describe, expect, it } from "vitest";
import type { ResearchSource } from "@morrow/contracts";
import {
  evaluateResearchRequirement,
  evaluateSourceFreshness,
  routeResearch,
} from "../src/research/freshness-policy.js";

const source = (overrides: Partial<ResearchSource> = {}): ResearchSource => ({
  version: 1,
  id: "source-1",
  taskId: "task-1",
  url: "https://example.com/news",
  title: "Example news",
  publisher: "Example",
  retrievedAt: "2026-08-11T10:00:00.000Z",
  publishedAt: "2026-08-10T10:00:00.000Z",
  contentHash: "a".repeat(64),
  sourceType: "web",
  trustStatus: "untrusted",
  validationStatus: "validated",
  citations: [],
  ...overrides,
});

describe("freshness-aware research policy", () => {
  it("requires a network-capable research tool for current information", () => {
    expect(evaluateResearchRequirement("What is the latest release?", { mode: "current" })).toMatchObject({
      required: true,
      requiresNetwork: true,
    });
    expect(routeResearch({
      query: "What is the latest release?",
      policy: { mode: "current" },
      networkToolAvailable: false,
      localOnly: true,
      storedSourceAvailable: true,
    })).toMatchObject({ execution: "blocked-local-only", requiresNetwork: true });
    expect(routeResearch({
      query: "What is the latest release?",
      policy: { mode: "current" },
      networkToolAvailable: true,
      localOnly: false,
      storedSourceAvailable: false,
    })).toMatchObject({ execution: "live", requiresNetwork: true });
  });

  it("never schedules a research tool in offline mode", () => {
    expect(routeResearch({
      query: "Summarize what we already know",
      policy: { mode: "offline" },
      networkToolAvailable: true,
      localOnly: false,
      storedSourceAvailable: false,
    })).toMatchObject({ execution: "stored", requiresNetwork: false });
    expect(evaluateResearchRequirement("today's notes", { mode: "offline" }).required).toBe(false);
  });

  it("rejects sources older than the recent window", () => {
    const result = evaluateSourceFreshness(source({ retrievedAt: "2026-08-09T09:59:00.000Z" }), { mode: "recent", maxAgeHours: 24 }, "2026-08-11T10:00:00.000Z");
    expect(result).toMatchObject({ accepted: false, status: "stale" });
  });

  it("labels a source published after an as-of cutoff as post-cutoff", () => {
    const result = evaluateSourceFreshness(source({ publishedAt: "2026-08-11T10:00:00.000Z" }), { mode: "as_of", date: "2026-08-10" }, "2026-08-11T10:00:00.000Z");
    expect(result).toMatchObject({ accepted: false, status: "post_cutoff" });
  });

  it("makes latest/current routing visible even when the query uses the freshness words", () => {
    expect(evaluateResearchRequirement("Give me the current price today")).toMatchObject({ required: true, requiresNetwork: true });
  });
});

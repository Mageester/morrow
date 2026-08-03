import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { READ_ONLY_TOOL_NAMES } from "../src/execution/agent.js";
import { TOOL_CATALOG, PERMISSION_PROFILE, getTool } from "../src/tools/catalog.js";
import { providerRouteFingerprint } from "../src/routing/effective-context.js";
import type { ProviderProtocol, ProviderContinuationState } from "../src/provider/base.js";

/**
 * Task 6 — guard the two boundaries as *classes* rather than as the handful of
 * cases that happened to be reported.
 *
 * Boundary 1: a read-only turn may only ever be offered tools the catalog
 * itself declares side-effect free. Enumerated over the whole catalog, so
 * adding a mutating tool to the read-only set fails here instead of in
 * production.
 *
 * Boundary 2: provider continuation state is private to one exact provider
 * route. Enumerated over every declared protocol, so a new protocol cannot
 * quietly inherit another route's continuation.
 */

const createdAt = "2026-08-03T09:00:00.000Z";

const ALL_PROTOCOLS: ProviderProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content",
  "mock",
];

describe("read-only boundary holds across the whole tool catalog", () => {
  it("offers a read-only turn no tool the catalog declares as mutating", () => {
    const offending = [...READ_ONLY_TOOL_NAMES]
      .map((name) => getTool(name))
      .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
      .filter((tool) => tool.sideEffect !== "read-only")
      .map((tool) => `${tool.name} (${tool.sideEffect})`);
    expect(offending).toEqual([]);
  });

  it("resolves every read-only tool name against the real catalog", () => {
    const unknown = [...READ_ONLY_TOOL_NAMES].filter((name) => !getTool(name));
    expect(unknown).toEqual([]);
  });

  it("keeps every mutating tool out of the read-only profile", () => {
    const leaked = TOOL_CATALOG
      .filter((tool) => tool.sideEffect !== "read-only")
      .filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name))
      .map((tool) => tool.name);
    expect(leaked).toEqual([]);
  });

  it("declares read-only as a real tool profile option", () => {
    expect(PERMISSION_PROFILE.toolProfileOptions).toContain("read-only");
    expect(PERMISSION_PROFILE.toolProfileOptions).toContain("none");
  });

  it("covers every catalog side-effect class in the profile decision", () => {
    // Every tool must be classified. An unclassified tool would fall through
    // the read-only filter by accident.
    const unclassified = TOOL_CATALOG.filter((tool) => !tool.sideEffect);
    expect(unclassified).toEqual([]);
  });
});

describe("provider route fingerprints separate every route dimension", () => {
  const base = {
    providerId: "deepseek",
    model: "deepseek-chat",
    protocol: "openai-chat" as ProviderProtocol,
    endpointKind: "default" as const,
    endpointHost: "api.deepseek.com",
    endpointIdentityHash: "hash-a",
  };

  it("gives every declared protocol a distinct fingerprint", () => {
    const seen = new Map<string, ProviderProtocol>();
    for (const protocol of ALL_PROTOCOLS) {
      const fingerprint = providerRouteFingerprint({ ...base, protocol });
      expect(seen.has(fingerprint)).toBe(false);
      seen.set(fingerprint, protocol);
    }
    expect(seen.size).toBe(ALL_PROTOCOLS.length);
  });

  it("separates routes that differ only by host, endpoint kind, or identity", () => {
    const variants = [
      { ...base },
      { ...base, endpointHost: "api.other.com" },
      { ...base, endpointKind: "custom" as const },
      { ...base, endpointIdentityHash: "hash-b" },
      { ...base, providerId: "opencode-zen" },
    ];
    const fingerprints = new Set(variants.map((variant) => providerRouteFingerprint(variant)));
    expect(fingerprints.size).toBe(variants.length);
  });

  it("treats host casing as the same route", () => {
    expect(providerRouteFingerprint({ ...base, endpointHost: "API.DeepSeek.COM" }))
      .toBe(providerRouteFingerprint(base));
  });
});

function continuityHarness() {
  const db = openDatabase(":memory:");
  projectRepository(db).createProject({
    id: "project-1",
    name: "Boundary fixture",
    workspacePath: "C:/synthetic-workspace",
    createdAt,
  });
  taskRepository(db).createTask({
    id: "task-1",
    projectId: "project-1",
    kind: "agent_chat",
    status: "running",
    createdAt,
  });
  const continuity = executionContinuityRepository(db);
  const segment = continuity.openSegment({
    taskId: "task-1",
    missionId: null,
    providerId: "deepseek",
    model: "deepseek-chat",
    routeJson: {},
    ownerId: "worker-1",
    now: createdAt,
  });
  return { db, continuity, taskId: "task-1", segment };
}

describe("provider continuation is private to one exact route", () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it("never returns continuation saved under a different route, for any protocol", () => {
    const harness = continuityHarness();
    db = harness.db;
    const { continuity, taskId, segment } = harness;

    const savedProtocol: ProviderProtocol = "openai-chat";
    const savedFingerprint = providerRouteFingerprint({
      providerId: "deepseek",
      model: "deepseek-chat",
      protocol: savedProtocol,
      endpointKind: "default",
      endpointHost: "api.deepseek.com",
      endpointIdentityHash: "hash-a",
    });

    const state: ProviderContinuationState = { reasoningContent: "private chain of thought" };
    continuity.saveProviderContinuation({
      id: "continuation-1",
      taskId,
      segmentId: segment.id,
      providerId: "deepseek",
      routeFingerprint: savedFingerprint,
      turnKey: "turn-1",
      state,
      ownerId: "worker-1",
      generation: segment.generation,
      now: createdAt,
    });

    // The identical route gets it back.
    expect(continuity.loadProviderContinuation(taskId, "turn-1", savedFingerprint)?.reasoningContent)
      .toBe("private chain of thought");

    // Every other protocol is a different route and must get nothing.
    for (const protocol of ALL_PROTOCOLS.filter((value) => value !== savedProtocol)) {
      const otherFingerprint = providerRouteFingerprint({
        providerId: "deepseek",
        model: "deepseek-chat",
        protocol,
        endpointKind: "default",
        endpointHost: "api.deepseek.com",
        endpointIdentityHash: "hash-a",
      });
      expect(continuity.loadProviderContinuation(taskId, "turn-1", otherFingerprint)).toBeNull();
    }
  });

  it("does not serve continuation across hosts, providers, or turns", () => {
    const harness = continuityHarness();
    db = harness.db;
    const { continuity, taskId, segment } = harness;

    const route = {
      providerId: "deepseek",
      model: "deepseek-chat",
      protocol: "openai-chat" as ProviderProtocol,
      endpointKind: "default" as const,
      endpointHost: "api.deepseek.com",
      endpointIdentityHash: "hash-a",
    };
    const fingerprint = providerRouteFingerprint(route);
    continuity.saveProviderContinuation({
      id: "continuation-1",
      taskId,
      segmentId: segment.id,
      providerId: "deepseek",
      routeFingerprint: fingerprint,
      turnKey: "turn-1",
      state: { reasoningContent: "private" },
      ownerId: "worker-1",
      generation: segment.generation,
      now: createdAt,
    });

    const foreignHost = providerRouteFingerprint({ ...route, endpointHost: "api.impostor.com" });
    const foreignProvider = providerRouteFingerprint({ ...route, providerId: "opencode-zen" });

    expect(continuity.loadProviderContinuation(taskId, "turn-1", foreignHost)).toBeNull();
    expect(continuity.loadProviderContinuation(taskId, "turn-1", foreignProvider)).toBeNull();
    // A different turn on the same route is also a different continuation.
    expect(continuity.loadProviderContinuation(taskId, "turn-2", fingerprint)).toBeNull();
  });

  it("redacts secrets carried inside continuation state before persisting", () => {
    const harness = continuityHarness();
    db = harness.db;
    const { continuity, taskId, segment } = harness;

    const fingerprint = providerRouteFingerprint({
      providerId: "deepseek",
      model: "deepseek-chat",
      protocol: "openai-chat",
      endpointKind: "default",
      endpointHost: "api.deepseek.com",
      endpointIdentityHash: "hash-a",
    });
    continuity.saveProviderContinuation({
      id: "continuation-1",
      taskId,
      segmentId: segment.id,
      providerId: "deepseek",
      routeFingerprint: fingerprint,
      turnKey: "turn-1",
      state: { reasoningContent: "token=sk-abcdefghijklmnopqrstuvwxyz012345" },
      ownerId: "worker-1",
      generation: segment.generation,
      now: createdAt,
    });

    const rawRow = harness.db
      .prepare("SELECT state_json FROM agent_provider_continuations WHERE task_id=?")
      .get(taskId) as { state_json: string } | undefined;
    expect(rawRow?.state_json).toBeDefined();
    expect(rawRow!.state_json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});

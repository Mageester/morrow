import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { dispatchAgentTask } from "../src/mission/task-dispatcher.js";
import { routePreset } from "../src/routing/router.js";
import { eligibleFallbackProviderIds } from "../src/routing/fallback-eligibility.js";

/**
 * A route the user pinned must be the route that runs.
 *
 * The defect: mid-stream fallback candidates were built from the routing
 * decision's full candidate list whenever no provider was injected, and every
 * fallback candidate is served with `getProviderDefaultModel(candidate.id)`.
 * A mission asking for a specific provider/model could therefore be answered
 * by a different provider running a different model, disclosed only as a
 * `provider.fallback` event. These tests pin the rule at every hop the CLI
 * flags travel: router → dispatcher → the fallback-eligibility boundary the
 * agent consults before constructing alternates.
 */

const ANTHROPIC_ENV = { ANTHROPIC_API_KEY: "test-key-anthropic", OPENAI_API_KEY: "test-key-openai" } as NodeJS.ProcessEnv;

describe("routePreset: an explicit override is not a preference", () => {
  it("returns exactly the requested provider and model with no fallback", () => {
    const result = routePreset("balanced", ANTHROPIC_ENV, { providerId: "anthropic", model: "claude-opus-5" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.providerId).toBe("anthropic");
    expect(result.decision.model).toBe("claude-opus-5");
    expect(result.decision.overridden).toBe(true);
    expect(result.decision.fallbackUsed).toBe(false);
    expect(result.decision.candidates).toEqual([
      { providerId: "anthropic", configured: true, reason: "user override" },
    ]);
  });

  it("refuses an unconfigured pinned provider instead of routing elsewhere", () => {
    const result = routePreset("balanced", { OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv, { providerId: "anthropic", model: "claude-opus-5" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("anthropic");
    expect(result.reason).toContain("not configured");
  });
});

describe("eligibleFallbackProviderIds", () => {
  const candidates = [
    { providerId: "anthropic" as const, configured: true, reason: "configured" },
    { providerId: "openai" as const, configured: true, reason: "configured" },
    { providerId: "ollama" as const, configured: false, reason: "not configured" },
    { providerId: "mock" as const, configured: true, reason: "mock" },
  ];

  it("offers no alternates at all for a pinned route", () => {
    expect(eligibleFallbackProviderIds({ pinned: true, primaryProviderId: "anthropic", candidates })).toEqual([]);
  });

  it("still offers configured alternates for an automatically resolved route", () => {
    expect(eligibleFallbackProviderIds({ pinned: false, primaryProviderId: "anthropic", candidates })).toEqual(["openai"]);
  });

  it("never offers mock, the primary itself, or an unconfigured provider", () => {
    const eligible = eligibleFallbackProviderIds({ pinned: false, primaryProviderId: "openai", candidates });
    expect(eligible).toEqual(["anthropic"]);
    expect(eligible).not.toContain("mock");
    expect(eligible).not.toContain("ollama");
    expect(eligible).not.toContain("openai");
  });

  it("tolerates a decision with no candidate list", () => {
    expect(eligibleFallbackProviderIds({ pinned: false, primaryProviderId: "anthropic", candidates: undefined })).toEqual([]);
  });
});

describe("dispatchAgentTask: CLI flags reach the persisted route", () => {
  let db: Database.Database;
  const tempDir = join(process.cwd(), "test-temp-route-pin-" + Math.random().toString(36).slice(2));

  beforeEach(() => {
    db = openDatabase(":memory:");
    mkdirSync(tempDir, { recursive: true });
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "RP", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "RP", createdAt: ts, updatedAt: ts });
  });
  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function dispatch(body: Record<string, unknown>, env: NodeJS.ProcessEnv = ANTHROPIC_ENV) {
    const ran: string[] = [];
    const result = dispatchAgentTask(
      { db, runner: { run: (taskId: string) => void ran.push(taskId) }, env },
      { conversationId: "c1", content: "Build a task tracker", mode: "agent", ...body } as never,
    );
    return { result, ran };
  }

  it("persists a --provider/--model build as a pinned route with a single candidate", () => {
    const { result } = dispatch({ providerId: "anthropic", model: "claude-opus-5", autoApprove: true });

    expect(result.routing.providerId).toBe("anthropic");
    expect(result.routing.model).toBe("claude-opus-5");
    expect(result.routing.overridden).toBe(true);
    expect(eligibleFallbackProviderIds({
      pinned: result.routing.overridden,
      primaryProviderId: result.routing.providerId,
      candidates: result.routing.candidates,
    })).toEqual([]);

    const persisted = taskRoutingRepository(db).get(result.task.id);
    expect(persisted?.providerId).toBe("anthropic");
    expect(persisted?.model).toBe("claude-opus-5");
    expect(persisted?.decision.overridden).toBe(true);
  });

  it("treats a model-only override as pinned so the model is never substituted", () => {
    // Auto-routing picks the provider, but the user named the model. Before the
    // fix this kept the whole auto-route candidate list, and any failover
    // replaced the requested model with that provider's default.
    const { result } = dispatch({ model: "claude-opus-5", autoApprove: true });

    expect(result.routing.model).toBe("claude-opus-5");
    expect(result.routing.overridden).toBe(true);
    expect(eligibleFallbackProviderIds({
      pinned: result.routing.overridden,
      primaryProviderId: result.routing.providerId,
      candidates: result.routing.candidates,
    })).toEqual([]);
  });

  it("leaves an unpinned route free to fail over", () => {
    const { result } = dispatch({ autoApprove: true });

    expect(result.routing.overridden).toBe(false);
    expect(result.routing.model).not.toBe("");
  });

  it("rejects a pinned provider that is not configured instead of dispatching elsewhere", () => {
    expect(() => dispatch({ providerId: "anthropic" }, { OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv))
      .toThrow(/not configured/);
  });
});

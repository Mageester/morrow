import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { InteractiveSession, type SessionDeps } from "../src/terminal/session.js";
import type { SessionMeta } from "../src/terminal/events.js";
import type { TermIO } from "../src/terminal/runtime.js";

const now = "2026-07-05T12:00:00.000Z";

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 100;
  rows = 30;
  isTTY = false;
  write(s: string): void { this.writes.push(s); }
  on(): void {}
  off(): void {}
}

const meta: SessionMeta = {
  greeting: "Hello",
  projectName: "Morrow",
  workspacePath: "C:/repo",
  branch: "main",
  provider: "mock",
  model: "mock-model",
  privacy: "local",
  mode: "Agent",
  memory: true,
  autoApprove: false,
};

function intelligence() {
  return {
    projectId: "project-1",
    repositoryFingerprint: "f".repeat(64),
    architecture: {
      languages: [{ language: "TypeScript", files: 12 }],
      packageManagers: ["pnpm"],
      workspaces: ["apps/*"],
      components: [{ path: "apps/cli", name: "@morrow/cli", kind: "application", description: "CLI", entryPoints: ["src/main.ts"], dependsOn: [] }],
      commands: [{ id: "cmd-test", role: "test", command: "pnpm test", cwd: ".", sources: [], confidence: 0.9, lastVerifiedAt: null }],
      configFiles: [],
      docs: [],
      generatedPaths: [],
      boundaries: [],
      scopeFingerprints: [],
      freshness: "current",
      generatedAt: now,
    },
    conventions: [{ id: "conv-abcdef123456", description: "Use pnpm workspace commands.", scope: ".", confidence: 0.8, sources: [], approval: "inferred", freshness: "current", firstObservedAt: now, lastConfirmedAt: now }],
    commands: [{ id: "cmd-test", role: "test", command: "pnpm test", cwd: ".", sources: [], confidence: 0.9, lastVerifiedAt: null }],
    decisions: [],
    risks: [],
    relationships: [],
    missionLearnings: [],
    userRules: [{ id: "rule-fedcba987654", text: "Never edit generated output.", scope: ".", active: true, createdAt: now }],
    uncertainties: [],
    generatedAt: now,
    refreshedAt: now,
    schemaVersion: 1,
  } as any;
}

function session(overrides: Partial<SessionDeps["backend"]> = {}) {
  const backend: SessionDeps["backend"] = {
    send: vi.fn(),
    subscribe: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    getApproval: vi.fn(),
    resolveApproval: vi.fn(),
    getPlan: vi.fn(),
    getTask: vi.fn(),
    getTaskTree: vi.fn(),
    getLatestMission: vi.fn(async () => ({ id: "mission-abc12345" } as any)),
    getIntelligence: vi.fn(async () => intelligence()),
    getMissionImpact: vi.fn(async () => [{
      id: "impact-1",
      missionId: "mission-abc12345",
      objective: "Improve CLI",
      likelyFiles: ["apps/cli/src/main.ts"],
      likelyComponents: ["apps/cli"],
      interfacesAtRisk: [],
      testsLikelyAffected: [],
      relevantDecisions: [],
      relevantFailures: [],
      relevantRules: ["Never edit generated output."],
      possibleRegressions: ["CLI command routing"],
      requiredVerification: ["pnpm --filter @morrow/cli test"],
      uncertainty: [],
      createdAt: now,
    }]),
    getMissionRevisions: vi.fn(async () => []),
    listAgents: vi.fn(async () => [{
      version: 1 as const,
      id: "agent-1",
      projectId: "project-1",
      name: "Cortex Planner",
      role: "architect" as const,
      instructions: "Objective: Turn Cortex impact into an implementation plan.",
      providerOverride: null,
      modelOverride: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }]),
    patchConvention: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    ...overrides,
  };
  const app = new InteractiveSession({
    io: new FakeTermIO(),
    stdin: new EventEmitter() as any,
    out: new Output({ json: false, quiet: false, color: false }),
    unicode: false,
    meta,
    settings: { mode: "agent", autoApprove: false, preset: "coding", useMemory: true },
    backend,
    maxFps: 60,
  });
  return { app, backend };
}

describe("terminal Cortex slash commands", () => {
  it("renders the Cortex status overlay from project intelligence", async () => {
    const { app } = session();
    await (app as any).onSlash("/cortex");
    const viewer = (app as any).outputViewer;
    expect(viewer.title).toBe("morrow cortex");
    expect(viewer.lines.join("\n")).toContain("Components");
    expect(viewer.lines.join("\n")).toContain("1");
  });

  it("dispatches convention approvals through the backend", async () => {
    const { app, backend } = session();
    await (app as any).onSlash("/conventions approve abcdef12");
    expect(backend.patchConvention).toHaveBeenCalledWith("abcdef12", "approved");
  });

  it("renders mission impact through the active mission backend", async () => {
    const { app, backend } = session();
    await (app as any).onSlash("/impact");
    expect(backend.getMissionImpact).toHaveBeenCalledWith("mission-abc12345");
    const viewer = (app as any).outputViewer;
    expect(viewer.title).toBe("change impact");
    expect(viewer.lines.join("\n")).toContain("apps/cli");
    expect(viewer.lines.join("\n")).toContain("Required verification");
  });

  it("renders persistent project agents", async () => {
    const { app, backend } = session();
    await (app as any).onSlash("/agents");
    expect(backend.listAgents).toHaveBeenCalled();
    const viewer = (app as any).outputViewer;
    expect(viewer.title).toBe("agents");
    expect(viewer.lines.join("\n")).toContain("Cortex Planner");
  });
});

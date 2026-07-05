import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

import { Output } from "../src/cli/output.js";
import { cortexCommand } from "../src/commands/cortex.js";

const now = "2026-07-05T12:00:00.000Z";

function intelligence(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    repositoryFingerprint: "f".repeat(64),
    architecture: {
      languages: [{ language: "TypeScript", files: 12 }],
      packageManagers: ["pnpm"],
      workspaces: ["apps/*"],
      components: [{ path: "apps/cli", name: "@morrow/cli", kind: "application", description: "CLI", entryPoints: ["src/main.ts"], dependsOn: [] }],
      commands: [{ id: "cmd-test", role: "test", command: "pnpm test", cwd: ".", sources: [], confidence: 0.9, lastVerifiedAt: null }],
      configFiles: ["package.json"],
      docs: [],
      generatedPaths: ["dist"],
      boundaries: [],
      scopeFingerprints: [],
      freshness: "current",
      generatedAt: now,
    },
    conventions: [
      { id: "conv-abcdef123456", description: "Use pnpm workspace commands.", scope: ".", confidence: 0.8, sources: [], approval: "inferred", freshness: "current", firstObservedAt: now, lastConfirmedAt: now },
    ],
    commands: [{ id: "cmd-test", role: "test", command: "pnpm test", cwd: ".", sources: [], confidence: 0.9, lastVerifiedAt: null }],
    decisions: [],
    risks: [],
    relationships: [],
    missionLearnings: [],
    userRules: [
      { id: "rule-fedcba987654", text: "Never edit generated output.", scope: ".", active: true, createdAt: now },
    ],
    uncertainties: [],
    generatedAt: now,
    refreshedAt: now,
    schemaVersion: 1,
    ...overrides,
  };
}

function ctx(api: Record<string, unknown>, flags: Record<string, string | boolean> = {}) {
  return {
    flags: { project: "project-1", ...flags },
    out: new Output({ json: Boolean(flags.json), quiet: false, color: false }),
    config: { get: () => undefined },
    paths: {},
    api: () => api,
  } as any;
}

describe("morrow cortex command", () => {
  let printed: string[];
  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { printed.push(String(c)); return true; }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => { printed.push(String(c)); return true; }) as any);
  });
  afterEach(() => vi.restoreAllMocks());

  function api(overrides: Record<string, unknown> = {}) {
    const state = intelligence();
    return {
      listProjects: vi.fn(async () => [{ id: "project-1", name: "Morrow", workspacePath: process.cwd(), createdAt: now }]),
      getIntelligence: vi.fn(async () => state),
      intelligenceStaleness: vi.fn(async () => ({ changedScopes: [], itemsMarked: 0, architectureStale: false })),
      listConventions: vi.fn(async () => state.conventions),
      patchConvention: vi.fn(async (_projectId: string, conventionId: string, approval: "approved" | "rejected") => ({ ...state.conventions[0], id: conventionId, approval })),
      listRules: vi.fn(async () => state.userRules),
      addRule: vi.fn(async (_projectId: string, text: string) => ({ id: "rule-new", text, scope: ".", active: true, createdAt: now })),
      deleteRule: vi.fn(async () => ({ deleted: true })),
      ...overrides,
    };
  }

  it("renders status with stale-scope warnings from the backend", async () => {
    const fake = api({ intelligenceStaleness: vi.fn(async () => ({ changedScopes: ["workspaces"], itemsMarked: 2, architectureStale: true })) });
    await expect(cortexCommand(ctx(fake), "status", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("MORROW CORTEX");
    expect(out).toContain("Changed since refresh");
    expect(out).toContain("workspaces");
  });

  it("approves a convention using the shortened id displayed by the CLI", async () => {
    const fake = api();
    await expect(cortexCommand(ctx(fake), "conventions", ["approve", "abcdef12"])).resolves.toBe(0);
    expect(fake.patchConvention).toHaveBeenCalledWith("project-1", "conv-abcdef123456", "approved");
    expect(printed.join("")).toContain("Convention approved");
  });

  it("removes a rule using the shortened id displayed by the CLI", async () => {
    const fake = api();
    await expect(cortexCommand(ctx(fake), "rules", ["remove", "fedcba98"])).resolves.toBe(0);
    expect(fake.deleteRule).toHaveBeenCalledWith("project-1", "rule-fedcba987654");
    expect(printed.join("")).toContain("Rule removed");
  });
});

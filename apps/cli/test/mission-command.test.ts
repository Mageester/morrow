import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

import { Output } from "../src/cli/output.js";
import { missionCommand } from "../src/commands/mission.js";

function mission(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, id: "mission-abc12345", projectId: "p1", conversationId: null,
    objective: "Repair the Star Dodger game", status: "completed_with_reservations",
    autoApprove: true, taskTreeRootId: null,
    budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 1 },
    criteria: [
      { id: "c1", missionId: "mission-abc12345", order: 0, description: "JS syntax is valid", state: "verified", verification: { kind: "command", command: "node --check game.js" }, evidenceIds: ["e1"], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
      { id: "c2", missionId: "mission-abc12345", order: 1, description: "Firefox tested", state: "waived", verification: { kind: "manual" }, evidenceIds: [], failureReason: null, waiverReason: "no firefox", createdAt: "t", updatedAt: "t" },
    ],
    checkpoints: [], evidence: [
      { id: "e1", missionId: "mission-abc12345", criterionIds: ["c1"], type: "command", summary: "node --check game.js exited 0", command: "node --check game.js", exitCode: 0, outputRef: null, artifactPath: null, status: "passed", recordedAt: "2026-07-04T14:42:08.000Z" },
    ],
    failures: [], finalReview: { verdict: "approved_with_risks" },
    result: {
      status: "completed_with_reservations", objective: "Repair the Star Dodger game",
      criteriaVerified: 1, criteriaFailed: 0, criteriaUnverified: 0, criteriaWaived: 1, criteriaTotal: 2,
      reviewVerdict: "approved_with_risks", failuresTotal: 2, failuresRecovered: 2, humanInterventions: 0,
      tasksCompleted: 1, changedFiles: ["public/game.js"], unresolvedRisks: ["Cross-browser only Chromium"],
      artifacts: [], checkpointRefs: [], spentUsd: null, elapsedMs: 122000, summary: "Completed with reservations.",
    },
    createdAt: "t", updatedAt: "t", startedAt: "t", completedAt: "t",
    ...overrides,
  };
}

describe("morrow mission command", () => {
  let printed: string[];
  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { printed.push(String(c)); return true; }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => { printed.push(String(c)); return true; }) as any);
  });
  afterEach(() => vi.restoreAllMocks());

  function ctx(api: Record<string, unknown>, flags: Record<string, string | boolean> = {}) {
    return {
      flags: { project: "p1", ...flags },
      out: new Output({ json: false, quiet: false, color: false }),
      config: { get: () => undefined },
      paths: {},
      api: () => api,
    } as any;
  }

  it("lists missions with short ids and status", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api), "list", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("Repair the Star Dodger game");
    expect(out).toMatch(/completed with reservations/);
  });

  it("renders the mission result honestly with reservations and unresolved risks", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
      getMission: vi.fn(async () => mission()),
    };
    await expect(missionCommand(ctx(api), "result", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("MISSION RESULT");
    expect(out).toContain("1 verified");
    expect(out).toContain("1 waived");
    expect(out).toMatch(/approved with risks/);
    expect(out).toContain("Cross-browser only Chromium");
  });

  it("shows the evidence ledger with command and exit code, no raw ids", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api), "evidence", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("node --check game.js");
    expect(out).toContain("exit 0");
    // Internal record ids must not leak into the ledger view.
    expect(out).not.toContain("mission-abc12345");
    expect(out).not.toContain("e1");
  });

  it("shows a usage hint when no objective or subcommand is given", async () => {
    const api = { listProjects: vi.fn(async () => []) };
    await expect(missionCommand(ctx(api), undefined, [])).resolves.toBe(2);
    expect(printed.join("")).toMatch(/Usage: morrow mission/);
  });
});
